import "server-only";
import type { Batch, BatchLayout } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { audit } from "./audit";
import { decryptSecret, encryptSecret, newQrValue, sha256, sha256Buffer } from "./crypto";
import { db } from "./db";
import { fitDesign, formatNumber, pageCount, pageLayout, TICKETS_PER_PAGE, usableSlot } from "./numbering";
import { renderSheets, type TicketFace } from "./render";
import { deleteFile, loadFile, saveFile } from "./storage";
import { toRenderTemplate } from "./render-template";

// Génération des lots (sections 5.2 et 5.4).
//  1. createBatch : une transaction réserve la plage de numéros, contrôle le quota et crée
//     le lot et tous ses billets. Tout ou rien.
//  2. renderBatch : rend le PDF depuis la base, exécuté par le service de génération
//     (scripts/worker.ts), hors du serveur web pour ne jamais ralentir les scans.
//     Relançable après interruption : il reprend les mêmes billets et n'en crée jamais.
//     Le lot n'est prêt qu'après rapprochement.

export const MAX_BATCH_QUANTITY = 10_000;
const INSERT_CHUNK = 1_000;

export class BatchError extends Error {}

export type BatchRequest = {
  eventId: string;
  categoryId: string;
  templateId: string;
  printProfileId: string;
  quantity: number;
  layout: BatchLayout;
  actorId: string;
};

