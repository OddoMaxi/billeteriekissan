import "server-only";
import type { BlockState, MovementKind, PaymentMethod, Prisma, ReversalType, Ticket } from "@prisma/client";
import { audit } from "./audit";
import { sha256 } from "./crypto";
import { db } from "./db";
import { formatNumber } from "./numbering";
import { can, type Actor } from "./permissions";
import { formatRanges, formatTicketRanges } from "./ticket-numbers";

// Stock physique et ventes (section 6).
// Chaque opération : une transaction, des mises à jour conditionnelles (l'état attendu est
// revérifié au moment d'écrire, donc deux opérations concurrentes ne peuvent pas porter sur le
// même billet), un contrôle du nombre de billets modifiés, et une trace d'audit.
// Une vente n'est jamais déduite de l'impression ni de la remise d'un lot.

type Tx = Prisma.TransactionClient;

export class StockError extends Error {}

const TX = { timeout: 60_000, maxWait: 15_000 } as const;

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function authorize(actor: Actor, ok: boolean, message = "Opération non autorisée pour votre rôle.") {
  if (!ok) throw new StockError(message);
}

async function openEvent(tx: Tx, eventId: string) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
  if (event.status === "CLOSED" || event.status === "ARCHIVED") {
    throw new StockError("Événement terminé : plus aucune opération de stock ni de vente.");
  }
  return event;
}

/**
 * Billets d'une catégorie pour ces numéros (chaque catégorie a sa propre numérotation) ;
 * erreur si la catégorie n'est pas celle de l'événement ou si des numéros n'existent pas.
 */
async function ticketsFor(tx: Tx, eventId: string, categoryId: string, numbers: number[]) {
  if (numbers.length === 0) throw new StockError("Aucun numéro saisi.");
  const category = await tx.category.findFirst({ where: { id: categoryId, eventId } });
  if (!category) throw new StockError("Choisissez la catégorie des billets.");
  const tickets = await tx.ticket.findMany({
    where: { eventId, categoryId, number: { in: numbers } },
    include: { category: true },
    orderBy: { number: "asc" },
  });
  if (tickets.length !== numbers.length) {
    const found = new Set(tickets.map((t) => t.number));
    throw new StockError(`Numéros inexistants en ${category.name} : ${formatRanges(numbers.filter((n) => !found.has(n)))}.`);
  }
  return tickets;
}

/** « VIP 001–010 » pour les messages et le journal. */
const labelOf = (tickets: { number: number; category: { name: string } }[], max = 50) => formatTicketRanges(tickets, max);

/** Refuse l'opération si des billets ne remplissent pas la condition, en les nommant. */
function expectAll<T extends Pick<Ticket, "number">>(tickets: T[], ok: (t: T) => boolean, problem: string) {
  const bad = tickets.filter((t) => !ok(t));
  if (bad.length) throw new StockError(`${problem} : ${formatRanges(bad.map((t) => t.number))}.`);
}

/** Vérifie qu'une mise à jour conditionnelle a bien touché tous les billets attendus. */
function expectCount(actual: number, expected: number) {
  if (actual !== expected) {
    throw new StockError("Des billets ont été modifiés par une autre opération pendant la vôtre : recommencez.");
  }
}

const usable = (t: Ticket) => t.blockState === "NONE";
const notPending = (t: Ticket) => t.pendingMovementId === null;

async function createMovement(
  tx: Tx,
  data: {
    eventId: string;
    kind: MovementKind;
    status?: "PENDING" | "CONFIRMED";
    fromUserId: string | null;
    toUserId: string | null;
    ticketIds: string[];
    reason?: string | null;
    actorId: string;
  },
) {
  const m = await tx.stockMovement.create({
    data: {
      eventId: data.eventId,
      kind: data.kind,
      status: data.status ?? "CONFIRMED",
      fromUserId: data.fromUserId,
      toUserId: data.toUserId,
      quantity: data.ticketIds.length,
      reason: data.reason || null,
      createdById: data.actorId,
      ...(data.status === "PENDING" ? {} : { resolvedAt: new Date(), resolvedById: data.actorId }),
    },
  });
  await tx.stockMovementTicket.createMany({ data: data.ticketIds.map((ticketId) => ({ movementId: m.id, ticketId })) });
  return m;
}

/** Détenteurs possibles : membres actifs de l'événement pouvant détenir des billets. */
async function assertHolder(tx: Tx, eventId: string, userId: string) {
  const memberships = await tx.eventMembership.findMany({
    where: { eventId, userId, revokedAt: null, role: { in: ["SELLER", "TICKET_MANAGER", "ORGANIZER"] }, user: { status: "ACTIVE" } },
  });
  if (memberships.length === 0) throw new StockError("Le destinataire n'est pas vendeur, gestionnaire ou organisateur actif de l'événement.");
}

// ─── Remises et retours ──────────────────────────────────────────────────────

/**
 * Remise de billets à un détenteur, depuis le stock central (fromHolderId = null) ou un autre
 * détenteur. Les billets sont en attente jusqu'à l'accusé de réception du destinataire.
 */
