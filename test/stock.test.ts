import type { EventRole } from "@prisma/client";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createBatch } from "@/lib/batches";
import { sha256Buffer } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/permissions";
import {
  assignTickets,
  confirmMovement,
  declareIncident,
  findTickets,
  holderSummaries,
  recordPayment,
  recordSale,
  recordStockCount,
  refuseMovement,
  replaceTicket,
  resolvePayment,
  returnTickets,
  reverseSale,
  sellerAccounts,
  setActivation,
  StockError,
} from "@/lib/stock";
import { saveFile } from "@/lib/storage";
import { DEFAULT_LAYOUT } from "@/lib/template-layout";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

let eventId: string;
let catId: string;
let orga: Actor, manager: Actor, seller1: Actor, seller2: Actor;

async function member(email: string, role: EventRole): Promise<Actor> {
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x" } });
  await db.eventMembership.create({ data: { userId: u.id, eventId, role } });
  return { id: u.id, isAdmin: false, roles: new Set([role]) };
}

/** Aucun écart de rapprochement, pour aucun détenteur. */
async function expectNoGap() {
  for (const h of await holderSummaries(eventId)) expect({ holder: h.holderId, gap: h.gap }).toEqual({ holder: h.holderId, gap: 0 });
}

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: "admin-stock@test", name: "Admin", passwordHash: "x", isAdmin: true } });
  const org = await db.organization.create({ data: { name: "Org stock" } });
  const event = await db.event.create({
    data: { organizationId: org.id, name: "Stock", venue: "Salle", doorsOpenAt: new Date(), startsAt: new Date(), endsAt: new Date(Date.now() + 864e5), status: "OPEN" },
  });
  eventId = event.id;
  const cat = await db.category.create({ data: { eventId, name: "Standard", priceGnf: 100_000, quota: 1000, maxDiscountGnf: 5_000 } });
  catId = cat.id;
  const bytes = readFileSync("public/gabarit/billet-demo.pdf");
  await saveFile("templates/stock/design.pdf", bytes);
  const tpl = await db.ticketTemplate.create({
    data: { eventId, name: "T", version: 1, backgroundPath: "templates/stock/design.pdf", backgroundMime: "application/pdf", backgroundSha256: sha256Buffer(bytes), layout: DEFAULT_LAYOUT, createdById: admin.id, batApprovedAt: new Date() },
  });
  const profile = await db.printProfile.create({ data: { name: "stock 5 mm" } });
  await createBatch({ eventId, categoryId: cat.id, templateId: tpl.id, printProfileId: profile.id, quantity: 300, layout: "SEQUENTIAL", actorId: admin.id });
  orga = await member("orga@stock", "ORGANIZER");
  manager = await member("gest@stock", "TICKET_MANAGER");
  seller1 = await member("v1@stock", "SELLER");
  seller2 = await member("v2@stock", "SELLER");
});