export async function createBatch(req: BatchRequest): Promise<Batch> {
  if (!Number.isInteger(req.quantity) || req.quantity < 1 || req.quantity > MAX_BATCH_QUANTITY) {
    throw new BatchError(`Quantité invalide (1 à ${MAX_BATCH_QUANTITY.toLocaleString("fr-FR")} billets par lot).`);
  }

  return db.$transaction(
    async (tx) => {
      const event = await tx.event.findUniqueOrThrow({ where: { id: req.eventId } });
      if (event.status === "CLOSED" || event.status === "ARCHIVED") {
        throw new BatchError("Événement terminé : aucune génération possible.");
      }
      // Réservation de la plage dans la séquence de la catégorie (001, 002…) : l'incrément verrouille
      // la ligne de la catégorie, ce qui sérialise les générations simultanées (aucun chevauchement).
      const owned = await tx.category.updateMany({
        where: { id: req.categoryId, eventId: req.eventId },
        data: { nextNumber: { increment: req.quantity } },
      });
      if (owned.count !== 1) throw new BatchError("Catégorie inconnue pour cet événement.");
      const category = await tx.category.findUniqueOrThrow({ where: { id: req.categoryId } });
      const firstNumber = category.nextNumber - req.quantity;
      const lastNumber = category.nextNumber - 1;
      const template = await tx.ticketTemplate.findFirst({ where: { id: req.templateId, eventId: req.eventId } });
      if (!template) throw new BatchError("Modèle inconnu pour cet événement.");
      if (!template.batApprovedAt) throw new BatchError("Le BAT de ce modèle n'est pas validé.");
      const profile = await tx.printProfile.findUnique({ where: { id: req.printProfileId } });
      if (!profile) throw new BatchError("Profil d'impression inconnu.");
      // Un design à un autre format (ex. l'ancien 210 × 74,25 mm) serait fortement réduit : refusé.
      const fit = fitDesign(template, usableSlot(profile, TICKETS_PER_PAGE));
      if (fit.scale < 0.85) {
        throw new BatchError(
          `Le design du modèle (${template.widthMm} × ${template.heightMm} mm) n'est pas au format ` +
            `5 tickets par A4 (210 × 59,4 mm) : il serait réduit à ${Math.round(fit.scale * 100)} %. Importez-le au bon format.`,
        );
      }

      // Le quota compte tous les billets émis, annulés compris : un numéro n'est jamais réattribué.
      const issued = await tx.ticket.count({ where: { categoryId: category.id } });
      if (issued + req.quantity > category.quota) {
        throw new BatchError(
          `Quota dépassé pour « ${category.name} » : ${issued} billets déjà générés, ` +
            `${category.quota - issued} disponibles sur ${category.quota}.`,
        );
      }

      const batch = await tx.batch.create({
        data: {
          eventId: req.eventId,
          categoryId: category.id,
          templateId: template.id,
          printProfileId: profile.id,
          quantity: req.quantity,
          firstNumber,
          lastNumber,
          layout: req.layout,
          ticketsPerPage: TICKETS_PER_PAGE,
          status: "PREPARING",
          createdById: req.actorId,
        },
      });

      for (let start = 0; start < req.quantity; start += INSERT_CHUNK) {
        const size = Math.min(INSERT_CHUNK, req.quantity - start);
        await tx.ticket.createMany({
          data: Array.from({ length: size }, (_, i) => {
            const qr = newQrValue();
            return {
              eventId: req.eventId,
              categoryId: category.id,
              batchId: batch.id,
              number: firstNumber + start + i,
              qrHash: sha256(qr),
              qrSecretEnc: encryptSecret(qr),
            };
          }),
        });
      }

      await audit(tx, {
        actorId: req.actorId,
        eventId: req.eventId,
        action: "batch.create",
        objectType: "Batch",
        objectId: batch.id,
        after: {
          category: category.name,
          template: `${template.name} v${template.version}`,
          quantity: req.quantity,
          range: `${formatNumber(firstNumber)}–${formatNumber(lastNumber)}`,
          layout: req.layout,
          printProfile: profile.name,
        },
      });
      return batch;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/**
 * Rend le PDF complet du lot à partir des billets en base.
 * Contrôles : billets = quantité, numéros continus, empreinte de chaque QR vérifiée.
 */
export async function renderBatchPdf(
  batchId: string,
  opts: { onPage?: (done: number) => void; pages?: [number, number] } = {},
): Promise<{ bytes: Uint8Array; pages: number; faces: number }> {
  const batch = await db.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { event: true, category: true, template: true, printProfile: true },
  });
  const tickets = await db.ticket.findMany({
    where: { batchId },
    orderBy: { number: "asc" },
    select: { number: true, qrHash: true, qrSecretEnc: true },
  });
  if (tickets.length !== batch.quantity) {
    throw new Error(`Rapprochement impossible : ${tickets.length} billets en base pour ${batch.quantity} attendus.`);
  }
  const faces = new Map<number, TicketFace>();
  for (const [i, t] of tickets.entries()) {
    if (t.number !== batch.firstNumber + i) throw new Error(`Numérotation discontinue à ${formatNumber(t.number)}.`);
    const qrValue = decryptSecret(t.qrSecretEnc);
    if (sha256(qrValue) !== t.qrHash) throw new Error(`Empreinte QR incohérente pour le billet ${formatNumber(t.number)}.`);
    faces.set(t.number, { number: formatNumber(t.number), qrValue });
  }

  let layout = pageLayout(batch.firstNumber, batch.quantity, batch.layout, batch.ticketsPerPage);
  if (opts.pages) layout = layout.slice(opts.pages[0] - 1, opts.pages[1]);
  const pages = layout.map((row) => row.map((n) => (n === null ? null : faces.get(n)!)));
  const faceCount = pages.flat().filter(Boolean).length;

  const bytes = await renderSheets({
    template: await toRenderTemplate(batch.template),
    profile: batch.printProfile,
    pages,
    perPage: batch.ticketsPerPage,
    title: `${batch.event.name} — ${batch.category.name} — ${formatNumber(batch.firstNumber)} à ${formatNumber(batch.lastNumber)}`,
    onPage: opts.onPage,
  });
  return { bytes, pages: pages.length, faces: faceCount };
}

function pdfPathFor(b: Pick<Batch, "id" | "firstNumber" | "lastNumber">) {
  return `batches/${b.id}/lot-${formatNumber(b.firstNumber)}-${formatNumber(b.lastNumber)}.pdf`;
}

/**
 * Phase 2 : rendu, écriture atomique, rapprochement puis passage à « prêt ».
 * `failAfterPages` simule une interruption (tests de reprise, R14).
 */
export async function renderBatch(batchId: string, opts: { failAfterPages?: number } = {}): Promise<Batch> {
  // Prise en charge conditionnelle : un lot n'est rendu que par un seul exécutant.
  const claimed = await db.batch.updateMany({
    where: { id: batchId, status: "PREPARING" },
    data: { status: "GENERATING", error: null, progressPages: 0, generationStartedAt: new Date() },
  });
  if (claimed.count === 0) throw new BatchError("Ce lot n'est pas en attente de génération.");

  try {
    let lastSaved = 0;
    const { bytes, pages, faces } = await renderBatchPdf(batchId, {
      onPage: (done) => {
        if (opts.failAfterPages && done >= opts.failAfterPages) throw new Error("Interruption simulée");
        if (done - lastSaved >= 25) {
          lastSaved = done;
          void db.batch.update({ where: { id: batchId }, data: { progressPages: done } }).catch(() => {});
        }
      },
    });
    const batch = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
    const registered = await db.ticket.count({ where: { batchId } });
    if (faces !== batch.quantity || registered !== batch.quantity || pages !== pageCount(batch.quantity, batch.ticketsPerPage)) {
      throw new Error(`Rapprochement échoué : ${registered} billets en base, ${faces} tickets rendus, ${pages} pages.`);
    }
    const path = pdfPathFor(batch);
    await saveFile(path, bytes);
    const pdfSha256 = sha256Buffer(bytes);
    return await db.$transaction(async (tx) => {
      const ready = await tx.batch.update({
        where: { id: batchId },
        data: { status: "READY", pdfPath: path, pdfSha256, pageCount: pages, progressPages: pages, readyAt: new Date(), pdfDestroyedAt: null },
      });
      await audit(tx, {
        actorId: null,
        eventId: batch.eventId,
        action: "batch.ready",
        objectType: "Batch",
        objectId: batchId,
        after: { pages, tickets: faces, pdfSha256, bytes: bytes.length },
      });
      return ready;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await db.batch.update({ where: { id: batchId }, data: { status: "FAILED", error: message.slice(0, 500) } });
    await audit(db, { actorId: null, eventId: failed.eventId, action: "batch.failed", objectType: "Batch", objectId: batchId, context: { error: message } });
    throw err;
  }
}

// ─── File d'attente du service de génération ───────────────────────────────

export const WORKER_NAME = "batch-worker";
/** Au-delà, le service est considéré comme arrêté. */
export const WORKER_TIMEOUT_MS = 20_000;

/** Remet en file un lot échoué, ou interrompu par l'arrêt du service. Mêmes billets. */
export async function requeueBatch(batchId: string): Promise<boolean> {
  const r = await db.batch.updateMany({
    where: { id: batchId, status: { in: ["FAILED", "GENERATING"] } },
    data: { status: "PREPARING", progressPages: 0 },
  });
  return r.count > 0;
}

/** Plus ancien lot en attente, ou null. */
export async function nextQueuedBatch(): Promise<string | null> {
  const b = await db.batch.findFirst({ where: { status: "PREPARING" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return b?.id ?? null;
}

export async function workerAlive(): Promise<boolean> {
  const hb = await db.serviceHeartbeat.findUnique({ where: { name: WORKER_NAME } });
  return !!hb && Date.now() - hb.beatAt.getTime() < WORKER_TIMEOUT_MS;
}

// ─── Téléchargement, réimpression, destruction ──────────────────────────────

export async function loadBatchPdf(batch: Batch): Promise<Uint8Array> {
  if (batch.status !== "READY" || !batch.pdfPath) throw new BatchError("Le PDF de ce lot n'est pas disponible.");
  return loadFile(batch.pdfPath);
}

/**
 * Réimpression : régénère depuis la base les mêmes billets (mêmes numéros, mêmes QR).
 * Lot complet : le fichier doit être identique octet pour octet au PDF d'origine (empreinte du manifeste).
 * Une réimpression ne crée aucun billet ni droit d'entrée supplémentaire.
 */
export async function reprintBatch(
  batchId: string,
  actorId: string,
  reason: string,
  pages?: [number, number],
): Promise<{ bytes: Uint8Array; filename: string }> {
  const batch = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status !== "READY") throw new BatchError("Seul un lot prêt peut être réimprimé.");
  if (reason.trim().length < 5) throw new BatchError("Indiquez le motif de la réimpression.");
  const total = batch.pageCount ?? pageCount(batch.quantity, batch.ticketsPerPage);
  if (pages && (pages[0] < 1 || pages[1] > total || pages[0] > pages[1])) {
    throw new BatchError(`Pages invalides (1 à ${total}).`);
  }
  const full = !pages || (pages[0] === 1 && pages[1] === total);
  const { bytes } = await renderBatchPdf(batchId, { pages: full ? undefined : pages });
  if (full && sha256Buffer(bytes) !== batch.pdfSha256) {
    throw new Error("La réimpression ne correspond pas au PDF d'origine : opération bloquée.");
  }
  await audit(db, {
    actorId,
    eventId: batch.eventId,
    action: "batch.reprint",
    objectType: "Batch",
    objectId: batchId,
    context: { reason: reason.trim(), pages: full ? "toutes" : `${pages![0]}–${pages![1]}`, identicalToOriginal: full },
  });
  const suffix = full ? "" : `-p${pages![0]}-${pages![1]}`;
  return { bytes, filename: `reimpression-${formatNumber(batch.firstNumber)}-${formatNumber(batch.lastNumber)}${suffix}.pdf` };
}

/** Supprime le PDF de production du stockage (fin d'impression). Les billets ne changent pas. */
export async function destroyBatchPdf(batchId: string, actorId: string, reason: string): Promise<void> {
  const batch = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
  if (!batch.pdfPath) throw new BatchError("Aucun PDF stocké pour ce lot.");
  await deleteFile(batch.pdfPath);
  await db.$transaction(async (tx) => {
    await tx.batch.update({ where: { id: batchId }, data: { pdfPath: null, pdfDestroyedAt: new Date() } });
    await audit(tx, { actorId, eventId: batch.eventId, action: "batch.pdf_destroy", objectType: "Batch", objectId: batchId, context: { reason } });
  });
}

/** Vérifie le nombre de pages d'un PDF produit (tests et contrôles ponctuels). */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}
