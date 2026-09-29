"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { requireEventPermission } from "@/lib/authz";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatNumber } from "@/lib/numbering";
import {
  assignTickets,
  confirmMovement,
  declareIncident,
  quoteSale,
  recordPayment,
  recordSale,
  recordStockCount,
  refuseMovement,
  replaceTicket,
  resolvePayment,
  returnTickets,
  reverseSale,
  setActivation,
  StockError,
  type SaleQuote,
} from "@/lib/stock";
import { parseNumbers } from "@/lib/ticket-numbers";

const uuid = z.string().uuid();
const method = z.enum(["CASH", "TRANSFER", "OTHER"]);
const text = (max = 500) => z.string().trim().max(max).optional().default("");
const gnf = (label: string) => z.coerce.number({ message: `${label} invalide.` }).int(`${label} : nombre entier de GNF.`).min(0, `${label} invalide.`);

/** Droits de l'utilisateur sur l'événement (404 si aucun) ; l'opération revérifie le rôle précis. */
async function actorFor(eventId: string) {
  return (await requireEventPermission(eventId, "event.view")).actor;
}

/** Catégorie des billets saisis : chaque catégorie a sa propre numérotation (001, 002…). */
function categoryFrom(raw: unknown): string {
  const r = uuid.safeParse(raw);
  if (!r.success) throw new UserError("Choisissez la catégorie des billets.");
  return r.data;
}

function numbersFrom(raw: unknown): number[] {
  const { numbers, errors } = parseNumbers(String(raw ?? ""));
  if (errors.length) throw new UserError(errors.join(" "));
  return numbers;
}

/** Les erreurs métier deviennent des messages ; les autres restent des erreurs. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StockError) throw new UserError(e.message);
    throw e;
  }
}

function refresh(eventId: string) {
  revalidatePath(`/events/${eventId}`, "layout");
}

// ─── Stock ───────────────────────────────────────────────────────────────────

export const assignAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const d = z.object({ from: z.string(), to: uuid, reason: text() }).parse(raw);
  const numbers = numbersFrom(raw.numbers);
  const fromHolderId = d.from === "central" ? null : uuid.parse(d.from);
  const categoryId = categoryFrom(raw.categoryId);
  const m = await run(() => assignTickets({ eventId, actor, fromHolderId, toUserId: d.to, categoryId, numbers, reason: d.reason }));
  refresh(eventId);
  return m.status === "PENDING"
    ? `${numbers.length} billet(s) remis, en attente de l'accusé de réception du destinataire.`
    : `${numbers.length} billet(s) remis.`;
});

export const returnAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const from = uuid.parse(raw.from);
  const numbers = numbersFrom(raw.numbers);
  const categoryId = categoryFrom(raw.categoryId);
  const m = await run(() => returnTickets({ eventId, actor, fromHolderId: from, categoryId, numbers, reason: z.string().trim().max(500).parse(raw.reason ?? "") }));
  refresh(eventId);
  return m.status === "PENDING"
    ? `${numbers.length} billet(s) restitué(s), en attente de confirmation par l'organisation.`
    : `${numbers.length} billet(s) revenu(s) au stock central.`;
});

export async function confirmMovementAction(eventId: string, movementId: string) {
  const actor = await actorFor(eventId);
  await run(() => confirmMovement({ movementId, actor }));
  refresh(eventId);
}

export const refuseMovementAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  await run(() => refuseMovement({ movementId: uuid.parse(raw.movementId), actor, incident: String(raw.incident ?? "") }));
  refresh(eventId);
  return "Remise refusée : les billets reviennent à l'émetteur.";
});

export const incidentAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const kind = z.enum(["LOSS", "DAMAGE", "CANCEL"]).parse(raw.kind);
  const numbers = numbersFrom(raw.numbers);
  await run(() => declareIncident({ eventId, actor, kind, categoryId: categoryFrom(raw.categoryId), numbers, reason: String(raw.reason ?? "") }));
  refresh(eventId);
  return `${numbers.length} billet(s) bloqué(s) définitivement.`;
});

export const activationAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const active = raw.mode !== "deactivate";
  const numbers = numbersFrom(raw.numbers);
  const r = await run(() =>
    setActivation({ eventId, actor, categoryId: categoryFrom(raw.categoryId), numbers, active, reason: String(raw.reason ?? ""), onlyEligible: raw.scope === "batch" }),
  );
  refresh(eventId);
  return `${r.changed} billet(s) ${active ? "activé(s)" : "désactivé(s)"}${r.skipped ? ` ; ${r.skipped} ignoré(s) (déjà activés ou bloqués)` : ""}.`;
});

export const replaceAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const d = z
    .object({
      oldNumber: z.coerce.number().int().min(1, "Numéro du billet à remplacer requis."),
      newNumber: z.coerce.number().int().min(1, "Numéro du billet de remplacement requis."),
      oldState: z.enum(["LOST", "DESTROYED"]),
      reason: z.string(),
    })
    .parse(raw);
  await run(() => replaceTicket({ eventId, actor, categoryId: categoryFrom(raw.categoryId), ...d }));
  refresh(eventId);
  return `Billet ${formatNumber(d.oldNumber)} remplacé par ${formatNumber(d.newNumber)}.`;
});

export const stockCountAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const holderId = raw.holder === "central" ? null : uuid.parse(raw.holder);
  const counted = z.coerce.number().int().min(0, "Nombre compté invalide.").parse(raw.counted);
  const c = await run(() => recordStockCount({ eventId, actor, holderId, counted, note: String(raw.note ?? "") }));
  refresh(eventId);
  const gap = c.counted - c.expected;
  return gap === 0 ? `Comptage conforme : ${c.counted} billets.` : `Écart enregistré : ${gap > 0 ? "+" : ""}${gap} (compté ${c.counted}, attendu ${c.expected}).`;
});

// ─── Ventes ──────────────────────────────────────────────────────────────────

export type QuoteState = { error?: string; quote?: SaleQuote & { numbers: string; sellerId: string; categoryId: string } } | null;

/** Étape 1 d'une vente : contrôle et chiffrage des billets saisis, sans rien enregistrer. */
export async function quoteSaleAction(_prev: QuoteState, form: FormData): Promise<QuoteState> {
  try {
    const raw = formToObject(form);
    const eventId = uuid.parse(raw.eventId);
    const actor = await actorFor(eventId);
    const sellerId = uuid.parse(raw.sellerId);
    const numbers = numbersFrom(raw.numbers);
    const categoryId = categoryFrom(raw.categoryId);
    const quote = await run(() => quoteSale({ eventId, actor, sellerId, categoryId, numbers }));
    return { quote: { ...quote, numbers: String(raw.numbers), sellerId, categoryId } };
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    if (e instanceof z.ZodError) return { error: e.issues.map((i) => i.message).join(" ") };
    throw e;
  }
}