export async function assignTickets(p: {
  eventId: string;
  actor: Actor;
  fromHolderId: string | null;
  toUserId: string;
  categoryId: string;
  numbers: number[];
  reason?: string;
}) {
  authorize(p.actor, can(p.actor, "stock.assign"));
  if (p.fromHolderId === p.toUserId) throw new StockError("Le destinataire détient déjà ces billets.");
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    await assertHolder(tx, p.eventId, p.toUserId);
    const tickets = await ticketsFor(tx, p.eventId, p.categoryId, p.numbers);
    expectAll(tickets, (t) => t.holderId === p.fromHolderId, "Billets non détenus par la source choisie");
    expectAll(tickets, usable, "Billets annulés, perdus ou détruits");
    expectAll(tickets, (t) => t.commercialState !== "SOLD", "Billets déjà vendus");
    expectAll(tickets, notPending, "Billets déjà en attente de réception");

    // Remise à soi-même : réception immédiate.
    const selfReceipt = p.toUserId === p.actor.id;
    const ids = tickets.map((t) => t.id);
    const m = await createMovement(tx, {
      eventId: p.eventId,
      kind: "ASSIGN",
      status: selfReceipt ? "CONFIRMED" : "PENDING",
      fromUserId: p.fromHolderId,
      toUserId: p.toUserId,
      ticketIds: ids,
      reason: p.reason,
      actorId: p.actor.id,
    });
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, holderId: p.fromHolderId, blockState: "NONE", pendingMovementId: null, commercialState: { not: "SOLD" } },
      data: { holderId: p.toUserId, commercialState: "ASSIGNED", pendingMovementId: selfReceipt ? null : m.id },
    });
    expectCount(r.count, ids.length);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: "stock.assign",
      objectType: "StockMovement",
      objectId: m.id,
      after: { from: p.fromHolderId ?? "stock central", to: p.toUserId, quantity: ids.length, numbers: labelOf(tickets) },
    });
    return m;
  }, TX);
}

/**
 * Retour vers le stock central. À l'initiative du détenteur (restitution) : en attente de
 * confirmation par l'organisation. Enregistré par l'organisation : immédiat.
 */
export async function returnTickets(p: { eventId: string; actor: Actor; fromHolderId: string; categoryId: string; numbers: number[]; reason?: string }) {
  const byHolder = p.fromHolderId === p.actor.id;
  authorize(p.actor, byHolder ? can(p.actor, "stock.own") : can(p.actor, "stock.assign"));
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    const tickets = await ticketsFor(tx, p.eventId, p.categoryId, p.numbers);
    expectAll(tickets, (t) => t.holderId === p.fromHolderId, "Billets non détenus par ce détenteur");
    expectAll(tickets, usable, "Billets annulés, perdus ou détruits");
    expectAll(tickets, (t) => t.commercialState !== "SOLD", "Billets vendus (une vente se corrige par contre-écriture)");
    expectAll(tickets, notPending, "Billets en attente de réception");

    const pending = byHolder && !can(p.actor, "stock.assign");
    const ids = tickets.map((t) => t.id);
    const m = await createMovement(tx, {
      eventId: p.eventId,
      kind: "RETURN",
      status: pending ? "PENDING" : "CONFIRMED",
      fromUserId: p.fromHolderId,
      toUserId: null,
      ticketIds: ids,
      reason: p.reason,
      actorId: p.actor.id,
    });
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, holderId: p.fromHolderId, blockState: "NONE", pendingMovementId: null, commercialState: { not: "SOLD" } },
      data: { holderId: null, commercialState: "IN_STOCK", pendingMovementId: pending ? m.id : null },
    });
    expectCount(r.count, ids.length);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: "stock.return",
      objectType: "StockMovement",
      objectId: m.id,
      after: { from: p.fromHolderId, quantity: ids.length, numbers: labelOf(tickets), pending },
    });
    return m;
  }, TX);
}

/** Accusé de réception : le destinataire (ou l'organisation pour un retour) confirme. */
export async function confirmMovement(p: { movementId: string; actor: Actor }) {
  return db.$transaction(async (tx) => {
    const m = await tx.stockMovement.findUniqueOrThrow({ where: { id: p.movementId } });
    if (m.status !== "PENDING") throw new StockError("Ce mouvement n'est plus en attente.");
    const isRecipient = m.toUserId !== null ? m.toUserId === p.actor.id : can(p.actor, "stock.assign") && m.fromUserId !== p.actor.id;
    authorize(p.actor, isRecipient || p.actor.isAdmin, "Seul le destinataire peut confirmer la réception.");
    await tx.stockMovement.update({ where: { id: m.id }, data: { status: "CONFIRMED", resolvedAt: new Date(), resolvedById: p.actor.id } });
    const r = await tx.ticket.updateMany({ where: { pendingMovementId: m.id }, data: { pendingMovementId: null } });
    expectCount(r.count, m.quantity);
    await audit(tx, { actorId: p.actor.id, eventId: m.eventId, action: "stock.confirm", objectType: "StockMovement", objectId: m.id, after: { quantity: m.quantity } });
    return m;
  }, TX);
}

