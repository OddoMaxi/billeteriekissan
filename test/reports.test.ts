import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { createBatch } from "@/lib/batches";
import { decryptSecret, sha256Buffer } from "@/lib/crypto";
import { db } from "@/lib/db";
import { buildTable, closingPdf, toCsv, toXlsx, type ExportMeta } from "@/lib/exports";
import type { Actor } from "@/lib/permissions";
import { eventReport } from "@/lib/reports";
import { processScan } from "@/lib/scan";
import { assignTickets, confirmMovement, declareIncident, recordPayment, recordSale, resolvePayment, returnTickets, reverseSale, setActivation } from "@/lib/stock";
import { saveFile } from "@/lib/storage";
import { DEFAULT_LAYOUT } from "@/lib/template-layout";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
let eventId: string;
let catId: string;
let gateId: string;
let orga: Actor, seller: Actor;

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: "admin-rep@test", name: "Admin", passwordHash: "x", isAdmin: true } });
  const org = await db.organization.create({ data: { name: "Org rapports" } });
  const ev = await db.event.create({
    data: { organizationId: org.id, name: "Rapports", venue: "Salle", doorsOpenAt: new Date(), startsAt: new Date(), endsAt: new Date(Date.now() + 864e5), status: "OPEN" },
  });
  eventId = ev.id;
  gateId = (await db.gate.create({ data: { eventId, name: "Entrée" } })).id;
  const cat = await db.category.create({ data: { eventId, name: "Standard", priceGnf: 100_000, quota: 500, maxDiscountGnf: 10_000 } });
  catId = cat.id;
  const bytes = readFileSync("public/gabarit/billet-demo.pdf");
  await saveFile("templates/rep/design.pdf", bytes);
  const tpl = await db.ticketTemplate.create({
    data: { eventId, name: "T", version: 1, backgroundPath: "templates/rep/design.pdf", backgroundMime: "application/pdf", backgroundSha256: sha256Buffer(bytes), layout: DEFAULT_LAYOUT, createdById: admin.id, batApprovedAt: new Date() },
  });
  const profile = await db.printProfile.create({ data: { name: "rep 5 mm" } });
  await createBatch({ eventId, categoryId: cat.id, templateId: tpl.id, printProfileId: profile.id, quantity: 200, layout: "SEQUENTIAL", actorId: admin.id });

  const u = async (email: string, role: "ORGANIZER" | "SELLER" | "CONTROLLER") => {
    const x = await db.user.create({ data: { email, name: email, passwordHash: "x" } });
    await db.eventMembership.create({ data: { userId: x.id, eventId, role } });
    return { id: x.id, isAdmin: false, roles: new Set([role]) } as Actor;
  };
  orga = await u("orga@rep", "ORGANIZER");
  seller = await u("v@rep", "SELLER");
  const ctrl = await u("c@rep", "CONTROLLER");

  // 100 remis ; 50 vendus (remise 20 000) ; correction de 5 ; annulation de 1 remboursée 50 000 ;
  // 20 retournés ; 3 perdus ; 10 activés au central ; versement 3 000 000 validé ; 30 entrées.
  const m = await assignTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: null, toUserId: seller.id, numbers: range(1, 100) });
  await confirmMovement({ movementId: m.id, actor: seller });
  const sale = await recordSale({ eventId, categoryId: catId, actor: seller, sellerId: seller.id, numbers: range(1, 50), discountGnf: 20_000, paymentMethod: "CASH" });
  await reverseSale({ saleId: sale.id, actor: orga, numbers: range(46, 50), type: "ENTRY_ERROR", reason: "Non vendus" });
  await reverseSale({ saleId: sale.id, actor: orga, numbers: [45], type: "CANCELLATION", refundGnf: 50_000, reason: "Client" });
  await returnTickets({ eventId, categoryId: catId, actor: orga, fromHolderId: seller.id, numbers: range(81, 100), reason: "Invendus" });
  await declareIncident({ eventId, categoryId: catId, actor: orga, kind: "LOSS", numbers: range(78, 80), reason: "Perdus" });
  await setActivation({ eventId, categoryId: catId, actor: orga, numbers: range(191, 200), active: true });
  const pay = await recordPayment({ eventId, actor: seller, sellerId: seller.id, amountGnf: 3_000_000, method: "CASH" });
  await resolvePayment({ paymentId: pay.id, actor: orga, accept: true });
  await recordPayment({ eventId, actor: seller, sellerId: seller.id, amountGnf: 500_000, method: "TRANSFER" });

  const controller = { ...ctrl, controllerGateIds: null };
  for (const n of [...range(1, 28), 191, 192]) {
    const t = await db.ticket.findFirstOrThrow({ where: { eventId, number: n } });
    await processScan({ eventId, gateId, controller, value: decryptSecret(t.qrSecretEnc), operationId: randomUUID() });
  }
});