describe("R04 : remise de 100 billets, 60 vendus, 30 retournés, 10 perdus", () => {
  it("parcours complet, stock et caisse cohérents", async () => {
    const m = await assignTickets({ eventId, categoryId: catId, actor: manager, fromHolderId: null, toUserId: seller1.id, numbers: range(1, 100) });
    expect(m.status).toBe("PENDING");

    // Réception non confirmée : vente impossible.
    await expect(
      recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [1], discountGnf: 0, paymentMethod: "CASH" }),
    ).rejects.toThrow(/réception n'est pas encore confirmée/);
    // Seul le destinataire confirme.
    await expect(confirmMovement({ movementId: m.id, actor: seller2 })).rejects.toThrow(StockError);
    await confirmMovement({ movementId: m.id, actor: seller1 });

    const sale = await recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: range(1, 60), discountGnf: 0, paymentMethod: "CASH" });
    expect(sale.totalGnf).toBe(6_000_000);

    // Restitution par le vendeur : en attente, confirmée par l'organisation.
    const ret = await returnTickets({ eventId, categoryId: catId, actor: seller1, fromHolderId: seller1.id, numbers: range(61, 90), reason: "Invendus" });
    expect(ret.status).toBe("PENDING");
    await confirmMovement({ movementId: ret.id, actor: orga });

    await declareIncident({ eventId, categoryId: catId, actor: manager, kind: "LOSS", numbers: range(91, 100), reason: "Sacoche perdue" });

    const s1 = (await holderSummaries(eventId)).find((h) => h.holderId === seller1.id)!;
    expect(s1).toMatchObject({ received: 100, given: 30, soldFromHand: 60, blockedInHand: 10, inHand: 0, gap: 0 });
    await expectNoGap();

    const [acc] = await sellerAccounts(eventId, seller1.id);
    expect(acc).toMatchObject({ ticketsSold: 60, salesGnf: 6_000_000, netGnf: 6_000_000, balanceGnf: 6_000_000 });

    // Versement déclaré par le vendeur, validé par une autre personne.
    const pay = await recordPayment({ eventId, actor: seller1, sellerId: seller1.id, amountGnf: 4_000_000, method: "CASH" });
    expect((await sellerAccounts(eventId, seller1.id))[0]).toMatchObject({ paymentsPendingGnf: 4_000_000, balanceGnf: 6_000_000 });
    await expect(resolvePayment({ paymentId: pay.id, actor: seller1, accept: true })).rejects.toThrow(StockError);
    await resolvePayment({ paymentId: pay.id, actor: manager, accept: true });
    expect((await sellerAccounts(eventId, seller1.id))[0]).toMatchObject({ paymentsValidatedGnf: 4_000_000, balanceGnf: 2_000_000 });

    // Historique d'un billet vendu : remise, vente ; la consultation ne le consomme pas.
    const [h] = await findTickets(eventId, "005");
    expect(h?.movements.map((x) => x.kind)).toEqual(["ASSIGN"]);
    expect(h?.saleLines).toHaveLength(1);
    expect(h?.ticket.entryState).toBe("NOT_USED");
  });
});

describe("remises", () => {
  it("refus à la réception : les billets reviennent à l'émetteur", async () => {
    const m = await assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: null, toUserId: seller2.id, numbers: range(101, 120) });
    await expect(refuseMovement({ movementId: m.id, actor: seller2, incident: "" })).rejects.toThrow(/motif/);
    await refuseMovement({ movementId: m.id, actor: seller2, incident: "Reçu 19 billets au lieu de 20" });
    const t = await db.ticket.findMany({ where: { eventId, number: { in: range(101, 120) } } });
    expect(new Set(t.map((x) => `${x.holderId}/${x.commercialState}/${x.pendingMovementId}`))).toEqual(new Set(["null/IN_STOCK/null"]));
    await expectNoGap();
  });

  it("un vendeur ne remet pas de billets ; source incorrecte refusée", async () => {
    await expect(assignTickets({ eventId, categoryId: catId, actor: seller1, fromHolderId: null, toUserId: seller2.id, numbers: [121] })).rejects.toThrow(/non autorisée/);
    await expect(assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: seller2.id, toUserId: seller1.id, numbers: [121] })).rejects.toThrow(/non détenus/);
    await expect(assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: null, toUserId: seller1.id, numbers: [9999] })).rejects.toThrow(/inexistants/);
  });

  it("cession entre vendeurs via l'organisation", async () => {
    const a = await assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: null, toUserId: seller2.id, numbers: range(121, 130) });
    await confirmMovement({ movementId: a.id, actor: seller2 });
    const b = await assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: seller2.id, toUserId: seller1.id, numbers: range(121, 125), reason: "Cession" });
    await confirmMovement({ movementId: b.id, actor: seller1 });
    const s = await holderSummaries(eventId);
    expect(s.find((h) => h.holderId === seller2.id)?.inHand).toBe(5);
    await expectNoGap();
  });
});

