import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { holderSummaries, type HolderSummary } from "./stock";

// Tableaux de bord et rapprochements (section 8).
// Les états de billets sont un instantané ; les flux (ventes, versements, entrées) suivent la période choisie.
// Les montants sont déclarés : ils ne prouvent pas l'encaissement. Les écarts sont signalés, jamais corrigés.

export type Period = { from?: Date; to?: Date };

const inPeriod = (p: Period) => (p.from || p.to ? { ...(p.from ? { gte: p.from } : {}), ...(p.to ? { lte: p.to } : {}) } : undefined);

export type CategoryRow = {
  categoryId: string;
  name: string;
  priceGnf: number;
  quota: number;
  generated: number;
  printed: number;
  inStock: number;
  withHolders: number;
  activated: number;
  activatedNotSold: number;
  sold: number;
  returned: number;
  cancelled: number;
  lost: number;
  destroyed: number;
  used: number;
  usedWithoutSale: number;
  soldNotUsed: number;
  /** Prix facial × billets vendus valides. */
  theoreticalGnf: number;
};

export type MoneyRow = {
  sellerId: string;
  salesCount: number;
  ticketsSold: number;
  faceGnf: number;
  discountGnf: number;
  salesGnf: number;
  correctionsGnf: number;
  refundsGnf: number;
  netGnf: number;
  paymentsValidatedGnf: number;
  paymentsPendingGnf: number;
  balanceGnf: number;
};

export type Anomaly = { level: "error" | "warning" | "info"; message: string };

export type EventReport = Awaited<ReturnType<typeof eventReport>>;