describe("R08 : rapprochement et rapport de clôture", () => {
  it("indicateurs par catégorie", async () => {
    const r = await eventReport(eventId);
    expect(r.totals).toMatchObject({
      generated: 200,
      printed: 0, // lot non rendu dans ce test
      sold: 44, // 50 − 5 corrigés − 1 annulé
      cancelled: 1,
      lost: 3,
      returned: 20,
      activated: 10,
      activatedNotSold: 10,
      used: 30,
      usedWithoutSale: 2,
      soldNotUsed: 16,
      withHolders: 100 - 50 + 5 - 20 - 3, // 32 billets encore chez le vendeur
      inStock: 200 - 100 + 20,
      theoreticalGnf: 4_400_000,
    });
  });

  it("recettes : ventes − corrections − remboursements, versements validés, solde", async () => {
    const { moneyTotals: m, money } = await eventReport(eventId);
    // Vente : 5 000 000 − 20 000 = 4 980 000 ; correction de 5 billets = 5/50 × 4 980 000 = 498 000.
    expect(m).toMatchObject({
      faceGnf: 5_000_000,
      discountGnf: 20_000,
      salesGnf: 4_980_000,
      correctionsGnf: 498_000,
      refundsGnf: 50_000,
      netGnf: 4_432_000,
      paymentsValidatedGnf: 3_000_000,
      paymentsPendingGnf: 500_000,
      balanceGnf: 1_432_000,
    });
    expect(money[0].ticketsSold).toBe(44);
  });

  it("aucun écart de stock ; un écart provoqué est signalé", async () => {
    let r = await eventReport(eventId);
    expect(r.anomalies.filter((a) => a.level === "error")).toEqual([]);
    expect(r.anomalies.map((a) => a.message).join()).toMatch(/solde non versé/);
    expect(r.anomalies.map((a) => a.message).join()).toMatch(/attendent une validation/);

    // Modification hors application : le billet 150 « change de détenteur » sans mouvement.
    await db.ticket.updateMany({ where: { eventId, number: 150 }, data: { holderId: seller.id, commercialState: "ASSIGNED" } });
    r = await eventReport(eventId);
    expect(r.anomalies.filter((a) => a.level === "error").length).toBeGreaterThanOrEqual(1);
    await db.ticket.updateMany({ where: { eventId, number: 150 }, data: { holderId: null, commercialState: "IN_STOCK" } });
  });

  it("période : les flux hors période sont exclus", async () => {
    const future = await eventReport(eventId, { from: new Date(Date.now() + 864e5) });
    expect(future.moneyTotals.netGnf).toBe(0);
    expect(future.byHour).toEqual([]);
    expect(future.totals.sold).toBe(44); // l'état des billets reste un instantané
  });
});

describe("exports", () => {
  const meta = (): ExportMeta => ({ eventName: "Rapports", author: "Auditeur Test", generatedAt: new Date(), period: {}, timezone: "Africa/Conakry" });

  it("CSV compatible Excel : BOM, séparateur ;, ligne d'identification", async () => {
    const csv = toCsv(await buildTable("sales", eventId, "Africa/Conakry", {}), meta());
    expect(csv.startsWith("﻿Ventes — Rapports")).toBe(true);
    expect(csv).toMatch(/par Auditeur Test/);
    const lines = csv.trim().split("\r\n");
    expect(lines[1].split(";")[0]).toBe("Date");
    expect(lines).toHaveLength(2 + 3); // vente + 2 contre-écritures
    const tickets = toCsv(await buildTable("tickets", eventId, "Africa/Conakry", {}), meta());
    expect(tickets.trim().split("\r\n")).toHaveLength(2 + 200);
  });

  it("XLSX : synthèse et un onglet par table", async () => {
    const r = await eventReport(eventId);
    const tables = await Promise.all((["tickets", "sales", "payments", "scans", "movements"] as const).map((k) => buildTable(k, eventId, "Africa/Conakry", {})));
    const buf = await toXlsx(r, tables, meta(), () => "Vendeur");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Synthèse", "Billets", "Ventes", "Versements", "Contrôle", "Mouvements"]);
    expect(wb.getWorksheet("Billets")!.rowCount).toBe(2 + 200);
    expect(wb.getWorksheet("Contrôle")!.rowCount).toBe(2 + 30);
  });

  it("PDF de clôture lisible", async () => {
    const r = await eventReport(eventId);
    const pdf = await closingPdf(r, meta(), () => "Vendeur é", () => "Entrée");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toMatch(/Rapport de clôture/);
  });
});