/**
 * Refus (incident déclaré par le destinataire) ou annulation par l'émetteur :
 * les billets reviennent à l'émetteur, le motif est conservé.
 */
export async function refuseMovement(p: { movementId: string; actor: Actor; incident: string }) {
  if (p.incident.trim().length < 3) throw new StockError("Indiquez le motif (écart de comptage, erreur de destinataire…).");
  return db.$transaction(async (tx) => {
    const m = await tx.stockMovement.findUniqueOrThrow({ where: { id: p.movementId } });
    if (m.status !== "PENDING") throw new StockError("Ce mouvement n'est plus en attente.");
    const isRecipient = m.toUserId !== null ? m.toUserId === p.actor.id : can(p.actor, "stock.assign");
    const isSender = m.createdById === p.actor.id;
    authorize(p.actor, isRecipient || isSender || can(p.actor, "stock.assign"));
    await tx.stockMovement.update({
      where: { id: m.id },
      data: { status: "REFUSED", resolvedAt: new Date(), resolvedById: p.actor.id, incident: p.incident.trim() },
    });
    const r = await tx.ticket.updateMany({
      where: { pendingMovementId: m.id },
      data: { holderId: m.fromUserId, commercialState: m.fromUserId ? "ASSIGNED" : "IN_STOCK", pendingMovementId: null },
    });
    expectCount(r.count, m.quantity);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: m.eventId,
      action: "stock.refuse",
      objectType: "StockMovement",
      objectId: m.id,
      context: { incident: p.incident.trim(), by: isRecipient ? "destinataire" : "émetteur" },
    });
    return m;
  }, TX);
}

// ─── Pertes, dommages, annulations ───────────────────────────────────────────

const INCIDENT_STATE: Record<"LOSS" | "DAMAGE" | "CANCEL", BlockState> = { LOSS: "LOST", DAMAGE: "DESTROYED", CANCEL: "CANCELLED" };

/** Billets non vendus perdus, endommagés ou annulés : bloqués définitivement, numéros jamais réattribués. */
export async function declareIncident(p: {
  eventId: string;
  actor: Actor;
  kind: "LOSS" | "DAMAGE" | "CANCEL";
  categoryId: string;
  numbers: number[];
  reason: string;
}) {
  authorize(p.actor, can(p.actor, "stock.assign"));
  if (p.reason.trim().length < 3) throw new StockError("Indiquez le motif.");
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    const tickets = await ticketsFor(tx, p.eventId, p.categoryId, p.numbers);
    expectAll(tickets, usable, "Billets déjà annulés, perdus ou détruits");
    expectAll(tickets, (t) => t.commercialState !== "SOLD", "Billets vendus : annulez la vente ou remplacez le billet");
    expectAll(tickets, notPending, "Billets en attente de réception");
    expectAll(tickets, (t) => t.entryState === "NOT_USED", "Billets déjà utilisés à l'entrée");

    // Un mouvement par détenteur, pour l'historique et le rapprochement.
    const byHolder = new Map<string | null, string[]>();
    for (const t of tickets) byHolder.set(t.holderId, [...(byHolder.get(t.holderId) ?? []), t.id]);
    for (const [holderId, ids] of byHolder) {
      await createMovement(tx, { eventId: p.eventId, kind: p.kind, fromUserId: holderId, toUserId: holderId, ticketIds: ids, reason: p.reason, actorId: p.actor.id });
    }
    const ids = tickets.map((t) => t.id);
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, blockState: "NONE", commercialState: { not: "SOLD" }, pendingMovementId: null, entryState: "NOT_USED" },
      data: { blockState: INCIDENT_STATE[p.kind] },
    });
    expectCount(r.count, ids.length);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: `stock.${p.kind.toLowerCase()}`,
      objectType: "Ticket",
      after: { numbers: labelOf(tickets), quantity: ids.length },
      context: { reason: p.reason },
    });
  }, TX);
}

// ─── Activation ──────────────────────────────────────────────────────────────

/**
 * Activation (ventes trop rapides pour être saisies billet par billet) : le billet devient
 * valable au contrôle sans vente déclarée. « Activé » reste distinct de « vendu » dans les rapports.
 */
