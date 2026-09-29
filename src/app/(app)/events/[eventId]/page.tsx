import { Card, Stat, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { formatGnf } from "@/lib/time";
import { EventDashboard } from "./dashboard";

export default async function EventOverview({ params, searchParams }: PageProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "event.view");
  // Organisation, gestionnaire, auditeur : tableau de bord complet. Vendeurs et contrôleurs : aperçu simple.
  if (access.can("tickets.view")) {
    const { from, to } = await searchParams;
    return <EventDashboard access={access} from={typeof from === "string" ? from : undefined} to={typeof to === "string" ? to : undefined} />;
  }
  const [categories, gates, members, issued] = await Promise.all([
    db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" } }),
    db.gate.count({ where: { eventId, active: true } }),
    db.eventMembership.count({ where: { eventId, revokedAt: null } }),
    db.ticket.groupBy({ by: ["categoryId"], where: { eventId }, _count: true }),
  ]);
  const issuedBy = new Map(issued.map((i) => [i.categoryId, i._count]));
  const quota = categories.reduce((s, c) => s + c.quota, 0);

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Catégories" value={categories.length} />
        <Stat label="Quota total" value={quota.toLocaleString("fr-FR")} />
        <Stat label="Portes actives" value={gates} />
        <Stat label="Membres de l'équipe" value={members} />
      </div>
      {access.can("tickets.view") && (
        <Card title="Catégories">
          <Table head={["Catégorie", "Prix facial", "Quota", "Billets générés"]} empty={categories.length === 0}>
            {categories.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td>{formatGnf(c.priceGnf)}</Td>
                <Td>{c.quota.toLocaleString("fr-FR")}</Td>
                <Td>{(issuedBy.get(c.id) ?? 0).toLocaleString("fr-FR")}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
