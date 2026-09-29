"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { sha256Buffer } from "@/lib/crypto";
import { db } from "@/lib/db";
import { inspectDesign, MAX_DESIGN_BYTES } from "@/lib/design-file";
import { usableSlot } from "@/lib/numbering";
import { saveFile } from "@/lib/storage";
import { checkLayout, DEFAULT_LAYOUT, layoutSchema, NOMINAL, type TemplateLayout } from "@/lib/template-layout";

const uuid = z.string().uuid();
const EXT = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" } as const;

async function readDesign(form: FormData, dims: { widthMm: number; heightMm: number }) {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new UserError("Choisissez un fichier de design.");
  if (file.size > MAX_DESIGN_BYTES) throw new UserError("Fichier trop volumineux (15 Mo maximum).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = await inspectDesign(bytes, dims);
  if (inspection.errors.length) throw new UserError(inspection.errors.join(" "));
  return { bytes, inspection, sha256: sha256Buffer(bytes) };
}

function parseDims(raw: Record<string, string | string[]>) {
  if (raw.format !== "custom") return NOMINAL;
  const d = z
    .object({
      widthMm: z.coerce.number().min(50, "Largeur invalide.").max(210, "210 mm maximum (largeur A4)."),
      heightMm: z.coerce.number().min(20, "Hauteur invalide.").max(59.4, "59,4 mm maximum (cinquième de A4)."),
    })
    .parse(raw);
  return d;
}

/**
 * Adapte la disposition proposée à un design de dimensions différentes
 * (variante aux dimensions utiles) par mise à l'échelle proportionnelle.
 */
function scaledDefaultLayout(dims: { widthMm: number; heightMm: number }): TemplateLayout {
  const k = Math.min(dims.widthMm / NOMINAL.widthMm, dims.heightMm / NOMINAL.heightMm);
  if (k === 1) return DEFAULT_LAYOUT;
  const r = (n: number) => Math.round(n * k * 10) / 10;
  const L = DEFAULT_LAYOUT;
  return {
    stubLineX: r(L.stubLineX!),
    bodyQr: { x: r(L.bodyQr.x), y: r(L.bodyQr.y), size: r(L.bodyQr.size) },
    bodyNumber: { ...L.bodyNumber, x: r(L.bodyNumber.x), y: r(L.bodyNumber.y), width: r(L.bodyNumber.width), height: r(L.bodyNumber.height) },
    stubQr: { x: r(L.stubQr!.x), y: r(L.stubQr!.y), size: r(L.stubQr!.size) },
    stubNumber: { ...L.stubNumber!, x: r(L.stubNumber!.x), y: r(L.stubNumber!.y), width: r(L.stubNumber!.width), height: r(L.stubNumber!.height) },
  };
}

/** Import d'un nouveau modèle : version 1, disposition proposée par défaut. */
export const createTemplate = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const eventId = uuid.parse(raw.eventId);
  const name = z.string().trim().min(1, "Nom requis.").max(100).parse(raw.name);
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  if (event.status === "CLOSED" || event.status === "ARCHIVED") throw new UserError("Événement terminé.");
  if (await db.ticketTemplate.findFirst({ where: { eventId, name } })) {
    throw new UserError("Un modèle porte déjà ce nom : importez plutôt une nouvelle version depuis sa page.");
  }
  const dims = parseDims(raw);
  const { bytes, inspection, sha256 } = await readDesign(form, dims);

  const id = crypto.randomUUID();
  const backgroundPath = `templates/${id}/design-${sha256.slice(0, 12)}.${EXT[inspection.mime]}`;
  await saveFile(backgroundPath, bytes);
  await db.$transaction(async (tx) => {
    const t = await tx.ticketTemplate.create({
      data: {
        id,
        eventId,
        name,
        version: 1,
        backgroundPath,
        backgroundMime: inspection.mime,
        backgroundSha256: sha256,
        designWarnings: inspection.warnings,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        layout: scaledDefaultLayout(dims),
        createdById: admin.id,
      },
    });
    await audit(tx, {
      actorId: admin.id,
      eventId,
      action: "template.create",
      objectType: "TicketTemplate",
      objectId: t.id,
      after: { name, version: 1, sha256, mime: inspection.mime, widthMm: dims.widthMm, heightMm: dims.heightMm },
    });
  });
  redirect(`/events/${eventId}/templates/${id}`);
});

/**
 * Enregistre la disposition. Un modèle dont le BAT est validé est figé :
 * toute modification crée une nouvelle version (brouillon) du modèle.
 */
export const saveLayout = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const templateId = uuid.parse(raw.templateId);
  let layout: TemplateLayout;
  try {
    layout = layoutSchema.parse(JSON.parse(String(raw.layout)));
  } catch {
    throw new UserError("Disposition invalide.");
  }
  const current = await db.ticketTemplate.findUniqueOrThrow({ where: { id: templateId } });
  const check = checkLayout(layout, current);
  if (check.errors.length) throw new UserError(check.errors.join(" "));

  if (!current.batApprovedAt) {
    await db.$transaction(async (tx) => {
      await tx.ticketTemplate.update({ where: { id: templateId }, data: { layout } });
      await audit(tx, {
        actorId: admin.id,
        eventId: current.eventId,
        action: "template.layout",
        objectType: "TicketTemplate",
        objectId: templateId,
        before: current.layout,
        after: layout,
      });
    });
    revalidatePath(`/events/${current.eventId}/templates/${templateId}`);
    return "Disposition enregistrée.";
  }

  const next = await createVersion(admin.id, current, { layout });
  redirect(`/events/${current.eventId}/templates/${next.id}?created=1`);
});