export async function setActivation(p: {
  eventId: string;
  actor: Actor;
  categoryId: string;
  numbers: number[];
  active: boolean;
  reason?: string;
  /** Activation d'un lot entier : ignore les billets déjà activés ou bloqués au lieu de refuser. */
  onlyEligible?: boolean;
}): Promise<{ changed: number; skipped: number }> {
  authorize(p.actor, can(p.actor, "stock.assign"));
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    const all = await ticketsFor(tx, p.eventId, p.categoryId, p.numbers);
    const tickets = p.onlyEligible && p.active ? all.filter((t) => usable(t) && t.activatedAt === null) : all;
    if (tickets.length === 0) throw new StockError("Aucun billet à activer.");
    expectAll(tickets, usable, "Billets annulés, perdus ou détruits");
    if (p.active) expectAll(tickets, (t) => t.activatedAt === null, "Billets déjà activés");
    else {
      expectAll(tickets, (t) => t.activatedAt !== null, "Billets non activés");
      expectAll(tickets, (t) => t.entryState === "NOT_USED", "Billets déjà utilisés à l'entrée");
    }
    const ids = tickets.map((t) => t.id);
    await createMovement(tx, {
      eventId: p.eventId,
      kind: p.active ? "ACTIVATE" : "DEACTIVATE",
      fromUserId: null,
      toUserId: null,
      ticketIds: ids,
      reason: p.reason,
      actorId: p.actor.id,
    });
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, blockState: "NONE", activatedAt: p.active ? null : { not: null } },
      data: p.active ? { activatedAt: new Date(), activatedById: p.actor.id } : { activatedAt: null, activatedById: null },
    });
    expectCount(r.count, ids.length);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: p.active ? "stock.activate" : "stock.deactivate",
      objectType: "Ticket",
      after: { numbers: labelOf(tickets), quantity: ids.length },
      context: p.reason ? { reason: p.reason } : undefined,
    });
    return { changed: ids.length, skipped: all.length - ids.length };
  }, TX);
}

// ─── Ventes ──────────────────────────────────────────────────────────────────

export type SaleQuote = { quantity: number; faceValueGnf: number; maxDiscountGnf: number; ranges: string };

/** Contrôle et chiffrage d'une vente avant confirmation (aucune écriture). */
export async function quoteSale(p: { eventId: string; actor: Actor; sellerId: string; categoryId: string; numbers: number[] }): Promise<SaleQuote> {
  return db.$transaction(async (tx) => {
    const tickets = await saleTickets(tx, p);
    return {
      quantity: tickets.length,
      faceValueGnf: tickets.reduce((s, t) => s + t.category.priceGnf, 0),
      maxDiscountGnf: tickets.reduce((s, t) => s + t.category.maxDiscountGnf, 0),
      ranges: labelOf(tickets, 12),
    };
  });
}

async function saleTickets(tx: Tx, p: { eventId: string; actor: Actor; sellerId: string; categoryId: string; numbers: number[] }) {
  const own = p.sellerId === p.actor.id;
  authorize(p.actor, own ? can(p.actor, "stock.own") : can(p.actor, "sale.manage"), "Vous ne pouvez enregistrer que vos propres ventes.");
  await openEvent(tx, p.eventId);
  const tickets = await ticketsFor(tx, p.eventId, p.categoryId, p.numbers);
  expectAll(tickets, (t) => t.holderId === p.sellerId, "Billets non détenus par ce vendeur");
  expectAll(tickets, notPending, "Billets dont la réception n'est pas encore confirmée");
  expectAll(tickets, usable, "Billets annulés, perdus ou détruits");
  expectAll(tickets, (t) => t.commercialState !== "SOLD", "Billets déjà vendus");
  expectAll(tickets, (t) => t.entryState === "NOT_USED", "Billets déjà utilisés à l'entrée");
  return tickets;
}

/** Vente déclarée : numéros effectivement vendus, prix facial, remise autorisée, moyen déclaré. */
export async function recordSale(p: {
  eventId: string;
  actor: Actor;
  sellerId: string;
  categoryId: string;
  numbers: number[];
  discountGnf: number;
  paymentMethod: PaymentMethod;
  paymentRef?: string;
  reason?: string;
}) {
  if (!Number.isInteger(p.discountGnf) || p.discountGnf < 0) throw new StockError("Remise invalide.");
  return db.$transaction(async (tx) => {
    const tickets = await saleTickets(tx, p);
    const face = tickets.reduce((s, t) => s + t.category.priceGnf, 0);
    const maxDiscount = tickets.reduce((s, t) => s + t.category.maxDiscountGnf, 0);
    if (p.discountGnf > face) throw new StockError("La remise dépasse le prix des billets.");
    if (p.discountGnf > maxDiscount && !can(p.actor, "sale.discount_override")) {
      throw new StockError(`Remise supérieure au maximum autorisé (${maxDiscount.toLocaleString("fr-FR")} GNF pour ces billets).`);
    }
    if (p.discountGnf > 0 && p.discountGnf > maxDiscount && !p.reason?.trim()) {
      throw new StockError("Indiquez le motif de la remise exceptionnelle.");
    }
    const now = new Date();
    const sale = await tx.sale.create({
      data: {
        eventId: p.eventId,
        kind: "SALE",
        sellerId: p.sellerId,
        faceValueGnf: face,
        discountGnf: p.discountGnf,
        totalGnf: face - p.discountGnf,
        paymentMethod: p.paymentMethod,
        paymentRef: p.paymentRef?.trim() || null,
        soldAt: now,
        reason: p.reason?.trim() || null,
        createdById: p.actor.id,
        tickets: { create: tickets.map((t) => ({ ticketId: t.id, priceGnf: t.category.priceGnf })) },
      },
    });
    const ids = tickets.map((t) => t.id);
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, holderId: p.sellerId, pendingMovementId: null, blockState: "NONE", commercialState: "ASSIGNED", entryState: "NOT_USED" },
      data: { commercialState: "SOLD", soldAt: now, sellerId: p.sellerId },
    });
    expectCount(r.count, ids.length);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: "sale.create",
      objectType: "Sale",
      objectId: sale.id,
      after: { seller: p.sellerId, quantity: ids.length, numbers: labelOf(tickets), total: sale.totalGnf, method: p.paymentMethod },
    });
    return sale;
  }, TX);
}

