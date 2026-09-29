import { Badge, Card, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { BLOCK_LABELS, COMMERCIAL_LABELS, MOVEMENT_LABELS, MOVEMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { formatNumber } from "@/lib/numbering";
import { namesFor } from "@/lib/people";
import { findTickets } from "@/lib/stock";
import { formatDateTime, formatGnf } from "@/lib/time";

/** Consultation d'un billet (numéro, « VIP 012 », talon ou QR scanné) : ne consomme jamais le billet. */
export default async function TicketLookupPage({ params, searchParams }: PageProps<"/events/[eventId]/tickets">) {
  const { eventId } = await params;
  const { q } = await searchParams;
  await requireEventPermission(eventId, "tickets.view");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const query = typeof q === "string" ? q.trim() : "";
  const results = query ? await findTickets(eventId, query) : [];
  const name = await namesFor(
    results.flatMap((r) => [r.ticket.holderId, r.ticket.sellerId, r.ticket.activatedById, ...r.movements.flatMap((m) => [m.fromUserId, m.toUserId, m.createdById]), ...r.saleLines.map((l) => l.sale.sellerId)]),
  );
  const tz = event.timezone;

  return (
    <>
      <Card title="Rechercher un billet">
        <form className="flex max-w-xl gap-2">
          <input name="q" defaultValue={query} placeholder="Numéro (012), catégorie et numéro (VIP 012) ou scan du QR" autoFocus autoComplete="off" />
          <button className="mt-1 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white">Rechercher</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          Chaque catégorie a sa propre numérotation : précisez la catégorie (« VIP 012 ») si besoin. La consultation ne consomme pas le billet.
        </p>
      </Card>

      {query && results.length === 0 && (
        <Card><p className="text-sm text-red-700">Aucun billet de cet événement ne correspond à « {query.length > 20 ? query.slice(0, 8) + "…" : query} ».</p></Card>
      )}
      {results.length > 1 && (
        <p className="mb-4 rounded-md bg-orange-50 p-3 text-sm text-orange-900">
          Ce numéro existe dans {results.length} catégories : {results.map((r) => r.ticket.category.name).join(", ")}. Vérifiez la catégorie imprimée sur le billet.
        </p>
      )}

      {results.map(({ ticket: t, movements, saleLines, scans }) => (
        <div key={t.id}>
          <Card title={`Billet ${t.category.name} ${formatNumber(t.number)}`}>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div><dt className="text-slate-500">Catégorie</dt><dd>{t.category.name} · {formatGnf(t.category.priceGnf)}</dd></div>
              <div><dt className="text-slate-500">Lot</dt><dd>{formatNumber(t.batch.firstNumber)} → {formatNumber(t.batch.lastNumber)}</dd></div>
              <div><dt className="text-slate-500">État commercial</dt><dd>{COMMERCIAL_LABELS[t.commercialState]}{t.pendingMovementId && " (réception en attente)"}</dd></div>
              <div><dt className="text-slate-500">Détenteur</dt><dd>{name(t.holderId)}</dd></div>
              <div><dt className="text-slate-500">Vendeur</dt><dd>{t.sellerId ? `${name(t.sellerId)} · ${formatDateTime(t.soldAt, tz)}` : "—"}</dd></div>
              <div><dt className="text-slate-500">Activation</dt><dd>{t.activatedAt ? `Activé le ${formatDateTime(t.activatedAt, tz)} par ${name(t.activatedById)}` : "Non activé"}</dd></div>
              <div><dt className="text-slate-500">Blocage</dt><dd>{t.blockState === "NONE" ? "—" : <Badge color="red">{BLOCK_LABELS[t.blockState]}</Badge>}</dd></div>
              <div><dt className="text-slate-500">Entrée</dt><dd>{t.entryState === "USED" ? <Badge color="blue">Utilisé le {formatDateTime(t.usedAt, tz)}</Badge> : "Non utilisé"}</dd></div>
            </dl>
          </Card>
          <Card title="Historique">
            <Table head={["Date", "Événement", "Détail"]}>
              <tr>
                <Td className="text-xs">{formatDateTime(t.createdAt, tz)}</Td>
                <Td>Génération</Td>
                <Td className="text-xs">Lot {t.category.name} {formatNumber(t.batch.firstNumber)}–{formatNumber(t.batch.lastNumber)}</Td>
              </tr>
              {[
                ...movements.map((m) => ({
                  at: m.createdAt,
                  label: MOVEMENT_LABELS[m.kind],
                  detail: `${["ASSIGN", "RETURN"].includes(m.kind) ? `${name(m.fromUserId)} → ${name(m.toUserId)} · ` : ""}${MOVEMENT_STATUS_LABELS[m.status]}${m.incident ? ` (${m.incident})` : ""}${m.reason ? ` · ${m.reason}` : ""} · par ${name(m.createdById)}`,
                })),
                ...saleLines.map((l) => ({
                  at: l.sale.createdAt,
                  label: l.sale.kind === "SALE" ? (l.priceGnf === 0 ? "Rattaché à une vente (remplacement)" : "Vente déclarée") : l.sale.reversalType === "CANCELLATION" ? "Annulation de la vente" : "Correction de saisie",
                  detail: `${name(l.sale.sellerId)} · ${formatGnf(l.sale.totalGnf)} pour la vente · ${PAYMENT_METHOD_LABELS[l.sale.paymentMethod]}${l.sale.reason ? ` · ${l.sale.reason}` : ""}`,
                })),
                ...scans.map((sc) => ({ at: sc.serverTime, label: `Contrôle : ${sc.verdict}`, detail: sc.reason as string })),
              ]
                .sort((a, b) => a.at.getTime() - b.at.getTime())
                .map((e, i) => (
                  <tr key={i}>
                    <Td className="whitespace-nowrap text-xs">{formatDateTime(e.at, tz)}</Td>
                    <Td>{e.label}</Td>
                    <Td className="text-xs">{e.detail}</Td>
                  </tr>
                ))}
            </Table>
          </Card>
        </div>
      ))}
    </>
  );
}