/** Remplace le design : crée toujours une nouvelle version, la disposition est reprise. */
export const uploadNewVersion = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const templateId = uuid.parse(raw.templateId);
  const current = await db.ticketTemplate.findUniqueOrThrow({ where: { id: templateId } });
  const { bytes, inspection, sha256 } = await readDesign(form, current);
  const check = checkLayout(current.layout as TemplateLayout, current);
  const id = crypto.randomUUID();
  const backgroundPath = `templates/${id}/design-${sha256.slice(0, 12)}.${EXT[inspection.mime]}`;
  await saveFile(backgroundPath, bytes);
  const next = await createVersion(admin.id, current, {
    id,
    backgroundPath,
    backgroundMime: inspection.mime,
    backgroundSha256: sha256,
    designWarnings: [...inspection.warnings, ...check.warnings],
  });
  redirect(`/events/${current.eventId}/templates/${next.id}?created=1`);
});

type TemplateRow = Awaited<ReturnType<typeof db.ticketTemplate.findUniqueOrThrow>>;

async function createVersion(
  actorId: string,
  from: TemplateRow,
  changes: Partial<Pick<TemplateRow, "id" | "backgroundPath" | "backgroundMime" | "backgroundSha256" | "designWarnings">> & {
    layout?: TemplateLayout;
  },
) {
  return db.$transaction(async (tx) => {
    const last = await tx.ticketTemplate.aggregate({
      where: { eventId: from.eventId, name: from.name },
      _max: { version: true },
    });
    const version = (last._max.version ?? 0) + 1;
    const t = await tx.ticketTemplate.create({
      data: {
        id: changes.id,
        eventId: from.eventId,
        name: from.name,
        version,
        backgroundPath: changes.backgroundPath ?? from.backgroundPath,
        backgroundMime: changes.backgroundMime ?? from.backgroundMime,
        backgroundSha256: changes.backgroundSha256 ?? from.backgroundSha256,
        designWarnings: changes.designWarnings ?? from.designWarnings,
        widthMm: from.widthMm,
        heightMm: from.heightMm,
        layout: changes.layout ?? (from.layout as TemplateLayout),
        createdById: actorId,
      },
    });
    await audit(tx, {
      actorId,
      eventId: from.eventId,
      action: "template.version",
      objectType: "TicketTemplate",
      objectId: t.id,
      before: { id: from.id, version: from.version },
      after: { version, layout: t.layout, sha256: t.backgroundSha256 },
    });
    return t;
  });
}

/**
 * Validation du BAT (section 5.1) : l'administrateur atteste l'impression à 100 %
 * et la lecture des QR avec le flasheur retenu. Le modèle devient utilisable en production.
 */
export const approveBat = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const templateId = uuid.parse(raw.templateId);
  const profileId = uuid.parse(raw.printProfileId);
  if (raw.printed !== "on" || raw.scanned !== "on" || raw.cut !== "on") {
    throw new UserError("Cochez les trois vérifications avant de valider le BAT.");
  }
  const notes = z.string().trim().max(1000).parse(raw.notes ?? "");
  const t = await db.ticketTemplate.findUniqueOrThrow({ where: { id: templateId } });
  if (t.batApprovedAt) throw new UserError("BAT déjà validé.");
  const check = checkLayout(t.layout as TemplateLayout, t);
  if (check.errors.length) throw new UserError("Disposition invalide : corrigez-la avant de valider le BAT.");
  const profile = await db.printProfile.findUniqueOrThrow({ where: { id: profileId } });

  await db.$transaction(async (tx) => {
    await tx.ticketTemplate.update({ where: { id: templateId }, data: { batApprovedAt: new Date(), batApprovedById: admin.id } });
    await audit(tx, {
      actorId: admin.id,
      eventId: t.eventId,
      action: "template.bat_approve",
      objectType: "TicketTemplate",
      objectId: templateId,
      after: { version: t.version, sha256: t.backgroundSha256, layout: t.layout },
      context: { printProfile: profile.name, printProfileId: profile.id, notes },
    });
  });
  revalidatePath(`/events/${t.eventId}/templates`, "layout");
  return "BAT validé : le modèle est utilisable pour la production.";
});

// ─── Profils d'impression ────────────────────────────────────────────────────

const profileSchema = z.object({
  name: z.string().trim().min(2, "Nom requis.").max(100),
  marginTopMm: z.coerce.number().min(0).max(30),
  marginBottomMm: z.coerce.number().min(0).max(30),
  marginLeftMm: z.coerce.number().min(0).max(30),
  marginRightMm: z.coerce.number().min(0).max(30),
  gapMm: z.coerce.number().min(0).max(10),
  cropMarks: z.literal("on").optional(),
});

/**
 * Crée un profil d'impression. Un profil n'est jamais modifié après coup
 * (les BAT et lots qui s'y réfèrent doivent rester reproductibles) : on en crée un nouveau.
 */
export const createPrintProfile = formAction(async (form) => {
  const admin = await requireAdmin();
  const d = profileSchema.parse(formToObject(form));
  const slot = usableSlot(d);
  if (slot.heightMm < 45 || slot.widthMm < 180) {
    throw new UserError("Marges trop grandes : chaque emplacement ferait moins de 180 × 45 mm.");
  }
  await db.$transaction(async (tx) => {
    const p = await tx.printProfile.create({ data: { ...d, cropMarks: d.cropMarks === "on" } });
    await audit(tx, { actorId: admin.id, action: "print_profile.create", objectType: "PrintProfile", objectId: p.id, after: p });
  }).catch((e) => {
    if (e?.code === "P2002") throw new UserError("Un profil porte déjà ce nom.");
    throw e;
  });
  revalidatePath("/admin/print-profiles");
  return "Profil créé.";
});