/**
 * Contre-écriture d'une vente (jamais de suppression) :
 * - ENTRY_ERROR : erreur de saisie, les billets reviennent dans le stock du vendeur ;
 * - CANCELLATION : annulation, billets bloqués (refusés au contrôle), remboursement déclaré éventuel.
 * Partielle possible (une partie des billets de la vente).
 */
export async function reverseSale(p: {
  saleId: string;
  actor: Actor;
  numbers?: number[];
  type: ReversalType;
  refundGnf?: number;
  reason: string;
}) {
  authorize(p.actor, can(p.actor, "sale.manage"), "Seuls l'organisateur et le gestionnaire corrigent une vente.");
  if (p.reason.trim().length < 3) throw new StockError("Indiquez le motif de la correction.");
  return db.$transaction(async (tx) => {
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: p.saleId },
      include: { tickets: { include: { ticket: { include: { category: true } } } }, reversals: { include: { tickets: true } } },
    });
    if (sale.kind !== "SALE") throw new StockError("Seule une vente peut être contre-passée.");
    await openEvent(tx, sale.eventId);
    const reversed = new Set(sale.reversals.flatMap((r) => r.tickets.map((l) => l.ticketId)));
    // Sans liste : tous les billets encore valides de la vente (un billet remplacé, déjà bloqué, est ignoré).
    const lines = sale.tickets.filter(
      (l) => !reversed.has(l.ticketId) && (p.numbers ? p.numbers.includes(l.ticket.number) : l.ticket.blockState === "NONE"),
    );
    if (p.numbers) {
      const inSale = new Set(lines.map((l) => l.ticket.number));
      const outside = p.numbers.filter((n) => !inSale.has(n));
      if (outside.length) throw new StockError(`Billets absents de cette vente ou déjà corrigés : ${formatRanges(outside)}.`);
    }
    if (lines.length === 0) throw new StockError("Tous les billets de cette vente sont déjà corrigés.");
    const tickets = lines.map((l) => l.ticket);
    expectAll(tickets, (t) => t.commercialState === "SOLD" && t.blockState === "NONE", "Billets qui ne sont plus vendus et valides");
    expectAll(tickets, (t) => t.entryState === "NOT_USED", "Billets déjà utilisés à l'entrée : l'admission ne s'annule pas");

    const lineFace = lines.reduce((s, l) => s + l.priceGnf, 0);
    // Part du montant encaissé correspondant à ces billets (remise répartie au prorata).
    const share = sale.faceValueGnf === 0 ? 0 : Math.round((sale.totalGnf * lineFace) / sale.faceValueGnf);
    let total: number;
    if (p.type === "ENTRY_ERROR") total = -share;
    else {
      const refund = p.refundGnf ?? 0;
      if (!Number.isInteger(refund) || refund < 0 || refund > share) {
        throw new StockError(`Remboursement invalide (0 à ${share.toLocaleString("fr-FR")} GNF).`);
      }
      total = -refund;
    }

    const reversal = await tx.sale.create({
      data: {
        eventId: sale.eventId,
        kind: "REVERSAL",
        sellerId: sale.sellerId,
        faceValueGnf: -lineFace,
        discountGnf: -lineFace - total,
        totalGnf: total,
        paymentMethod: sale.paymentMethod,
        soldAt: new Date(),
        reversalOfId: sale.id,
        reversalType: p.type,
        reason: p.reason.trim(),
        createdById: p.actor.id,
        tickets: { create: lines.map((l) => ({ ticketId: l.ticketId, priceGnf: -l.priceGnf })) },
      },
    });
    const ids = tickets.map((t) => t.id);
    const r = await tx.ticket.updateMany({
      where: { id: { in: ids }, commercialState: "SOLD", blockState: "NONE", entryState: "NOT_USED" },
      data: p.type === "ENTRY_ERROR" ? { commercialState: "ASSIGNED", soldAt: null, sellerId: null } : { blockState: "CANCELLED" },
    });
    expectCount(r.count, ids.length);
    if (p.type === "CANCELLATION") {
      await createMovement(tx, { eventId: sale.eventId, kind: "CANCEL", fromUserId: null, toUserId: null, ticketIds: ids, reason: p.reason, actorId: p.actor.id });
    }
    await audit(tx, {
      actorId: p.actor.id,
      eventId: sale.eventId,
      action: p.type === "ENTRY_ERROR" ? "sale.correct" : "sale.cancel",
      objectType: "Sale",
      objectId: reversal.id,
      before: { saleId: sale.id, total: sale.totalGnf },
      after: { numbers: labelOf(lines.map((l) => ({ number: l.ticket.number, category: { name: l.ticket.category.name } }))), total },
      context: { reason: p.reason.trim() },
    });
    return reversal;
  }, TX);
}

