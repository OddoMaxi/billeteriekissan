import { newQrValue } from "@/lib/crypto";
import { renderTicketPreview } from "@/lib/render";
import { adminTemplate, pdfResponse, toRenderTemplate } from "@/lib/template-files";
import { layoutSchema } from "@/lib/template-layout";

/**
 * Aperçu d'un ticket (numéro 001, QR spécimen). `guides=1` affiche zones et marges ;
 * `layout=<json>` prévisualise une disposition non encore enregistrée.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/templates/[templateId]/preview">) {
  const found = await adminTemplate((await ctx.params).templateId);
  if (!found) return new Response("Introuvable", { status: 404 });
  const url = new URL(req.url);
  let layout;
  const rawLayout = url.searchParams.get("layout");
  if (rawLayout) {
    const parsed = layoutSchema.safeParse(JSON.parse(rawLayout));
    if (!parsed.success) return new Response("Disposition invalide", { status: 400 });
    layout = parsed.data;
  }
  const t = await toRenderTemplate(found.template, layout);
  const pdf = await renderTicketPreview(t, { number: "001", qrValue: newQrValue() }, url.searchParams.get("guides") === "1");
  return pdfResponse(pdf, `apercu-${found.template.name}-v${found.template.version}.pdf`);
}