export async function eventReport(eventId: string, period: Period = {}) {
  const generatedAt = new Date();
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { organization: true } });
  const saleDate = inPeriod(period);

  // Billets vendus nets par vendeur : lignes de vente (+1) moins lignes de contre-écriture (−1) ;
  // les billets de remplacement (prix 0) ne comptent pas.
  const [categories, states, printed, activated, returned, sales, saleTickets, payments, holders, entries, byHour, scanReasons, incidentsOpen, exceptions, counts] =
    await Promise.all([
      db.category.findMany({ where: { eventId }, orderBy: { priceGnf: "desc" } }),
      db.ticket.groupBy({ by: ["categoryId", "commercialState", "blockState", "entryState"], where: { eventId }, _count: true }),
      db.ticket.groupBy({ by: ["categoryId"], where: { eventId, batch: { status: "READY" } }, _count: true }),
      db.ticket.groupBy({ by: ["categoryId", "commercialState"], where: { eventId, activatedAt: { not: null }, blockState: "NONE" }, _count: true }),
      db.$queryRaw<{ categoryId: string; n: bigint }[]>`
        SELECT t."categoryId", count(DISTINCT smt."ticketId") AS n
        FROM "StockMovementTicket" smt
        JOIN "StockMovement" m ON m.id = smt."movementId"
        JOIN "Ticket" t ON t.id = smt."ticketId"
        WHERE m."eventId" = ${eventId}::uuid AND m.kind = 'RETURN' AND m.status = 'CONFIRMED'
        GROUP BY t."categoryId"`,
      db.sale.groupBy({
        by: ["sellerId", "kind", "reversalType"],
        where: { eventId, ...(saleDate ? { soldAt: saleDate } : {}) },
        _sum: { totalGnf: true, faceValueGnf: true, discountGnf: true },
        _count: true,
      }),
      db.$queryRaw<{ sellerId: string; n: bigint }[]>`
        SELECT s."sellerId", sum(sign(st."priceGnf"))::bigint AS n FROM "SaleTicket" st JOIN "Sale" s ON s.id = st."saleId"
        WHERE s."eventId" = ${eventId}::uuid
          ${period.from ? Prisma.sql`AND s."soldAt" >= ${period.from}` : Prisma.empty}
          ${period.to ? Prisma.sql`AND s."soldAt" <= ${period.to}` : Prisma.empty}
        GROUP BY s."sellerId"`,
      db.payment.findMany({ where: { eventId, ...(saleDate ? { declaredAt: saleDate } : {}) }, select: { sellerId: true, amountGnf: true, validatedAt: true, rejectedAt: true } }),
      holderSummaries(eventId),
      db.scan.groupBy({
        by: ["gateId", "verdict"],
        where: { eventId, mode: "ENTRY", ...(saleDate ? { serverTime: saleDate } : {}) },
        _count: true,
      }),
      db.$queryRaw<{ hour: Date; n: bigint }[]>`
        SELECT date_trunc('hour', "serverTime" AT TIME ZONE 'UTC' AT TIME ZONE ${event.timezone}) AS hour, count(*) AS n
        FROM "Scan"
        WHERE "eventId" = ${eventId}::uuid AND verdict = 'VALID' AND mode = 'ENTRY'
          ${period.from ? Prisma.sql`AND "serverTime" >= ${period.from}` : Prisma.empty}
          ${period.to ? Prisma.sql`AND "serverTime" <= ${period.to}` : Prisma.empty}
        GROUP BY 1 ORDER BY 1`,
      db.scan.groupBy({ by: ["reason"], where: { eventId, verdict: { not: "VALID" }, ...(saleDate ? { serverTime: saleDate } : {}) }, _count: true }),
      db.gateIncident.count({ where: { eventId, resolvedAt: null } }),
      db.scan.count({ where: { eventId, exception: true, ...(saleDate ? { serverTime: saleDate } : {}) } }),
      db.stockCount.findMany({ where: { eventId }, orderBy: { createdAt: "desc" } }),
    ]);

  // ─── Billets par catégorie (instantané) ────────────────────────────────────
  const sum = (catId: string, f: (s: (typeof states)[number]) => boolean) =>
    states.filter((s) => s.categoryId === catId && f(s)).reduce((a, s) => a + s._count, 0);
  const perCategory: CategoryRow[] = categories.map((c) => {
    const sold = sum(c.id, (s) => s.commercialState === "SOLD" && s.blockState === "NONE");
    return {
      categoryId: c.id,
      name: c.name,
      priceGnf: c.priceGnf,
      quota: c.quota,
      generated: sum(c.id, () => true),
      printed: printed.find((p) => p.categoryId === c.id)?._count ?? 0,
      inStock: sum(c.id, (s) => s.commercialState === "IN_STOCK" && s.blockState === "NONE"),
      withHolders: sum(c.id, (s) => s.commercialState === "ASSIGNED" && s.blockState === "NONE"),
      activated: activated.filter((a) => a.categoryId === c.id).reduce((a, x) => a + x._count, 0),
      activatedNotSold: activated.filter((a) => a.categoryId === c.id && a.commercialState !== "SOLD").reduce((a, x) => a + x._count, 0),
      sold,
      returned: Number(returned.find((r) => r.categoryId === c.id)?.n ?? 0),
      cancelled: sum(c.id, (s) => s.blockState === "CANCELLED"),
      lost: sum(c.id, (s) => s.blockState === "LOST"),
      destroyed: sum(c.id, (s) => s.blockState === "DESTROYED"),
      used: sum(c.id, (s) => s.entryState === "USED"),
      usedWithoutSale: sum(c.id, (s) => s.entryState === "USED" && s.commercialState !== "SOLD"),
      soldNotUsed: sum(c.id, (s) => s.commercialState === "SOLD" && s.blockState === "NONE" && s.entryState === "NOT_USED"),
      theoreticalGnf: sold * c.priceGnf,
    };
  });
  const totals = perCategory.reduce(
    (t, r) => {
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
      return t;
    },
    { quota: 0, generated: 0, printed: 0, inStock: 0, withHolders: 0, activated: 0, activatedNotSold: 0, sold: 0, returned: 0, cancelled: 0, lost: 0, destroyed: 0, used: 0, usedWithoutSale: 0, soldNotUsed: 0, theoreticalGnf: 0 },
  );

  // ─── Argent par vendeur (période) ──────────────────────────────────────────
  const sellerIds = new Set<string>([...sales.map((s) => s.sellerId), ...payments.map((p) => p.sellerId)]);
  const money: MoneyRow[] = [...sellerIds].map((id) => {
    const mine = sales.filter((s) => s.sellerId === id);
    const pick = (f: (s: (typeof mine)[number]) => boolean, k: "totalGnf" | "faceValueGnf" | "discountGnf") =>
      mine.filter(f).reduce((a, s) => a + (s._sum[k] ?? 0), 0);
    const isSale = (s: (typeof mine)[number]) => s.kind === "SALE";
    const salesGnf = pick(isSale, "totalGnf");
    const correctionsGnf = -pick((s) => s.reversalType === "ENTRY_ERROR", "totalGnf") || 0;
    const refundsGnf = -pick((s) => s.reversalType === "CANCELLATION", "totalGnf") || 0;
    const netGnf = salesGnf - correctionsGnf - refundsGnf;
    const pays = payments.filter((p) => p.sellerId === id && !p.rejectedAt);
    const paymentsValidatedGnf = pays.filter((p) => p.validatedAt).reduce((a, p) => a + p.amountGnf, 0);
    return {
      sellerId: id,
      salesCount: mine.filter(isSale).reduce((a, s) => a + s._count, 0),
      ticketsSold: Number(saleTickets.find((t) => t.sellerId === id)?.n ?? 0),
      faceGnf: pick(isSale, "faceValueGnf"),
      discountGnf: pick(isSale, "discountGnf"),
      salesGnf,
      correctionsGnf,
      refundsGnf,
      netGnf,
      paymentsValidatedGnf,
      paymentsPendingGnf: pays.filter((p) => !p.validatedAt).reduce((a, p) => a + p.amountGnf, 0),
      balanceGnf: netGnf - paymentsValidatedGnf,
    };
  });
  const moneyTotals = money.reduce(
    (t, r) => {
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
      return t;
    },
    { salesCount: 0, ticketsSold: 0, faceGnf: 0, discountGnf: 0, salesGnf: 0, correctionsGnf: 0, refundsGnf: 0, netGnf: 0, paymentsValidatedGnf: 0, paymentsPendingGnf: 0, balanceGnf: 0 },
  );

  // ─── Écarts et points d'attention ──────────────────────────────────────────
  const anomalies: Anomaly[] = [];
  const stockGaps = holders.filter((h) => h.gap !== 0);
  for (const h of stockGaps) anomalies.push({ level: "error", message: `Écart de stock pour un détenteur : ${h.gap > 0 ? "+" : ""}${h.gap} billet(s) entre mouvements et état des billets.` });
  const latestCount = new Map<string | null, (typeof counts)[number]>();
  for (const c of counts) if (!latestCount.has(c.holderId)) latestCount.set(c.holderId, c);
  const countGaps = [...latestCount.values()].filter((c) => c.counted !== c.expected);
  if (countGaps.length) anomalies.push({ level: "warning", message: `${countGaps.length} comptage(s) physique(s) récent(s) en écart avec le stock attendu.` });
  const due = money.filter((m) => m.balanceGnf !== 0);
  if (due.length) anomalies.push({ level: "warning", message: `${due.length} vendeur(s) avec un solde non versé (total ${moneyTotals.balanceGnf.toLocaleString("fr-FR")} GNF).` });
  if (moneyTotals.paymentsPendingGnf) anomalies.push({ level: "warning", message: `${moneyTotals.paymentsPendingGnf.toLocaleString("fr-FR")} GNF de versements déclarés attendent une validation.` });
  if (moneyTotals.discountGnf) anomalies.push({ level: "info", message: `Remises accordées : ${moneyTotals.discountGnf.toLocaleString("fr-FR")} GNF (écart entre recettes théoriques et déclarées).` });
  if (incidentsOpen) anomalies.push({ level: "warning", message: `${incidentsOpen} incident(s) de porte non traité(s).` });
  if (exceptions) anomalies.push({ level: "info", message: `${exceptions} admission(s) par dérogation.` });
  if (totals.usedWithoutSale) anomalies.push({ level: "info", message: `${totals.usedWithoutSale} entrée(s) sur billets activés sans vente déclarée.` });
  if (event.status !== "OPEN" && totals.soldNotUsed) anomalies.push({ level: "info", message: `${totals.soldNotUsed} billet(s) vendu(s) non utilisé(s) (absents).` });

  return {
    generatedAt,
    period,
    event,
    perCategory,
    totals,
    money,
    moneyTotals,
    holders: holders as HolderSummary[],
    entries,
    byHour: byHour.map((h) => ({ hour: h.hour, count: Number(h.n) })),
    scanReasons,
    incidentsOpen,
    exceptions,
    anomalies,
  };
}

