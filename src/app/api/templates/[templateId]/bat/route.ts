import { audit } from "@/lib/audit";
import { newQrValue } from "@/lib/crypto";
import { db } from "@/lib/db";
import { renderSheets } from "@/lib/render";
import { adminTemplate, pdfResponse, toRenderTemplate } from "@/lib/template-files";

/**
 * BAT : une planche A4 complète de cinq spécimens avec le profil d'impression choisi.
 * Les QR spécimens ont le format réel mais ne correspondent à aucun billet (refus INEXISTANT au scan).
 * Le 5e ticket porte « 10000 » pour vérifier qu'un numéro à 5 chiffres tient dans sa zone.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/templates/[templateId]/bat">) {
  const found = await adminTemplate((await ctx.params).templateId);
  if (!found) return new Response("Introuvable", { status: 404 });
  const profileId = new URL(req.url).searchParams.get("profile") ?? "";
  const profile = /^[0-9a-f-]{36}$/i.test(profileId) ? await db.printProfile.findUnique({ where: { id: profileId } }) : null;
  if (!profile) return new Response("Profil d'impression inconnu", { status: 400 });

  const t = found.template;
  const event = await db.event.findUniqueOrThrow({ where: { id: t.eventId } });
  const faces = ["001", "002", "003", "004", "10000"].map((number) => ({ number, qrValue: newQrValue() }));
  const pdf = await renderSheets({
    template: await toRenderTemplate(t),
    profile,
    pages: [faces],
    title: `BAT ${t.name} v${t.version}`,
    header: `BAT SPÉCIMEN — ${event.name} · ${t.name} v${t.version} · profil « ${profile.name} » · imprimer à 100 %, sans ajustement`,
  });
  await audit(db, {
    actorId: found.actorId,
    eventId: t.eventId,
    action: "template.bat_download",
    objectType: "TicketTemplate",
    objectId: t.id,
    context: { printProfileId: profile.id },
  });
  return pdfResponse(pdf, `BAT-${t.name}-v${t.version}.pdf`);
}