/** Étape 2 : enregistrement de la vente déclarée. */
export const recordSaleAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const d = z
    .object({ sellerId: uuid, discountGnf: gnf("Remise"), paymentMethod: method, paymentRef: text(100), reason: text() })
    .parse({ ...raw, discountGnf: raw.discountGnf || 0 });
  const numbers = numbersFrom(raw.numbers);
  const sale = await run(() => recordSale({ eventId, actor, categoryId: categoryFrom(raw.categoryId), numbers, ...d }));
  refresh(eventId);
  return `Vente enregistrée : ${numbers.length} billet(s), ${sale.totalGnf.toLocaleString("fr-FR")} GNF.`;
});

/** Lecture d'un QR au flasheur pendant une vente : renvoie le numéro et la catégorie du billet, sans rien modifier. */
export async function qrToNumberAction(eventId: string, value: string): Promise<{ number?: string; categoryId?: string; categoryName?: string; error?: string }> {
  await actorFor(eventId);
  const t = await db.ticket.findFirst({ where: { eventId, qrHash: sha256(value.trim()) }, select: { number: true, category: { select: { id: true, name: true } } } });
  return t ? { number: formatNumber(t.number), categoryId: t.category.id, categoryName: t.category.name } : { error: "QR inconnu pour cet événement." };
}

export const reverseSaleAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const type = z.enum(["ENTRY_ERROR", "CANCELLATION"]).parse(raw.type);
  const numbers = String(raw.numbers ?? "").trim() ? numbersFrom(raw.numbers) : undefined;
  const refundGnf = type === "CANCELLATION" ? gnf("Remboursement").parse(raw.refundGnf || 0) : undefined;
  const r = await run(() => reverseSale({ saleId: uuid.parse(raw.saleId), actor, numbers, type, refundGnf, reason: String(raw.reason ?? "") }));
  refresh(eventId);
  return `Contre-écriture enregistrée (${r.totalGnf.toLocaleString("fr-FR")} GNF).`;
});

// ─── Versements ──────────────────────────────────────────────────────────────

export const paymentAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const d = z
    .object({ sellerId: uuid, amountGnf: gnf("Montant"), method, reference: text(100), note: text() })
    .parse(raw);
  const p = await run(() => recordPayment({ eventId, actor, ...d }));
  refresh(eventId);
  return p.validatedAt ? "Versement enregistré et validé." : "Versement déclaré, en attente de validation.";
});

export const resolvePaymentAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const actor = await actorFor(eventId);
  const accept = raw.decision === "accept";
  await run(() => resolvePayment({ paymentId: uuid.parse(raw.paymentId), actor, accept, reason: String(raw.reason ?? "") }));
  refresh(eventId);
  return accept ? "Versement validé." : "Versement rejeté.";
});

