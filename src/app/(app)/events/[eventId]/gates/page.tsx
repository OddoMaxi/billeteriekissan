import { ActionForm } from "@/components/action-form";
import { Badge, Card, Stat, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { formatNumber } from "@/lib/numbering";
import { namesFor } from "@/lib/people";
import { gateStats } from "@/lib/scan";
import { formatDateTime } from "@/lib/time";
import { AutoRefresh } from "../batches/[batchId]/auto-refresh";
import { resolveIncidentAction } from "../../gate-actions";

const REASON_LABELS: Record<string, string> = {
  OK: "Valide",
  REENTRY: "Réentrée",
  EXIT: "Sortie",
  OVERRIDE: "Dérogation",
  UNKNOWN: "Inexistant",
  OTHER_EVENT: "Autre événement",
  FORBIDDEN_GATE: "Mauvaise porte",
  NOT_ACTIVATED: "Non vendu",
  CANCELLED: "Annulé",
  LOST: "Perdu",
  DESTROYED: "Détruit",
  ALREADY_USED: "Déjà utilisé",
  NOT_INSIDE: "Pas à l'intérieur",
  NO_REENTRY: "Sortie définitive",
  OUT_OF_SLOT: "Hors créneau",
  MANUAL_ENTRY: "Saisie manuelle",
  AMBIGUOUS_NUMBER: "Numéro ambigu",
  EVENT_CLOSED: "Contrôle fermé",
};

export default async function GatesPage({ params }: PageProps<"/events/[eventId]/gates">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "gates.view");
  const canResolve = access.can("scan.override");
  const [event, gates, stats, incidents, scans, issuable] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.gate.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
    gateStats(eventId),
    db.gateIncident.findMany({ where: { eventId }, orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }], take: 30 }),
    db.scan.findMany({ where: { eventId }, orderBy: { serverTime: "desc" }, take: 60, include: { ticket: { select: { number: true, eventId: true, category: { select: { name: true } } } } } }),
    db.ticket.count({ where: { eventId, blockState: "NONE", OR: [{ commercialState: "SOLD" }, { activatedAt: { not: null } }] } }),
  ]);
  const name = await namesFor([...incidents.flatMap((i) => [i.controllerId, i.resolvedById]), ...scans.map((s) => s.controllerId)]);
  const gateName = new Map(gates.map((g) => [g.id, g.name]));
  const count = (gateId: string, verdict: string) => stats.byGate.find((x) => x.gateId === gateId && x.verdict === verdict)?._count ?? 0;
  const tz = event.timezone;
  const open = incidents.filter((i) => !i.resolvedAt);

  return (
    <>
      <AutoRefresh active={event.status === "OPEN"} intervalMs={10_000} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Entrés" value={stats.admitted.toLocaleString("fr-FR")} sub={`sur ${issuable.toLocaleString("fr-FR")} billets vendus ou activés`} />
        <Stat label="Refus" value={stats.byReason.reduce((a, r) => a + r._count, 0).toLocaleString("fr-FR")} sub="lectures non admises" />
        <Stat label="Admissions par dérogation" value={stats.exceptions} />
        <Stat label="Incidents ouverts" value={open.length} />
      </div>

      <Card title="Par porte">
        <Table head={["Porte", "Valides", "Refusés", "À vérifier", "État"]} empty={gates.length === 0}>
          {gates.map((g) => (
            <tr key={g.id}>
              <Td className="font-medium">{g.name}</Td>
              <Td>{count(g.id, "VALID")}</Td>
              <Td>{count(g.id, "REFUSED")}</Td>
              <Td>{count(g.id, "CHECK")}</Td>
              <Td>{g.active ? <Badge color="green">Ouverte</Badge> : <Badge color="red">Fermée</Badge>}</Td>
            </tr>
          ))}
        </Table>
        {stats.byReason.length > 0 && (
          <p className="mt-3 text-sm text-slate-600">
            Motifs de non-admission :{" "}
            {stats.byReason
              .sort((a, b) => b._count - a._count)
              .map((r) => `${REASON_LABELS[r.reason]} ${r._count}`)
              .join(" · ")}
          </p>
        )}
      </Card>

      <Card title="Incidents signalés">
        {incidents.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun incident.</p>
        ) : (
          <ul className="space-y-3">
            {incidents.map((i) => (
              <li key={i.id} className={`rounded-md border p-3 text-sm ${i.resolvedAt ? "border-slate-200" : "border-orange-300 bg-orange-50"}`}>
                <div>
                  <strong>{gateName.get(i.gateId)}</strong> · {name(i.controllerId)} · {formatDateTime(i.createdAt, tz)}
                </div>
                <div className="mt-1">{i.message}</div>
                {i.resolvedAt ? (
                  <div className="mt-1 text-xs text-slate-500">Traité par {name(i.resolvedById)} le {formatDateTime(i.resolvedAt, tz)}{i.resolution && ` : ${i.resolution}`}</div>
                ) : (
                  canResolve && (
                    <ActionForm action={resolveIncidentAction} submitLabel="Marquer traité" className="mt-2 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="incidentId" value={i.id} />
                      <input name="resolution" placeholder="Décision prise" className="!mt-0 !w-72" />
                    </ActionForm>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Dernières lectures">
        <Table head={["Heure", "Porte", "Contrôleur", "Billet", "Verdict", "Motif"]} empty={scans.length === 0}>
          {scans.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap text-xs tabular-nums">{formatDateTime(s.serverTime, tz)}</Td>
              <Td>{gateName.get(s.gateId)}</Td>
              <Td className="text-xs">{name(s.controllerId)}</Td>
              <Td className="font-mono text-xs">{s.ticket && s.ticket.eventId === eventId ? `${s.ticket.category.name} ${formatNumber(s.ticket.number)}` : s.maskedValue}</Td>
              <Td>
                <Badge color={s.verdict === "VALID" ? "green" : s.verdict === "CHECK" ? "orange" : "red"}>
                  {s.verdict === "VALID" ? "Valide" : s.verdict === "CHECK" ? "À vérifier" : "Refusé"}
                </Badge>
              </Td>
              <Td className="text-xs">
                {REASON_LABELS[s.reason]}
                {s.exception && s.exceptionReason && ` — ${s.exceptionReason}`}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
