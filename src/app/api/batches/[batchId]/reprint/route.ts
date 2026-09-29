import { batchWithPermission } from "@/lib/batch-access";
import { BatchError, reprintBatch } from "@/lib/batches";
import { pdfResponse } from "@/lib/template-files";

/** Réimpression (formulaire POST) : motif obligatoire, lot complet ou plage de pages. */
export async function POST(req: Request, ctx: RouteContext<"/api/batches/[batchId]/reprint">) {
  // Protection CSRF en plus du cookie SameSite : la requête doit venir de l'application.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return new Response("Origine refusée", { status: 403 });

  const found = await batchWithPermission((await ctx.params).batchId, "templates.manage");
  if (!found) return new Response("Introuvable", { status: 404 });
  const form = await req.formData();
  const reason = String(form.get("reason") ?? "");
  const from = Number(form.get("fromPage") || 0);
  const to = Number(form.get("toPage") || 0);
  try {
    const { bytes, filename } = await reprintBatch(found.batch.id, found.user.id, reason, from && to ? [from, to] : undefined);
    return pdfResponse(bytes, filename, false);
  } catch (e) {
    if (e instanceof BatchError) return new Response(e.message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw e;
  }
}