/**
 * Remplacement d'un billet vendu perdu ou endommagé par un billet non vendu de la même catégorie.
 * L'ancien est bloqué ; le nouveau est rattaché à la même vente, sans nouvel encaissement.
 */
export async function replaceTicket(p: {
  eventId: string;
  actor: Actor;
  /** Catégorie commune au billet remplacé et au billet de remplacement. */
  categoryId: string;
  oldNumber: number;
  newNumber: number;
  oldState: "LOST" | "DESTROYED";
  reason: string;
}) {
  authorize(p.actor, can(p.actor, "stock.assign"));
  if (p.reason.trim().length < 3) throw new StockError("Indiquez le motif.");
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    const [a, b] = await Promise.all([ticketsFor(tx, p.eventId, p.categoryId, [p.oldNumber]), ticketsFor(tx, p.eventId, p.categoryId, [p.newNumber])]);
    const oldT = a[0];
    const newT = b[0];
    const cat = oldT.category.name;
    if (oldT.commercialState !== "SOLD" || oldT.blockState !== "NONE") throw new StockError(`Le billet ${cat} ${formatNumber(p.oldNumber)} n'est pas un billet vendu valide.`);
    if (oldT.entryState !== "NOT_USED") throw new StockError(`Le billet ${cat} ${formatNumber(p.oldNumber)} a déjà servi à l'entrée.`);
    if (newT.commercialState === "SOLD" || newT.blockState !== "NONE" || newT.pendingMovementId) {
      throw new StockError(`Le billet ${cat} ${formatNumber(p.newNumber)} n'est pas disponible (vendu, bloqué ou en attente).`);
    }
    const line = await tx.saleTicket.findFirst({ where: { ticketId: oldT.id, sale: { kind: "SALE" } }, orderBy: { sale: { createdAt: "desc" } } });
    if (!line) throw new StockError("Vente d'origine introuvable.");

    const r1 = await tx.ticket.updateMany({ where: { id: oldT.id, blockState: "NONE", commercialState: "SOLD" }, data: { blockState: p.oldState } });
    const r2 = await tx.ticket.updateMany({
      where: { id: newT.id, blockState: "NONE", commercialState: { not: "SOLD" }, pendingMovementId: null },
      data: { commercialState: "SOLD", soldAt: new Date(), sellerId: oldT.sellerId },
    });
    expectCount(r1.count + r2.count, 2);
    // Rattachement à la vente d'origine, sans montant : aucun encaissement supplémentaire.
    await tx.saleTicket.create({ data: { saleId: line.saleId, ticketId: newT.id, priceGnf: 0 } });
    const reason = `${cat} ${formatNumber(p.oldNumber)} remplacé par ${formatNumber(p.newNumber)} : ${p.reason.trim()}`;
    await createMovement(tx, { eventId: p.eventId, kind: "REPLACE", fromUserId: newT.holderId, toUserId: oldT.sellerId, ticketIds: [oldT.id, newT.id], reason, actorId: p.actor.id });
    await audit(tx, {
      actorId: p.actor.id,
      eventId: p.eventId,
      action: "stock.replace",
      objectType: "Ticket",
      objectId: oldT.id,
      after: { category: cat, old: formatNumber(p.oldNumber), oldState: p.oldState, new: formatNumber(p.newNumber), saleId: line.saleId },
      context: { reason: p.reason.trim() },
    });
  }, TX);
}

// ─── Versements ──────────────────────────────────────────────────────────────

/**
 * Versement d'un vendeur. Déclaré par le vendeur : en attente de validation.
 * Enregistré par l'organisation (qui reçoit l'argent) : validé immédiatement.
 */
export async function recordPayment(p: {
  eventId: string;
  actor: Actor;
  sellerId: string;
  amountGnf: number;
  method: PaymentMethod;
  reference?: string;
  note?: string;
}) {
  const own = p.sellerId === p.actor.id;
  const validator = can(p.actor, "payment.validate");
  authorize(p.actor, own ? can(p.actor, "stock.own") : validator);
  if (!Number.isInteger(p.amountGnf) || p.amountGnf <= 0) throw new StockError("Montant invalide.");
  return db.$transaction(async (tx) => {
    await openEvent(tx, p.eventId);
    const autoValidate = validator && !own;
    const pay = await tx.payment.create({
      data: {
        eventId: p.eventId,
        sellerId: p.sellerId,
        amountGnf: p.amountGnf,
        method: p.method,
        reference: p.reference?.trim() || null,
        note: p.note?.trim() || null,
        declaredById: p.actor.id,
        ...(autoValidate ? { validatedAt: new Date(), validatedById: p.actor.id } : {}),
      },
    });
    await audit(tx, { actorId: p.actor.id, eventId: p.eventId, action: "payment.declare", objectType: "Payment", objectId: pay.id, after: pay });
    return pay;
  }, TX);
}

