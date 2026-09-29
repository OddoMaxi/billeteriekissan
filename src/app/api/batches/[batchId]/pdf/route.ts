import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { batchWithPermission } from "@/lib/batch-access";
import { loadBatchPdf } from "@/lib/batches";
import { formatNumber } from "@/lib/numbering";
import { pdfResponse } from "@/lib/template-files";

/** Téléchargement du PDF de production : lot prêt uniquement, journalisé. */
export async function GET(_req: Request, ctx: RouteContext<"/api/batches/[batchId]/pdf">) {
  const found = await batchWithPermission((await ctx.params).batchId, "templates.manage");
  if (!found) return new Response("Introuvable", { status: 404 });
  const { batch, user } = found;
  if (batch.status !== "READY" || !batch.pdfPath) return new Response("PDF non disponible", { status: 409 });
  const pdf = await loadBatchPdf(batch);
  await audit(db, {
    actorId: user.id,
    eventId: batch.eventId,
    action: "batch.download",
    objectType: "Batch",
    objectId: batch.id,
    context: { pdfSha256: batch.pdfSha256 },
  });
  const category = await db.category.findUniqueOrThrow({ where: { id: batch.categoryId } });
  const slug = category.name.normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
  return pdfResponse(pdf, `billets-${slug}-${formatNumber(batch.firstNumber)}-${formatNumber(batch.lastNumber)}.pdf`, false);
}
