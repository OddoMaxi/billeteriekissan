import { Card, Stat, Table, Td } from "@/components/ui";
import type { EventAccess } from "@/lib/authz";
import { db } from "@/lib/db";
import { periodLabel } from "@/lib/exports";
import { namesFor } from "@/lib/people";
import { parsePeriod } from "@/lib/period";
import { eventReport } from "@/lib/reports";
import { formatGnf } from "@/lib/time";
import { AutoRefresh } from "./batches/[batchId]/auto-refresh";

const n = (v: number) => v.toLocaleString("fr-FR");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "—");

/** Tableau de bord d'un événement (section 8). */
export async function EventDashboard({ access, from, to }: { access: EventAccess; from?: string; to?: string }) {
  const eventId = access.eventId;
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const tz = event.timezone;
  const period = parsePeriod(from, to, tz);
  const r = await eventReport(eventId, period);
  const [name, gates] = await Promise.all([
    namesFor([...r.money.map((m) => m.sellerId)]),
    db.gate.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
  ]);
  const t = r.totals;
  const m = r.moneyTotals;
  const admissible = t.sold + t.activatedNotSold;
  const entries = (g: string, v: string) => r.entries.find((e) => e.gateId === g && e.verdict === v)?._count ?? 0;
  const maxHour = Math.max(1, ...r.byHour.map((h) => h.count));
  const updated = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, timeStyle: "medium" }).format(r.generatedAt);
  const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const exportUrl = (params: Record<string, string>) => `/api/events/${eventId}/export?${new URLSearchParams({ ...params, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;

  return (
    <>
      <AutoRefresh active={event.status === "OPEN"} intervalMs={30_000} />
      <form className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          Du
          <input type="date" name="from" defaultValue={from} className="!w-40" />
        </label>
        <label className="block">
          Au
          <input type="date" name="to" defaultValue={to} className="!w-40" />
        </label>
        <button className="rounded-md border border-slate-300 bg-white px-3 py-2 font-medium hover:bg-slate-100">Filtrer</button>
        {qs && <a href="?" className="py-2 text-blue-700 hover:underline">Toute la période</a>}
        <span className="ml-auto py-2 text-slate-500">
          Mis à jour à {updated}
          {event.status === "OPEN" && " · actualisation automatique toutes les 30 s"}
        </span>
      </form>
      <p className="-mt-2 mb-4 text-xs text-slate-500">
        États des billets : instantané actuel. Ventes, versements et entrées : {periodLabel(period, tz)}.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Billets vendus" value={n(t.sold)} sub={`${n(t.activatedNotSold)} activés sans vente · ${n(t.generated)} générés`} />
        <Stat label="Entrées" value={n(t.used)} sub={`${pct(t.used, admissible)} des billets vendus ou activés`} />
        <Stat label="Recettes nettes déclarées" value={formatGnf(m.netGnf)} sub={`théoriques : ${formatGnf(t.theoreticalGnf)}`} />
        <Stat label="Versements validés" value={formatGnf(m.paymentsValidatedGnf)} sub={`reste dû : ${formatGnf(m.balanceGnf)}`} />
      </div>

      <Card title="Écarts et points d'attention">
        {r.anomalies.length === 0 ? (
          <p className="text-sm text-green-700">Aucun écart : stocks, mouvements et caisses concordent.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {r.anomalies.map((a, i) => (
              <li key={i} className={a.level === "error" ? "font-semibold text-red-700" : a.level === "warning" ? "text-orange-700" : "text-slate-700"}>
                {a.level === "error" ? "✗ " : a.level === "warning" ? "⚠ " : "• "}
                {a.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Billets par catégorie (état actuel)">
        <Table head={["Catégorie", "Quota", "Générés", "Imprimés", "Stock central", "Détenteurs", "Vendus", "Activés s/ vente", "Retournés", "Annulés", "Perdus / détruits", "Utilisés", "Absents"]} empty={r.perCategory.length === 0}>
          {[...r.perCategory.map((c) => ({ ...c, key: c.categoryId })), { ...t, key: "total", name: "Total" }].map((c) => (
            <tr key={c.key} className={c.key === "total" ? "font-semibold" : ""}>
              <Td>{c.name}</Td>
              <Td>{n(c.quota)}</Td>
              <Td>{n(c.generated)}</Td>
              <Td>{n(c.printed)}</Td>
              <Td>{n(c.inStock)}</Td>
              <Td>{n(c.withHolders)}</Td>
              <Td>{n(c.sold)}</Td>
              <Td>{n(c.activatedNotSold)}</Td>
              <Td>{n(c.returned)}</Td>
              <Td>{n(c.cancelled)}</Td>
              <Td>{n(c.lost + c.destroyed)}</Td>
              <Td>{n(c.used)}</Td>
              <Td>{n(c.soldNotUsed)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {access.can("finance.view") && (
        <Card title="Recettes et caisse par vendeur">
          <div className="mb-4 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex justify-between"><span className="text-slate-500">Recettes théoriques (prix facial des vendus)</span><span>{formatGnf(t.theoreticalGnf)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Ventes déclarées</span><span>{formatGnf(m.salesGnf)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">dont remises</span><span>{formatGnf(m.discountGnf)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Corrections et remboursements</span><span>− {formatGnf(m.correctionsGnf + m.refundsGnf)}</span></div>
            <div className="flex justify-between font-semibold"><span>Recettes nettes déclarées</span><span>{formatGnf(m.netGnf)}</span></div>
            <div className="flex justify-between font-semibold"><span>Versements validés (rapprochés)</span><span>{formatGnf(m.paymentsValidatedGnf)}</span></div>
          </div>
          <Table head={["Vendeur", "Billets", "Ventes", "Remises", "Corrections", "Rembours.", "Nettes", "Versé validé", "En attente", "Solde dû"]} empty={r.money.length === 0}>
            {r.money.map((x) => (
              <tr key={x.sellerId}>
                <Td className="font-medium">{name(x.sellerId)}</Td>
                <Td>{n(x.ticketsSold)}</Td>
                <Td>{formatGnf(x.salesGnf)}</Td>
                <Td>{x.discountGnf ? formatGnf(x.discountGnf) : "—"}</Td>
                <Td>{x.correctionsGnf ? formatGnf(x.correctionsGnf) : "—"}</Td>
                <Td>{x.refundsGnf ? formatGnf(x.refundsGnf) : "—"}</Td>
                <Td className="font-semibold">{formatGnf(x.netGnf)}</Td>
                <Td>{formatGnf(x.paymentsValidatedGnf)}</Td>
                <Td>{x.paymentsPendingGnf ? formatGnf(x.paymentsPendingGnf) : "—"}</Td>
                <Td className="font-semibold">{formatGnf(x.balanceGnf)}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-slate-500">Montants déclarés par les vendeurs : ils ne prouvent pas l&apos;encaissement. Seuls les versements validés sont rapprochés.</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Entrées par porte">
          <Table head={["Porte", "Valides", "Refusés", "À vérifier"]} empty={gates.length === 0}>
            {gates.map((g) => (
              <tr key={g.id}>
                <Td className="font-medium">{g.name}</Td>
                <Td>{n(entries(g.id, "VALID"))}</Td>
                <Td>{n(entries(g.id, "REFUSED"))}</Td>
                <Td>{n(entries(g.id, "CHECK"))}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Entrées par heure">
          {r.byHour.length === 0 ? (
            <p className="text-sm text-slate-500">Aucune entrée sur la période.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {r.byHour.map((h) => (
                <li key={h.hour.toISOString()} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 tabular-nums text-slate-600">
                    {new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit" }).format(h.hour)}
                  </span>
                  <span className="h-4 rounded bg-blue-600" style={{ width: `${Math.max(2, (h.count / maxHour) * 70)}%` }} />
                  <span className="tabular-nums">{n(h.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {access.can("report.export") && (
        <Card title="Exports">
          <p className="mb-3 text-sm text-slate-600">Période appliquée : {periodLabel(period, tz)}. Chaque export indique son auteur et sa date, et il est journalisé.</p>
          <div className="flex flex-wrap gap-2 text-sm">
            <a href={exportUrl({ format: "pdf" })} className="rounded-md bg-blue-700 px-3 py-2 font-semibold text-white hover:bg-blue-800">Rapport de clôture (PDF)</a>
            <a href={exportUrl({ format: "xlsx" })} className="rounded-md bg-green-700 px-3 py-2 font-semibold text-white hover:bg-green-800">Classeur complet (XLSX)</a>
            {([["tickets", "Billets"], ["sales", "Ventes"], ["payments", "Versements"], ["scans", "Contrôle"], ["movements", "Mouvements"]] as const).map(([k, label]) => (
              <a key={k} href={exportUrl({ format: "csv", table: k })} className="rounded-md border border-slate-300 bg-white px-3 py-2 font-medium hover:bg-slate-100">
                {label} (CSV)
              </a>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
