import Link from "next/link";
import { Card, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { fitDesign, formatNumber, nominalTicket } from "@/lib/numbering";
import { formatDateTime } from "@/lib/time";
import { createBatchAction } from "../../batch-actions";
import { BatchStatusBadge } from "./status";
import { BatchForm } from "./batch-form";

export default async function BatchesPage({ params }: PageProps<"/events/[eventId]/batches">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "tickets.view");
  const isAdmin = access.user.isAdmin;
  const [event, batches, categories, templates, profiles, issued] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.batch.findMany({ where: { eventId }, orderBy: { firstNumber: "desc" }, include: { category: true, template: true } }),
    db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" } }),
    isAdmin ? db.ticketTemplate.findMany({ where: { eventId, batApprovedAt: { not: null } }, orderBy: [{ name: "asc" }, { version: "desc" }] }) : [],
    isAdmin ? db.printProfile.findMany({ orderBy: { createdAt: "asc" } }) : [],
    db.ticket.groupBy({ by: ["categoryId"], where: { eventId }, _count: true }),
  ]);
  const issuedBy = new Map(issued.map((i) => [i.categoryId, i._count]));
  const locked = event.status === "CLOSED" || event.status === "ARCHIVED";

  return (
    <>
      <Card title="Lots générés">
        <Table head={["Catégorie · numéros", "Catégorie", "Quantité", "Pages", "Modèle", "Disposition", "État", "Créé le"]} empty={batches.length === 0}>
          {batches.map((b) => (
            <tr key={b.id}>
              <Td>
                <Link href={`/events/${eventId}/batches/${b.id}`} className="font-medium text-blue-700 hover:underline">
                  {b.category.name} {formatNumber(b.firstNumber)} → {formatNumber(b.lastNumber)}
                </Link>
              </Td>
              <Td>{b.category.name}</Td>
              <Td>{b.quantity.toLocaleString("fr-FR")}</Td>
              <Td>{b.pageCount ?? "—"}</Td>
              <Td>{b.template.name} v{b.template.version}</Td>
              <Td>{b.layout === "STACKS" ? "Piles" : "Séquentielle"}</Td>
              <Td><BatchStatusBadge status={b.status} /></Td>
              <Td className="text-xs">{formatDateTime(b.createdAt, event.timezone)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {isAdmin && !locked && (
        <Card title="Générer un lot">
          <BatchForm
            eventId={eventId}
            categories={categories.map((c) => ({ id: c.id, label: c.name, remaining: c.quota - (issuedBy.get(c.id) ?? 0), nextNumber: c.nextNumber }))}
            templates={templates
              // Seuls les designs au format 5 par A4 sont proposés (un autre format serait fortement réduit).
              .filter((t) => fitDesign(t, nominalTicket()).scale >= 0.9)
              .map((t) => ({ id: t.id, label: `${t.name} v${t.version} (${t.widthMm} × ${t.heightMm} mm)` }))}
            profiles={profiles.map((p) => ({ id: p.id, label: p.name }))}
            action={createBatchAction}
          />
        </Card>
      )}
    </>
  );
}
