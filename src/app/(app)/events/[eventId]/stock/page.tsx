import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, CategoryField, Card, Field, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { MOVEMENT_LABELS, MOVEMENT_STATUS_LABELS } from "@/lib/labels";
import { holdersOf, namesFor } from "@/lib/people";
import { holderSummaries } from "@/lib/stock";
import { formatTicketRanges } from "@/lib/ticket-numbers";
import { formatDateTime } from "@/lib/time";
import {
  activationAction,
  assignAction,
  confirmMovementAction,
  incidentAction,
  refuseMovementAction,
  replaceAction,
  returnAction,
  stockCountAction,
} from "../../stock-actions";

export default async function StockPage({ params }: PageProps<"/events/[eventId]/stock">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "tickets.view");
  const canManage = access.can("stock.assign");
  const [event, categories, summaries, holders, pending, recent, counts, activated] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" }, select: { id: true, name: true } }),
    holderSummaries(eventId),
    holdersOf(eventId),
    db.stockMovement.findMany({ where: { eventId, status: "PENDING" }, orderBy: { createdAt: "asc" }, include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } } }),
    db.stockMovement.findMany({ where: { eventId }, orderBy: { createdAt: "desc" }, take: 40, include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } } }),
    db.stockCount.findMany({ where: { eventId }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.ticket.count({ where: { eventId, activatedAt: { not: null }, blockState: "NONE" } }),
  ]);
  const name = await namesFor([
    ...summaries.map((s) => s.holderId),
    ...recent.flatMap((m) => [m.fromUserId, m.toUserId, m.createdById]),
    ...pending.flatMap((m) => [m.fromUserId, m.toUserId, m.createdById]),
    ...counts.flatMap((c) => [c.holderId, c.createdById]),
  ]);
  const tz = event.timezone;
  const locked = event.status === "CLOSED" || event.status === "ARCHIVED";
  const rows = summaries
    .filter((s) => s.holderId === null || s.received + s.inHand + s.pendingIn + s.soldFromHand > 0)
    .sort((a, b) => (a.holderId === null ? -1 : b.holderId === null ? 1 : name(a.holderId).localeCompare(name(b.holderId))));
  const totalGap = rows.reduce((a, r) => a + Math.abs(r.gap), 0);
  const holderOptions = holders.map((h) => <option key={h.id} value={h.id}>{h.name}</option>);

  return (
    <>
      <Card title="Stock par détenteur">
        <Table head={["Détenteur", "Reçus", "Sortis", "Vendus", "Bloqués", "À réceptionner", "En main", "Attendu", "Écart"]}>
          {rows.map((s) => (
            <tr key={s.holderId ?? "central"}>
              <Td className="font-medium">{name(s.holderId)}</Td>
              <Td>{s.received.toLocaleString("fr-FR")}</Td>
              <Td>{s.given.toLocaleString("fr-FR")}</Td>
              <Td>{s.soldFromHand.toLocaleString("fr-FR")}</Td>
              <Td>{s.blockedInHand.toLocaleString("fr-FR")}</Td>
              <Td>{s.pendingIn ? <Badge color="orange">{s.pendingIn}</Badge> : "—"}</Td>
              <Td className="font-semibold">{s.inHand.toLocaleString("fr-FR")}</Td>
              <Td>{s.expected.toLocaleString("fr-FR")}</Td>
              <Td>{s.gap === 0 ? <Badge color="green">0</Badge> : <Badge color="red">{s.gap > 0 ? "+" : ""}{s.gap}</Badge>}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-slate-500">
          Attendu = reçus − sortis − vendus − bloqués (section 8). {totalGap === 0 ? "Aucun écart entre les mouvements et l'état des billets." : "Un écart signale une incohérence à examiner : il n'est jamais corrigé automatiquement."}
          {" "}{activated.toLocaleString("fr-FR")} billet(s) activé(s) (valables au contrôle sans vente déclarée).
        </p>
      </Card>

      {pending.length > 0 && (
        <Card title="Mouvements en attente">
          <div className="space-y-3">
            {pending.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm">
                <span className="grow">
                  <strong>{MOVEMENT_LABELS[m.kind]}</strong> de {m.quantity} billet(s) · {name(m.fromUserId)} → {name(m.toUserId)} · {formatTicketRanges(m.tickets.map((t) => t.ticket), 6)} · {formatDateTime(m.createdAt, tz)}
                </span>
                {canManage && m.kind === "RETURN" && (
                  <form action={confirmMovementAction.bind(null, eventId, m.id)}>
                    <button className="rounded-md bg-green-700 px-3 py-1.5 font-semibold text-white">Confirmer le retour</button>
                  </form>
                )}
                {canManage && (
                  <ActionForm action={refuseMovementAction} submitLabel={m.kind === "RETURN" ? "Refuser" : "Annuler la remise"} className="flex items-center gap-2">
                    <input type="hidden" name="eventId" value={eventId} />
                    <input type="hidden" name="movementId" value={m.id} />
                    <input name="incident" placeholder="Motif" className="!mt-0 !w-48" />
                  </ActionForm>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {canManage && !locked && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Remettre des billets">
            <ActionForm action={assignAction} submitLabel="Remettre">
              <input type="hidden" name="eventId" value={eventId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Depuis">
                  <select name="from"><option value="central">Stock central</option>{holderOptions}</select>
                </Field>
                <Field label="À">
                  <select name="to" required>{holderOptions}</select>
                </Field>
              </div>
              <CategoryField categories={categories} />
              <Field label="Billets" hint="Ex. 001-100, 150. Le destinataire confirme la réception avant de vendre."><input name="numbers" required /></Field>
              <Field label="Motif (facultatif)"><input name="reason" /></Field>
              {holders.length === 0 && (
                <p className="text-sm text-orange-700">
                  Aucun vendeur : ajoutez-en dans l&apos;onglet <Link href={`/events/${eventId}/team`} className="underline">Équipe</Link>.
                </p>
              )}
            </ActionForm>
          </Card>

          <Card title="Retour au stock central">
            <ActionForm action={returnAction} submitLabel="Enregistrer le retour">
              <input type="hidden" name="eventId" value={eventId} />
              <Field label="Détenteur"><select name="from" required>{holderOptions}</select></Field>
              <CategoryField categories={categories} />
              <Field label="Billets invendus rendus"><input name="numbers" required /></Field>
              <Field label="Motif"><input name="reason" placeholder="Invendus" /></Field>
            </ActionForm>
          </Card>

          <Card title="Perte, dommage, annulation (billets non vendus)">
            <ActionForm action={incidentAction} submitLabel="Bloquer définitivement">
              <input type="hidden" name="eventId" value={eventId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nature">
                  <select name="kind"><option value="LOSS">Perte</option><option value="DAMAGE">Dommage / destruction</option><option value="CANCEL">Annulation</option></select>
                </Field>
                <CategoryField categories={categories} />
                <Field label="Billets"><input name="numbers" required /></Field>
              </div>
              <Field label="Motif"><input name="reason" required /></Field>
              <p className="text-xs text-slate-500">Un billet bloqué est refusé au contrôle ; son numéro n&apos;est jamais réattribué. Un billet vendu s&apos;annule depuis l&apos;onglet Ventes.</p>
            </ActionForm>
          </Card>

          <Card title="Remplacer un billet vendu">
            <ActionForm action={replaceAction} submitLabel="Remplacer">
              <input type="hidden" name="eventId" value={eventId} />
              <CategoryField categories={categories} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Billet vendu"><input name="oldNumber" type="number" min={1} required /></Field>
                <Field label="État">
                  <select name="oldState"><option value="LOST">Perdu</option><option value="DESTROYED">Endommagé</option></select>
                </Field>
                <Field label="Remplacé par"><input name="newNumber" type="number" min={1} required /></Field>
              </div>
              <Field label="Motif"><input name="reason" required /></Field>
              <p className="text-xs text-slate-500">L&apos;ancien billet est bloqué ; le nouveau, de même catégorie, est rattaché à la même vente sans nouvel encaissement.</p>
            </ActionForm>
          </Card>

          <Card title="Activation (ventes rapides)">
            <ActionForm action={activationAction} submitLabel="Appliquer">
              <input type="hidden" name="eventId" value={eventId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Opération">
                  <select name="mode"><option value="activate">Activer</option><option value="deactivate">Désactiver</option></select>
                </Field>
                <CategoryField categories={categories} />
                <Field label="Billets"><input name="numbers" required /></Field>
              </div>
              <Field label="Motif"><input name="reason" placeholder="Guichet rapide porte B" /></Field>
              <p className="text-xs text-slate-500">Un billet activé passe au contrôle même sans vente déclarée ; « activé » et « vendu » restent distincts dans les rapports.</p>
            </ActionForm>
          </Card>

          <Card title="Comptage physique">
            <ActionForm action={stockCountAction} submitLabel="Enregistrer">
              <input type="hidden" name="eventId" value={eventId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Détenteur"><select name="holder"><option value="central">Stock central</option>{holderOptions}</select></Field>
                <Field label="Billets comptés"><input name="counted" type="number" min={0} required /></Field>
              </div>
              <Field label="Remarque"><input name="note" /></Field>
            </ActionForm>
            {counts.length > 0 && (
              <ul className="mt-4 space-y-1 text-xs">
                {counts.map((c) => (
                  <li key={c.id}>
                    {formatDateTime(c.createdAt, tz)} · {name(c.holderId)} : compté {c.counted}, attendu {c.expected}{" "}
                    {c.counted === c.expected ? <Badge color="green">conforme</Badge> : <Badge color="red">écart {c.counted - c.expected > 0 ? "+" : ""}{c.counted - c.expected}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <Card title="Derniers mouvements">
        <Table head={["Date", "Opération", "De → à", "Billets", "État", "Par", "Motif"]} empty={recent.length === 0}>
          {recent.map((m) => (
            <tr key={m.id}>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(m.createdAt, tz)}</Td>
              <Td>{MOVEMENT_LABELS[m.kind]}</Td>
              <Td className="text-xs">{["ASSIGN", "RETURN"].includes(m.kind) ? `${name(m.fromUserId)} → ${name(m.toUserId)}` : "—"}</Td>
              <Td className="text-xs">{m.quantity} · {formatTicketRanges(m.tickets.map((t) => t.ticket), 4)}</Td>
              <Td><Badge color={m.status === "CONFIRMED" ? "green" : m.status === "PENDING" ? "orange" : "red"}>{MOVEMENT_STATUS_LABELS[m.status]}</Badge></Td>
              <Td className="text-xs">{name(m.createdById)}</Td>
              <Td className="text-xs">{m.incident ? `Incident : ${m.incident}` : m.reason}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