describe("ventes", () => {
  it("remise plafonnée pour le vendeur, dérogation motivée pour le gestionnaire", async () => {
    await expect(
      recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [121], discountGnf: 6_000, paymentMethod: "CASH" }),
    ).rejects.toThrow(/maximum autorisé/);
    const ok = await recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [121], discountGnf: 5_000, paymentMethod: "TRANSFER", paymentRef: "OM-123" });
    expect(ok.totalGnf).toBe(95_000);
    await expect(
      recordSale({ eventId, categoryId: catId, actor: manager, sellerId: seller1.id, numbers: [122], discountGnf: 50_000, paymentMethod: "CASH" }),
    ).rejects.toThrow(/motif/);
    const exc = await recordSale({ eventId, categoryId: catId, actor: manager, sellerId: seller1.id, numbers: [122], discountGnf: 50_000, paymentMethod: "CASH", reason: "Invitation partenaire" });
    expect(exc.totalGnf).toBe(50_000);
  });

  it("un vendeur ne vend que ses billets", async () => {
    await expect(recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [126], discountGnf: 0, paymentMethod: "CASH" })).rejects.toThrow(/non détenus/);
    await expect(recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller2.id, numbers: [126], discountGnf: 0, paymentMethod: "CASH" })).rejects.toThrow(/propres ventes/);
  });

  it("deux ventes simultanées des mêmes billets : une seule réussit", async () => {
    const results = await Promise.allSettled([
      recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [123, 124], discountGnf: 0, paymentMethod: "CASH" }),
      recordSale({ eventId, categoryId: catId, actor: manager, sellerId: seller1.id, numbers: [124, 125], discountGnf: 0, paymentMethod: "CASH" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lines = await db.saleTicket.count({ where: { ticket: { eventId, number: 124 } } });
    expect(lines).toBe(1);
  });

  it("les ventes sont en ajout seul, même au niveau de la base", async () => {
    const s = await db.sale.findFirstOrThrow({ where: { eventId } });
    await expect(db.sale.update({ where: { id: s.id }, data: { totalGnf: 0 } })).rejects.toThrow(/ajout seul/);
    await expect(db.sale.delete({ where: { id: s.id } })).rejects.toThrow(/ajout seul/);
  });
});

describe("contre-écritures", () => {
  it("erreur de saisie partielle : billets rendus au vendeur, recettes corrigées", async () => {
    const before = (await sellerAccounts(eventId, seller1.id))[0];
    const sale = await db.sale.findFirstOrThrow({ where: { eventId, kind: "SALE", totalGnf: 6_000_000 } });
    await expect(reverseSale({ saleId: sale.id, actor: seller1, numbers: [59, 60], type: "ENTRY_ERROR", reason: "Erreur" })).rejects.toThrow(/organisateur/);
    const r = await reverseSale({ saleId: sale.id, actor: manager, numbers: [59, 60], type: "ENTRY_ERROR", reason: "Deux billets non vendus" });
    expect(r.totalGnf).toBe(-200_000);
    const t = await db.ticket.findMany({ where: { eventId, number: { in: [59, 60] } } });
    expect(t.every((x) => x.commercialState === "ASSIGNED" && x.holderId === seller1.id)).toBe(true);
    const after = (await sellerAccounts(eventId, seller1.id))[0];
    expect(after.netGnf).toBe(before.netGnf - 200_000);
    expect(after.correctionsGnf).toBe(200_000);
    await expect(reverseSale({ saleId: sale.id, actor: manager, numbers: [60], type: "ENTRY_ERROR", reason: "Encore" })).rejects.toThrow(/déjà corrigés/);
    await expectNoGap();
  });

  it("annulation avec remboursement : billet bloqué ; billet déjà utilisé : refus", async () => {
    const sale = await db.sale.findFirstOrThrow({ where: { eventId, kind: "SALE", totalGnf: 6_000_000 } });
    await expect(reverseSale({ saleId: sale.id, actor: manager, numbers: [58], type: "CANCELLATION", refundGnf: 200_000, reason: "Client" })).rejects.toThrow(/Remboursement invalide/);
    await reverseSale({ saleId: sale.id, actor: manager, numbers: [58], type: "CANCELLATION", refundGnf: 100_000, reason: "Client malade" });
    expect((await db.ticket.findFirstOrThrow({ where: { eventId, number: 58 } })).blockState).toBe("CANCELLED");
    expect((await sellerAccounts(eventId, seller1.id))[0].refundsGnf).toBe(100_000);

    await db.ticket.updateMany({ where: { eventId, number: 57 }, data: { entryState: "USED" } });
    await expect(reverseSale({ saleId: sale.id, actor: manager, numbers: [57], type: "CANCELLATION", reason: "Trop tard" })).rejects.toThrow(/utilisés/);
    await expectNoGap();
  });
});