/** Validation ou rejet d'un versement déclaré, par une autre personne que le déclarant. */
export async function resolvePayment(p: { paymentId: string; actor: Actor; accept: boolean; reason?: string }) {
  authorize(p.actor, can(p.actor, "payment.validate"));
  return db.$transaction(async (tx) => {
    const pay = await tx.payment.findUniqueOrThrow({ where: { id: p.paymentId } });
    if (pay.validatedAt || pay.rejectedAt) throw new StockError("Versement déjà traité.");
    if (pay.declaredById === p.actor.id && !p.actor.isAdmin) throw new StockError("Un versement est validé par une autre personne que son déclarant.");
    if (!p.accept && !p.reason?.trim()) throw new StockError("Indiquez le motif du rejet.");
    const r = await tx.payment.updateMany({
      where: { id: pay.id, validatedAt: null, rejectedAt: null },
      data: p.accept ? { validatedAt: new Date(), validatedById: p.actor.id } : { rejectedAt: new Date(), rejectReason: p.reason!.trim(), validatedById: p.actor.id },
    });
    expectCount(r.count, 1);
    await audit(tx, {
      actorId: p.actor.id,
      eventId: pay.eventId,
      action: p.accept ? "payment.validate" : "payment.reject",
      objectType: "Payment",
      objectId: pay.id,
      context: p.reason ? { reason: p.reason } : undefined,
    });
  }, TX);
}

// ─── Inventaire ──────────────────────────────────────────────────────────────

const inHandWhere = (eventId: string, holderId: string | null): Prisma.TicketWhereInput => ({
  eventId,
  holderId,
  pendingMovementId: null,
  blockState: "NONE",
  commercialState: { not: "SOLD" },
});

/** Comptage physique (fin de journée) rapproché du stock attendu ; l'écart est enregistré, jamais corrigé. */
export async function recordStockCount(p: { eventId: string; actor: Actor; holderId: string | null; counted: number; note?: string }) {
  authorize(p.actor, can(p.actor, "stock.assign") || (p.holderId === p.actor.id && can(p.actor, "stock.own")));
  if (!Number.isInteger(p.counted) || p.counted < 0) throw new StockError("Nombre compté invalide.");
  return db.$transaction(async (tx) => {
    const expected = await tx.ticket.count({ where: inHandWhere(p.eventId, p.holderId) });
    const c = await tx.stockCount.create({
      data: { eventId: p.eventId, holderId: p.holderId, expected, counted: p.counted, note: p.note?.trim() || null, createdById: p.actor.id },
    });
    await audit(tx, { actorId: p.actor.id, eventId: p.eventId, action: "stock.count", objectType: "StockCount", objectId: c.id, after: c });
    return c;
  }, TX);
}

// ─── Consultation ────────────────────────────────────────────────────────────

export type HolderSummary = {
  holderId: string | null;
  inHand: number;
  pendingIn: number;
  soldFromHand: number;
  blockedInHand: number;
  received: number;
  given: number;
  /** received − given − soldFromHand − blockedInHand ; doit égaler inHand. */
  expected: number;
  gap: number;
};

/**
 * Stock par détenteur et rapprochement (section 8) : ce que les mouvements disent qu'il devrait
 * détenir, comparé à ce que l'état des billets dit qu'il détient. Tout écart est signalé.
 */
export async function holderSummaries(eventId: string): Promise<HolderSummary[]> {
  const [states, movementsIn, movementsOut, generated] = await Promise.all([
    db.ticket.groupBy({
      by: ["holderId", "commercialState", "blockState"],
      where: { eventId },
      _count: true,
    }),
    db.stockMovement.groupBy({
      by: ["toUserId", "kind"],
      where: { eventId, status: "CONFIRMED", kind: { in: ["ASSIGN", "RETURN"] } },
      _sum: { quantity: true },
    }),
    db.stockMovement.groupBy({
      by: ["fromUserId", "kind"],
      where: { eventId, status: { in: ["PENDING", "CONFIRMED"] }, kind: { in: ["ASSIGN", "RETURN"] } },
      _sum: { quantity: true },
    }),
    db.ticket.count({ where: { eventId } }),
  ]);
  const pending = await db.ticket.groupBy({ by: ["holderId"], where: { eventId, pendingMovementId: { not: null } }, _count: true });

  const holders = new Set<string | null>([null]);
  states.forEach((s) => holders.add(s.holderId));
  movementsIn.forEach((m) => holders.add(m.toUserId));
  movementsOut.forEach((m) => holders.add(m.fromUserId));

  return [...holders].map((h) => {
    const mine = states.filter((s) => s.holderId === h);
    const pendingIn = pending.find((x) => x.holderId === h)?._count ?? 0;
    const unsoldUsable = mine.filter((s) => s.commercialState !== "SOLD" && s.blockState === "NONE").reduce((a, s) => a + s._count, 0);
    const inHand = unsoldUsable - pendingIn;
    const soldFromHand = mine.filter((s) => s.commercialState === "SOLD").reduce((a, s) => a + s._count, 0);
    const blockedInHand = mine.filter((s) => s.commercialState !== "SOLD" && s.blockState !== "NONE").reduce((a, s) => a + s._count, 0);
    const received = (h === null ? generated : 0) + movementsIn.filter((m) => m.toUserId === h).reduce((a, m) => a + (m._sum.quantity ?? 0), 0);
    const given = movementsOut.filter((m) => m.fromUserId === h).reduce((a, m) => a + (m._sum.quantity ?? 0), 0);
    const expected = received - given - soldFromHand - blockedInHand;
    return { holderId: h, inHand, pendingIn, soldFromHand, blockedInHand, received, given, expected, gap: inHand - expected };
  });
}

