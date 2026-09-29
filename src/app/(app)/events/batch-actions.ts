"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { BatchError, createBatch, destroyBatchPdf, requeueBatch } from "@/lib/batches";
import { db } from "@/lib/db";

const uuid = z.string().uuid();

const batchSchema = z.object({
  eventId: uuid,
  categoryId: uuid,
  templateId: uuid,
  printProfileId: uuid,
  quantity: z.coerce.number().int("Quantité entière.").min(1, "Quantité invalide."),
  layout: z.enum(["SEQUENTIAL", "STACKS"]),
  confirm: z.literal("on", { message: "Confirmez avoir vérifié l'aperçu." }),
});

/** Génération d'un lot : réservation et création des billets ; le PDF est rendu par le service de génération. */
export const createBatchAction = formAction(async (form) => {
  const admin = await requireAdmin();
  const d = batchSchema.parse(formToObject(form));
  let batchId: string;
  try {
    const batch = await createBatch({ ...d, actorId: admin.id });
    batchId = batch.id;
  } catch (e) {
    if (e instanceof BatchError) throw new UserError(e.message);
    throw e;
  }
  redirect(`/events/${d.eventId}/batches/${batchId}`);
});

/** Relance d'une génération échouée : le lot repart en file avec les mêmes billets. */
export async function retryBatch(eventId: string, batchId: string) {
  const admin = await requireAdmin();
  const batch = await db.batch.findFirstOrThrow({ where: { id: batchId, eventId } });
  if (batch.status !== "FAILED") return;
  if (await requeueBatch(batchId)) {
    await audit(db, { actorId: admin.id, eventId, action: "batch.retry", objectType: "Batch", objectId: batchId, before: { status: batch.status, error: batch.error } });
  }
  revalidatePath(`/events/${eventId}/batches/${batchId}`);
}

export const destroyPdfAction = formAction(async (form) => {
  const admin = await requireAdmin();
  const raw = formToObject(form);
  const batchId = uuid.parse(raw.batchId);
  const reason = z.string().trim().min(5, "Indiquez le motif.").max(500).parse(raw.reason);
  if (raw.confirm !== "on") throw new UserError("Cochez la confirmation.");
  try {
    await destroyBatchPdf(batchId, admin.id, reason);
  } catch (e) {
    if (e instanceof BatchError) throw new UserError(e.message);
    throw e;
  }
  const b = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
  revalidatePath(`/events/${b.eventId}/batches/${batchId}`);
  return "PDF supprimé du stockage. Les billets restent valables ; une réimpression le régénère à l'identique.";
});
