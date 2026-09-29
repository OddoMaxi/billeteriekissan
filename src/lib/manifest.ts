import "server-only";
import { db } from "./db";
import { formatNumber } from "./numbering";

/** Manifeste d'un lot (section 5.2) : de quoi rapprocher le papier, la base et le fichier. */
export async function buildManifest(batchId: string) {
  const b = await db.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { event: { include: { organization: true } }, category: true, template: true, printProfile: true },
  });
  const [creator, blocked] = await Promise.all([
    db.user.findUnique({ where: { id: b.createdById }, select: { name: true } }),
    db.ticket.findMany({
      where: { batchId, blockState: { not: "NONE" } },
      orderBy: { number: "asc" },
      select: { number: true, blockState: true },
    }),
  ]);
  return {
    lot: b.id,
    evenement: { id: b.event.id, nom: b.event.name, organisme: b.event.organization.name },
    categorie: { nom: b.category.name, prixFacialGnf: b.category.priceGnf },
    quantite: b.quantity,
    premierNumero: formatNumber(b.firstNumber),
    dernierNumero: formatNumber(b.lastNumber),
    pages: b.pageCount,
    ticketsParPage: b.ticketsPerPage,
    disposition: b.layout === "STACKS" ? "découpe en piles" : "séquentielle",
    modele: { nom: b.template.name, version: b.template.version, empreinteDesign: b.template.backgroundSha256 },
    profilImpression: {
      nom: b.printProfile.name,
      margesMm: [b.printProfile.marginTopMm, b.printProfile.marginBottomMm, b.printProfile.marginLeftMm, b.printProfile.marginRightMm],
      espacementMm: b.printProfile.gapMm,
    },
    empreintePdfSha256: b.pdfSha256,
    etat: b.status,
    creeLe: b.createdAt.toISOString(),
    creePar: creator?.name ?? null,
    pretLe: b.readyAt?.toISOString() ?? null,
    pdfSupprimeLe: b.pdfDestroyedAt?.toISOString() ?? null,
    billetsRetires: blocked.map((t) => ({ numero: formatNumber(t.number), etat: t.blockState })),
  };
}