export type SellerAccount = {
  sellerId: string;
  ticketsSold: number;
  salesGnf: number;
  correctionsGnf: number;
  refundsGnf: number;
  netGnf: number;
  paymentsValidatedGnf: number;
  paymentsPendingGnf: number;
  balanceGnf: number;
};

/**
 * Caisse d'un vendeur (section 8) : recettes nettes déclarées = ventes − corrections − remboursements ;
 * solde = recettes nettes − versements validés. Montants déclarés, pas une preuve d'encaissement.
 */
export async function sellerAccounts(eventId: string, sellerId?: string): Promise<SellerAccount[]> {
  const where = { eventId, ...(sellerId ? { sellerId } : {}) };
  const [sales, payments, sold] = await Promise.all([
    db.sale.groupBy({ by: ["sellerId", "kind", "reversalType"], where, _sum: { totalGnf: true } }),
    db.payment.groupBy({ by: ["sellerId", "validatedAt", "rejectedAt"], where, _sum: { amountGnf: true } }),
    db.ticket.groupBy({ by: ["sellerId"], where: { ...where, commercialState: "SOLD", blockState: "NONE" }, _count: true }),
  ]);
  const ids = new Set<string>();
  sales.forEach((s) => ids.add(s.sellerId));
  payments.forEach((p) => ids.add(p.sellerId));
  if (sellerId) ids.add(sellerId);

  return [...ids].map((id) => {
    const sum = (f: (s: (typeof sales)[number]) => boolean) => sales.filter((s) => s.sellerId === id && f(s)).reduce((a, s) => a + (s._sum.totalGnf ?? 0), 0);
    const salesGnf = sum((s) => s.kind === "SALE");
    const correctionsGnf = -sum((s) => s.reversalType === "ENTRY_ERROR") || 0;
    const refundsGnf = -sum((s) => s.reversalType === "CANCELLATION") || 0;
    const netGnf = salesGnf - correctionsGnf - refundsGnf;
    const mine = payments.filter((p) => p.sellerId === id);
    const paymentsValidatedGnf = mine.filter((p) => p.validatedAt && !p.rejectedAt).reduce((a, p) => a + (p._sum.amountGnf ?? 0), 0);
    const paymentsPendingGnf = mine.filter((p) => !p.validatedAt && !p.rejectedAt).reduce((a, p) => a + (p._sum.amountGnf ?? 0), 0);
    return {
      sellerId: id,
      ticketsSold: sold.find((s) => s.sellerId === id)?._count ?? 0,
      salesGnf,
      correctionsGnf,
      refundsGnf,
      netGnf,
      paymentsValidatedGnf,
      paymentsPendingGnf,
      balanceGnf: netGnf - paymentsValidatedGnf,
    };
  });
}

/**
 * Recherche de billets par numéro (« 012 », ou « VIP 012 » pour préciser la catégorie) ou par contenu QR,
 * avec leur historique. Un numéro seul peut exister dans plusieurs catégories : toutes les correspondances
 * sont renvoyées. Ne consomme jamais le billet.
 */
export async function findTickets(eventId: string, query: string) {
  const where = await ticketQuery(eventId, query);
  if (!where) return [];
  const tickets = await db.ticket.findMany({ where, include: { category: true, batch: true }, orderBy: [{ category: { priceGnf: "desc" } }], take: 20 });
  return Promise.all(
    tickets.map(async (ticket) => {
      const [movements, saleLines, scans] = await Promise.all([
        db.stockMovementTicket.findMany({ where: { ticketId: ticket.id }, include: { movement: true }, orderBy: { movement: { createdAt: "asc" } } }),
        db.saleTicket.findMany({ where: { ticketId: ticket.id }, include: { sale: true }, orderBy: { sale: { createdAt: "asc" } } }),
        db.scan.findMany({ where: { ticketId: ticket.id }, orderBy: { serverTime: "asc" } }),
      ]);
      return { ticket, movements: movements.map((m) => m.movement), saleLines, scans };
    }),
  );
}

/** Interprète « 012 », « VIP 012 » ou une valeur QR ; null si la catégorie citée n'existe pas. */
export async function ticketQuery(eventId: string, query: string): Promise<Prisma.TicketWhereInput | null> {
  const q = query.trim();
  const numberOnly = /^\d{1,7}$/.exec(q);
  if (numberOnly) return { eventId, number: Number(q) };
  const withCategory = /^(.+?)\s+(\d{1,7})$/.exec(q);
  if (withCategory) {
    const category = await db.category.findFirst({ where: { eventId, name: { equals: withCategory[1].trim(), mode: "insensitive" } } });
    return category ? { eventId, categoryId: category.id, number: Number(withCategory[2]) } : null;
  }
  return { eventId, qrHash: sha256(q) };
}
