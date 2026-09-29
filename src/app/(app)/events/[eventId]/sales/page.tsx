import { ActionForm } from "@/components/action-form";
import { SaleForm } from "@/components/sale-form";
import { Badge, Card, Field, Stat, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { holdersOf, namesFor } from "@/lib/people";
import { sellerAccounts } from "@/lib/stock";
import { formatTicketRanges } from "@/lib/ticket-numbers";
import { formatDateTime, formatGnf } from "@/lib/time";
import {
  paymentAction,
  qrToNumberAction,
  quoteSaleAction,
  recordSaleAction,
  resolvePaymentAction,
  reverseSaleAction,
} from "../../stock-actions";

export default async function SalesPage({ params, searchParams }: PageProps<"/events/[eventId]/sales">) {
  const { eventId } = await params;
  const { seller } = await searchParams;
  const access = await requireEventPermission(eventId, "finance.view");
  const canManage = access.can("sale.manage");
  const canValidate = access.can("payment.validate");
  const sellerFilter = typeof seller === "string" && /^[0-9a-f-]{36}$/i.test(seller) ? seller : undefined;

  const [event, categories, accounts, holders, sales, pendingPayments, payments, activatedUnsold] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" }, select: { id: true, name: true } }),
    sellerAccounts(eventId),
    holdersOf(eventId),
    db.sale.findMany({
      where: { eventId, ...(sellerFilter ? { sellerId: sellerFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { tickets: { include: { ticket: { select: { number: true, blockState: true, category: { select: { name: true } } } } } }, reversals: { select: { id: true } } },
    }),
    db.payment.findMany({ where: { eventId, validatedAt: null, rejectedAt: null }, orderBy: { declaredAt: "asc" } }),
    db.payment.findMany({ where: { eventId, ...(sellerFilter ? { sellerId: sellerFilter } : {}) }, orderBy: { declaredAt: "desc" }, take: 50 }),
    db.ticket.count({ where: { eventId, activatedAt: { not: null }, commercialState: { not: "SOLD" }, blockState: "NONE" } }),
  ]);
  const name = await namesFor([...accounts.map((a) => a.sellerId), ...sales.flatMap((s) => [s.sellerId, s.createdById]), ...payments.flatMap((p) => [p.sellerId, p.declaredById, p.validatedById])]);
  const tz = event.timezone;
  const locked = event.status === "CLOSED" || event.status === "ARCHIVED";
  const total = accounts.reduce(
    (a, x) => ({ sold: a.sold + x.ticketsSold, net: a.net + x.netGnf, refunds: a.refunds + x.refundsGnf, paid: a.paid + x.paymentsValidatedGnf, balance: a.balance + x.balanceGnf }),
    { sold: 0, net: 0, refunds: 0, paid: 0, balance: 0 },
  );

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Billets vendus (déclarés)" value={total.sold.toLocaleString("fr-FR")} sub={`${activatedUnsold.toLocaleString("fr-FR")} activés sans vente déclarée`} />
        <Stat label="Recettes nettes déclarées" value={formatGnf(total.net)} sub={total.refunds ? `dont ${formatGnf(total.refunds)} remboursés` : undefined} />
        <Stat label="Versements validés" value={formatGnf(total.paid)} />
        <Stat label="Reste dû par les vendeurs" value={formatGnf(total.balance)} />
      </div>

      <Card title="Caisse par vendeur">
        <Table head={["Vendeur", "Billets vendus", "Ventes", "Corrections", "Remboursements", "Recettes nettes", "Versé (validé)", "En attente", "Solde dû", ""]} empty={accounts.length === 0}>
          {accounts.map((a) => (
            <tr key={a.sellerId}>
              <Td className="font-medium">{name(a.sellerId)}</Td>
              <Td>{a.ticketsSold}</Td>
              <Td>{formatGnf(a.salesGnf)}</Td>
              <Td>{a.correctionsGnf ? `−${formatGnf(a.correctionsGnf)}` : "—"}</Td>
              <Td>{a.refundsGnf ? `−${formatGnf(a.refundsGnf)}` : "—"}</Td>
              <Td className="font-semibold">{formatGnf(a.netGnf)}</Td>
              <Td>{formatGnf(a.paymentsValidatedGnf)}</Td>
              <Td>{a.paymentsPendingGnf ? <Badge color="orange">{formatGnf(a.paymentsPendingGnf)}</Badge> : "—"}</Td>
              <Td className="font-semibold">{formatGnf(a.balanceGnf)}</Td>
              <Td><a href={`?seller=${a.sellerId}`} className="text-blue-700 hover:underline">détail</a></Td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-slate-500">Recettes nettes = ventes − corrections − remboursements ; solde = recettes nettes − versements validés. Montants déclarés : ils ne prouvent pas l&apos;encaissement.</p>
      </Card>

      {canValidate && pendingPayments.length > 0 && (
        <Card title="Versements à valider">
          <div className="space-y-3">
            {pendingPayments.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm">
                <span className="grow">
                  <strong>{formatGnf(p.amountGnf)}</strong> de {name(p.sellerId)} · {PAYMENT_METHOD_LABELS[p.method]}{p.reference && ` · ${p.reference}`} · {formatDateTime(p.declaredAt, tz)}
                </span>
                <ActionForm action={resolvePaymentAction} submitLabel="Valider (fonds reçus)" className="flex items-center gap-2">
                  <input type="hidden" name="eventId" value={eventId} />
                  <input type="hidden" name="paymentId" value={p.id} />
                  <input type="hidden" name="decision" value="accept" />
                </ActionForm>
                <ActionForm action={resolvePaymentAction} submitLabel="Rejeter" className="flex items-center gap-2">
                  <input type="hidden" name="eventId" value={eventId} />
                  <input type="hidden" name="paymentId" value={p.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <input name="reason" placeholder="Motif du rejet" className="!mt-0 !w-44" />
                </ActionForm>
              </div>
            ))}
          </div>
        </Card>
      )}

      {canManage && !locked && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Enregistrer une vente pour un vendeur">
            {holders.length ? (
              <SaleForm
                eventId={eventId}
                sellers={holders.map((h) => ({ id: h.id, name: h.name }))}
                categories={categories}
                defaultSellerId={holders[0].id}
                canOverrideDiscount={access.can("sale.discount_override")}
                quoteAction={quoteSaleAction}
                saleAction={recordSaleAction}
                qrAction={qrToNumberAction}
              />
            ) : (
              <p className="text-sm text-slate-500">Aucun vendeur dans l&apos;équipe.</p>
            )}
          </Card>
          <Card title="Enregistrer un versement reçu">
            <ActionForm action={paymentAction} submitLabel="Enregistrer (validé)">
              <input type="hidden" name="eventId" value={eventId} />
              <Field label="Vendeur"><select name="sellerId">{holders.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Montant (GNF)"><input name="amountGnf" type="number" min={1} step={1} required /></Field>
                <Field label="Moyen"><select name="method">{Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              </div>
              <Field label="Référence"><input name="reference" /></Field>
            </ActionForm>
          </Card>
        </div>
      )}

      <Card title={sellerFilter ? `Ventes de ${name(sellerFilter)}` : "Journal des ventes"}>
        {sellerFilter && <a href="?" className="mb-3 inline-block text-sm text-blue-700 hover:underline">← Tous les vendeurs</a>}
        <Table head={["Date", "Vendeur", "Billets", "Facial", "Remise", "Montant", "Moyen", "Saisi par", ""]} empty={sales.length === 0}>
          {sales.map((s) => (
            <tr key={s.id} className={s.kind === "REVERSAL" ? "bg-orange-50/60" : ""}>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(s.soldAt, tz)}</Td>
              <Td>{name(s.sellerId)}</Td>
              <Td className="text-xs">
                {s.tickets.length} · {formatTicketRanges(s.tickets.map((t) => t.ticket), 5)}
                {s.kind === "REVERSAL" && (
                  <div className="mt-1"><Badge color="orange">{s.reversalType === "CANCELLATION" ? "Annulation" : "Correction de saisie"}</Badge> {s.reason}</div>
                )}
                {s.kind === "SALE" && s.reason && <div className="mt-1 text-slate-500">{s.reason}</div>}
              </Td>
              <Td>{formatGnf(s.faceValueGnf)}</Td>
              <Td>{s.discountGnf ? formatGnf(s.discountGnf) : "—"}</Td>
              <Td className={`font-medium ${s.totalGnf < 0 ? "text-red-700" : ""}`}>{formatGnf(s.totalGnf)}</Td>
              <Td className="text-xs">{PAYMENT_METHOD_LABELS[s.paymentMethod]}{s.paymentRef && ` · ${s.paymentRef}`}</Td>
              <Td className="text-xs">{name(s.createdById)}</Td>
              <Td>
                {canManage && !locked && s.kind === "SALE" && (
                  <details>
                    <summary className="cursor-pointer text-sm text-blue-700">Corriger</summary>
                    <div className="mt-2 w-80">
                      <ActionForm action={reverseSaleAction} submitLabel="Passer la contre-écriture" className="space-y-2">
                        <input type="hidden" name="eventId" value={eventId} />
                        <input type="hidden" name="saleId" value={s.id} />
                        <Field label="Type">
                          <select name="type">
                            <option value="ENTRY_ERROR">Erreur de saisie (billets rendus au vendeur)</option>
                            <option value="CANCELLATION">Annulation (billets bloqués)</option>
                          </select>
                        </Field>
                        <Field label="Billets concernés" hint="Vide = tous les billets de la vente."><input name="numbers" /></Field>
                        <Field label="Remboursement déclaré (annulation)"><input name="refundGnf" type="number" min={0} step={1} defaultValue={0} /></Field>
                        <Field label="Motif"><input name="reason" required /></Field>
                      </ActionForm>
                    </div>
                  </details>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Versements">
        <Table head={["Date", "Vendeur", "Montant", "Moyen", "Déclaré par", "État"]} empty={payments.length === 0}>
          {payments.map((p) => (
            <tr key={p.id}>
              <Td className="text-xs">{formatDateTime(p.declaredAt, tz)}</Td>
              <Td>{name(p.sellerId)}</Td>
              <Td>{formatGnf(p.amountGnf)}</Td>
              <Td className="text-xs">{PAYMENT_METHOD_LABELS[p.method]}{p.reference && ` · ${p.reference}`}</Td>
              <Td className="text-xs">{name(p.declaredById)}</Td>
              <Td className="text-xs">
                {p.rejectedAt ? <Badge color="red">Rejeté : {p.rejectReason}</Badge> : p.validatedAt ? <Badge color="green">Validé par {name(p.validatedById)}</Badge> : <Badge color="orange">En attente</Badge>}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
