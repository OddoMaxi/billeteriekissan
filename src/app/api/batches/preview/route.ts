import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { newQrValue } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formatNumber, pageCount, pageLayout } from "@/lib/numbering";
import { renderSheets } from "@/lib/render";
import { pdfResponse, toRenderTemplate } from "@/lib/template-files";

const schema = z.object({
  categoryId: z.string().uuid(),
  templateId: z.string().uuid(),
  printProfileId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(10_000),
  layout: z.enum(["SEQUENTIAL", "STACKS"]),
});

/**
 * Aperçu avant génération : première planche complète et dernière page du lot,
 * avec les numéros prévus (indicatifs) et des QR spécimens. Aucun billet n'est créé.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return new Response("Introuvable", { status: 404 });
  const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return new Response("Paramètres invalides", { status: 400 });
  const q = parsed.data;
  const [template, profile] = await Promise.all([
    db.ticketTemplate.findUnique({ where: { id: q.templateId } }),
    db.printProfile.findUnique({ where: { id: q.printProfileId } }),
  ]);
  const category = template ? await db.category.findFirst({ where: { id: q.categoryId, eventId: template.eventId } }) : null;
  if (!template || !profile || !category) return new Response("Introuvable", { status: 404 });

  // Numéros prévus dans la séquence propre à la catégorie.
  const first = category.nextNumber;
  const layout = pageLayout(first, q.quantity, q.layout);
  const pages = pageCount(q.quantity);
  const selected = pages > 1 ? [layout[0], layout[pages - 1]] : [layout[0]];
  const pdf = await renderSheets({
    template: await toRenderTemplate(template),
    profile,
    pages: selected.map((row) => row.map((n) => (n === null ? null : { number: formatNumber(n), qrValue: newQrValue() }))),
    header: `APERÇU — ${category.name} — numéros indicatifs ${formatNumber(first)} à ${formatNumber(first + q.quantity - 1)} · ${pages} pages · page 1 puis page ${pages} · QR spécimens`,
  });
  return pdfResponse(pdf, "apercu-lot.pdf");
}
