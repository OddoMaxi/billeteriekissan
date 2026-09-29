import { adminTemplate } from "@/lib/template-files";
import { loadFile } from "@/lib/storage";

/** Fichier de design d'origine (sert de fond à l'éditeur de disposition). */
export async function GET(_req: Request, ctx: RouteContext<"/api/templates/[templateId]/background">) {
  const found = await adminTemplate((await ctx.params).templateId);
  if (!found) return new Response("Introuvable", { status: 404 });
  const bytes = await loadFile(found.template.backgroundPath);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": found.template.backgroundMime,
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