describe("remplacement, activation, inventaire", () => {
  it("billet vendu perdu remplacé par un billet de même catégorie", async () => {
    await replaceTicket({ eventId, categoryId: catId, actor: manager, oldNumber: 10, newNumber: 61, oldState: "LOST", reason: "Perdu par l'acheteur" });
    const [old, repl] = await Promise.all([
      db.ticket.findFirstOrThrow({ where: { eventId, number: 10 } }),
      db.ticket.findFirstOrThrow({ where: { eventId, number: 61 } }),
    ]);
    expect(old.blockState).toBe("LOST");
    expect(repl).toMatchObject({ commercialState: "SOLD", sellerId: seller1.id });
    await expect(replaceTicket({ eventId, categoryId: catId, actor: manager, oldNumber: 10, newNumber: 62, oldState: "LOST", reason: "Encore" })).rejects.toThrow(/pas un billet vendu/);
    await expectNoGap();
  });

  it("activation et désactivation d'une plage, distinctes de la vente", async () => {
    await setActivation({ eventId, categoryId: catId, actor: orga, numbers: range(200, 210), active: true, reason: "Guichet rapide" });
    const t = await db.ticket.findMany({ where: { eventId, number: { in: range(200, 210) } } });
    expect(t.every((x) => x.activatedAt && x.commercialState === "IN_STOCK")).toBe(true);
    await expect(setActivation({ eventId, categoryId: catId, actor: orga, numbers: [200], active: true })).rejects.toThrow(/déjà activés/);
    await setActivation({ eventId, categoryId: catId, actor: orga, numbers: [210], active: false });
    // Lot entier : les billets déjà activés sont ignorés au lieu de bloquer l'opération.
    const r = await setActivation({ eventId, categoryId: catId, actor: orga, numbers: range(200, 215), active: true, onlyEligible: true });
    expect(r).toEqual({ changed: 6, skipped: 10 });
    await expect(setActivation({ eventId, categoryId: catId, actor: seller1, numbers: [211], active: true })).rejects.toThrow(/non autorisée/);
  });

  it("inventaire : l'écart est enregistré, pas corrigé", async () => {
    const inHand = (await holderSummaries(eventId)).find((h) => h.holderId === seller1.id)!.inHand;
    expect(inHand).toBeGreaterThanOrEqual(2); // dont 59 et 60, rendus par la correction
    const c = await recordStockCount({ eventId, actor: seller1, holderId: seller1.id, counted: inHand - 1, note: "Fin de journée" });
    expect(c.expected).toBe(inHand);
    expect(c.counted - c.expected).toBe(-1);
    await expect(recordStockCount({ eventId, actor: seller1, holderId: seller2.id, counted: 0 })).rejects.toThrow(/non autorisée/);
  });

  it("événement terminé : plus aucune opération", async () => {
    await db.event.update({ where: { id: eventId }, data: { status: "CLOSED" } });
    await expect(recordSale({ eventId, categoryId: catId, actor: seller1, sellerId: seller1.id, numbers: [59], discountGnf: 0, paymentMethod: "CASH" })).rejects.toThrow(/terminé/);
    await db.event.update({ where: { id: eventId }, data: { status: "OPEN" } });
  });
});