/** Synthèse de tous les événements visibles (tableau de bord global de l'administrateur). */
export async function globalSummary(eventIds: string[]) {
  if (eventIds.length === 0) return [];
  const [tickets, activated, sales, payments] = await Promise.all([
    db.ticket.groupBy({ by: ["eventId", "commercialState", "blockState", "entryState"], where: { eventId: { in: eventIds } }, _count: true }),
    db.ticket.groupBy({ by: ["eventId"], where: { eventId: { in: eventIds }, activatedAt: { not: null }, blockState: "NONE" }, _count: true }),
    db.sale.groupBy({ by: ["eventId"], where: { eventId: { in: eventIds } }, _sum: { totalGnf: true } }),
    db.payment.groupBy({ by: ["eventId"], where: { eventId: { in: eventIds }, validatedAt: { not: null }, rejectedAt: null }, _sum: { amountGnf: true } }),
  ]);
  return eventIds.map((id) => {
    const mine = tickets.filter((t) => t.eventId === id);
    const n = (f: (t: (typeof mine)[number]) => boolean) => mine.filter(f).reduce((a, t) => a + t._count, 0);
    const net = sales.find((s) => s.eventId === id)?._sum.totalGnf ?? 0;
    const paid = payments.find((p) => p.eventId === id)?._sum.amountGnf ?? 0;
    return {
      eventId: id,
      generated: n(() => true),
      sold: n((t) => t.commercialState === "SOLD" && t.blockState === "NONE"),
      activated: activated.find((a) => a.eventId === id)?._count ?? 0,
      used: n((t) => t.entryState === "USED"),
      netGnf: net,
      paidGnf: paid,
      balanceGnf: net - paid,
    };
  });
}
