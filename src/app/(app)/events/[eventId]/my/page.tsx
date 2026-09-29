import { ActionForm } from "@/components/action-form";
import { SaleForm } from "@/components/sale-form";
import { Badge, CategoryField, Card, Field, Stat, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { namesFor } from "@/lib/people";
import { sellerAccounts } from "@/lib/stock";
import { formatRanges, formatTicketRanges } from "@/lib/ticket-numbers";
import { formatDateTime, formatGnf } from "@/lib/time";
import {
  confirmMovementAction,
  paymentAction,
  qrToNumberAction,
  quoteSaleAction,
  recordSaleAction,
  refuseMovementAction,
  returnAction,
  stockCountAction,
} from "../../stock-actions";

export default async function MyDeskPage({ params }: PageProps<"/events/[eventId]/my">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "stock.own");
  const me = access.user;
  const [event, categories, pendingIn, inHand, sales, payments, [account]] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" }, select: { id: true, name: true } }),
    db.stockMovement.findMany({ where: { eventId, toUserId: me.id, status: "PENDING" }, orderBy: { createdAt: "asc" }, include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } } }),
    db.ticket.findMany({
      where: { eventId, holderId: me.id, pendingMovementId: null, blockState: "NONE", commercialState: { not: "SOLD" } },
      select: { number: true, category: { select: { name: true, priceGnf: true } } },
      orderBy: { number: "asc" },
    }),
    db.sale.findMany({ where: { eventId, sellerId: me.id }, orderBy: { createdAt: "desc" }, take: 50, include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } } }),
    db.payment.findMany({ where: { eventId, sellerId: me.id }, orderBy: { declaredAt: "desc" } }),
    sellerAccounts(eventId, me.id),
  ]);
  const name = await namesFor(pendingIn.map((m) => m.fromUserId).concat(pendingIn.map((m) => m.createdById)));
  const tz = event.timezone;
  const byCategory = new Map<string, number[]>();
  for (const t of inHand) byCategory.set(t.category.name, [...(byCategory.get(t.category.name) ?? []), t.number]);
  const locked = event.status === "CLOSED" || event.status === "ARCHIVED";

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Billets en main" value={inHand.length} sub={pendingIn.length ? `+ ${pendingIn.reduce((a, m) => a + m.quantity, 0)} à réceptionner` : undefined} />
        <Stat label="Billets vendus" value={account.ticketsSold} />
        <Stat label="Recettes déclarées" value={formatGnf(account.netGnf)} sub={account.correctionsGnf || account.refundsGnf ? `après corrections et remboursements` : undefined} />
        <Stat label="Reste à verser" value={formatGnf(account.balanceGnf)} sub={account.paymentsPendingGnf ? `${formatGnf(account.paymentsPendingGnf)} déclarés, en attente de validation` : `versé et validé : ${formatGnf(account.paymentsValidatedGnf)}`} />
      </div>

      {pendingIn.length > 0 && (
        <Card title="Billets à réceptionner">
          <p className="mb-3 text-sm text-slate-600">Comptez les billets reçus avant de confirmer. En cas d&apos;écart, refusez la remise en indiquant le problème : les billets reviennent à l&apos;émetteur.</p>
          <div className="space-y-4">
            {pendingIn.map((m) => (
              <div key={m.id} className="rounded-md border border-orange-200 bg-orange-50 p-3">
                <p className="text-sm">
                  <strong>{m.quantity} billet(s)</strong> remis par {name(m.createdById)} le {formatDateTime(m.createdAt, tz)} :{" "}
                  {formatTicketRanges(m.tickets.map((t) => t.ticket))}
                  {m.reason && <span className="text-slate-600"> — {m.reason}</span>}
                </p>
                <div className="mt-2 flex flex-wrap items-start gap-4">
                  <form action={confirmMovementAction.bind(null, eventId, m.id)}>
                    <button className="rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800">Confirmer la réception</button>
                  </form>
                  <ActionForm action={refuseMovementAction} submitLabel="Refuser" className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="eventId" value={eventId} />
                    <input type="hidden" name="movementId" value={m.id} />
                    <input name="incident" placeholder="Motif : reçu 98 au lieu de 100…" className="!mt-0 !w-72" />
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!locked && (
        <Card title="Enregistrer une vente">
          <SaleForm
            eventId={eventId}
            sellers={[{ id: me.id, name: me.name }]}
            categories={categories}
            defaultSellerId={me.id}
            canOverrideDiscount={access.can("sale.discount_override")}
            quoteAction={quoteSaleAction}
            saleAction={recordSaleAction}
            qrAction={qrToNumberAction}
          />
        </Card>
      )}

      <Card title="Mes billets en main">
        {inHand.length === 0 ? (
          <p className="text-sm text-slate-500">Aucun billet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {[...byCategory].map(([cat, nums]) => (
              <li key={cat}><strong>{cat}</strong> ({nums.length}) : {formatRanges(nums, 30)}</li>
            ))}
          </ul>
        )}
      </Card>

      {!locked && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Restituer des invendus">
            <ActionForm action={returnAction} submitLabel="Restituer">
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="from" value={me.id} />
              <CategoryField categories={categories} />
              <Field label="Billets" hint="La restitution est confirmée par l'organisation à réception."><input name="numbers" placeholder="151-200" required /></Field>
              <Field label="Motif"><input name="reason" placeholder="Invendus fin de journée" /></Field>
            </ActionForm>
          </Card>
          <Card title="Déclarer un versement">
            <ActionForm action={paymentAction} submitLabel="Déclarer">
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="sellerId" value={me.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Montant (GNF)"><input name="amountGnf" type="number" min={1} step={1} required /></Field>
                <Field label="Moyen">
                  <select name="method">{Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </Field>
              </div>
              <Field label="Référence (facultatif)"><input name="reference" /></Field>
            </ActionForm>
          </Card>
        </div>
      )}

      <Card title="Comptage de fin de journée">
        <ActionForm action={stockCountAction} submitLabel="Enregistrer le comptage" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="holder" value={me.id} />
          <Field label={`Billets comptés physiquement (attendu : ${inHand.length})`}><input name="counted" type="number" min={0} required className="!w-40" /></Field>
          <Field label="Remarque"><input name="note" className="!w-72" /></Field>
        </ActionForm>
      </Card>

      <Card title="Mes ventes">
        <Table head={["Date", "Billets", "Montant", "Moyen", ""]} empty={sales.length === 0}>
          {sales.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(s.soldAt, tz)}</Td>
              <Td>{formatTicketRanges(s.tickets.map((t) => t.ticket), 8)}</Td>
              <Td className={s.totalGnf < 0 ? "text-red-700" : ""}>{formatGnf(s.totalGnf)}</Td>
              <Td>{PAYMENT_METHOD_LABELS[s.paymentMethod]}{s.paymentRef && ` · ${s.paymentRef}`}</Td>
              <Td>{s.kind === "REVERSAL" && <Badge color="orange">{s.reversalType === "CANCELLATION" ? "Annulation" : "Correction"}</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Mes versements">
        <Table head={["Date", "Montant", "Moyen", "État"]} empty={payments.length === 0}>
          {payments.map((p) => (
            <tr key={p.id}>
              <Td className="text-xs">{formatDateTime(p.declaredAt, tz)}</Td>
              <Td>{formatGnf(p.amountGnf)}</Td>
              <Td>{PAYMENT_METHOD_LABELS[p.method]}{p.reference && ` · ${p.reference}`}</Td>
              <Td>
                {p.validatedAt && !p.rejectedAt ? <Badge color="green">Validé</Badge> : p.rejectedAt ? <Badge color="red">Rejeté : {p.rejectReason}</Badge> : <Badge color="orange">En attente</Badge>}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <p className="text-xs text-slate-500">Remises, ventes et versements sont journalisés. Les montants sont déclarés : ils ne prouvent pas l&apos;encaissement.</p>
    </>
  );
}
