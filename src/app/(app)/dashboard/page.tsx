import Link from "next/link";
import { Badge, Card, PageTitle, Stat, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getEventAccess, listAccessibleEvents } from "@/lib/authz";
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from "@/lib/labels";
import { globalSummary } from "@/lib/reports";
import { formatDateTime, formatGnf } from "@/lib/time";

/** Tableau de bord global : tous les événements dont l'utilisateur voit les finances. */
export default async function DashboardPage() {
  const user = await requireUser();
  const all = await listAccessibleEvents(user);
  const visible = [];
  for (const e of all) if ((await getEventAccess(user, e.id))?.can("finance.view")) visible.push(e);
  const rows = await globalSummary(visible.map((e) => e.id));
  const byId = new Map(rows.map((r) => [r.eventId, r]));
  const sum = (k: "sold" | "used" | "netGnf" | "paidGnf" | "balanceGnf") => rows.reduce((a, r) => a + r[k], 0);
  const n = (v: number) => v.toLocaleString("fr-FR");

  return (
    <>
      <PageTitle>Tableau de bord</PageTitle>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Événements" value={visible.length} sub={`${visible.filter((e) => e.status === "OPEN").length} ouverts`} />
        <Stat label="Billets vendus" value={n(sum("sold"))} sub={`${n(sum("used"))} entrées`} />
        <Stat label="Recettes nettes déclarées" value={formatGnf(sum("netGnf"))} />
        <Stat label="Reste dû par les vendeurs" value={formatGnf(sum("balanceGnf"))} sub={`versé et validé : ${formatGnf(sum("paidGnf"))}`} />
      </div>
      <Card>
        <Table head={["Événement", "Date", "État", "Générés", "Vendus", "Activés", "Entrées", "Recettes nettes", "Versé validé", "Solde dû"]} empty={visible.length === 0}>
          {visible.map((e) => {
            const r = byId.get(e.id)!;
            return (
              <tr key={e.id}>
                <Td>
                  <Link href={`/events/${e.id}`} className="font-medium text-blue-700 hover:underline">{e.name}</Link>
                  <div className="text-xs text-slate-500">{e.organization.name}</div>
                </Td>
                <Td className="text-xs">{formatDateTime(e.startsAt, e.timezone)}</Td>
                <Td><Badge color={EVENT_STATUS_COLORS[e.status]}>{EVENT_STATUS_LABELS[e.status]}</Badge></Td>
                <Td>{n(r.generated)}</Td>
                <Td>{n(r.sold)}</Td>
                <Td>{n(r.activated)}</Td>
                <Td>{n(r.used)}</Td>
                <Td>{formatGnf(r.netGnf)}</Td>
                <Td>{formatGnf(r.paidGnf)}</Td>
                <Td className="font-semibold">{formatGnf(r.balanceGnf)}</Td>
              </tr>
            );
          })}
        </Table>
        <p className="mt-3 text-xs text-slate-500">Montants déclarés par les vendeurs ; seuls les versements validés sont rapprochés. Détail et exports dans chaque événement.</p>
      </Card>
    </>
  );
}
