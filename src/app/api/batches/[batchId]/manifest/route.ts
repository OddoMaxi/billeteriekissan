import { batchWithPermission } from "@/lib/batch-access";
import { buildManifest } from "@/lib/manifest";
import { formatNumber } from "@/lib/numbering";

/** Manifeste du lot en JSON (organisateurs et auditeurs compris). */
export async function GET(_req: Request, ctx: RouteContext<"/api/batches/[batchId]/manifest">) {
  const found = await batchWithPermission((await ctx.params).batchId, "tickets.view");
  if (!found) return new Response("Introuvable", { status: 404 });
  const manifest = await buildManifest(found.batch.id);
  const b = found.batch;
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="manifeste-${formatNumber(b.firstNumber)}-${formatNumber(b.lastNumber)}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
