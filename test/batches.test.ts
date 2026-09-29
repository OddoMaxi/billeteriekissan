import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BatchError,
  countPdfPages,
  createBatch,
  loadBatchPdf,
  renderBatch,
  reprintBatch,
  requeueBatch,
  type BatchRequest,
} from "@/lib/batches";
import { decryptSecret, sha256, sha256Buffer } from "@/lib/crypto";
import { db } from "@/lib/db";
import { saveFile } from "@/lib/storage";
import { DEFAULT_LAYOUT } from "@/lib/template-layout";

let base: Omit<BatchRequest, "quantity">;
let vipId: string;

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: "admin@test", name: "Admin", passwordHash: "x", isAdmin: true } });
  const org = await db.organization.create({ data: { name: "Org" } });
  const event = await db.event.create({
    data: {
      organizationId: org.id,
      name: "Concert",
      venue: "Salle",
      doorsOpenAt: new Date("2026-12-31T18:00Z"),
      startsAt: new Date("2026-12-31T20:00Z"),
      endsAt: new Date("2027-01-01T02:00Z"),
    },
  });
  const standard = await db.category.create({ data: { eventId: event.id, name: "Standard", priceGnf: 100000, quota: 20000 } });
  const vip = await db.category.create({ data: { eventId: event.id, name: "VIP", priceGnf: 500000, quota: 150 } });
  vipId = vip.id;
  const path = "templates/test/design.pdf";
  const bytes = readFileSync("public/gabarit/billet-demo.pdf");
  await saveFile(path, bytes);
  const template = await db.ticketTemplate.create({
    data: {
      eventId: event.id,
      name: "Standard",
      version: 1,
      backgroundPath: path,
      backgroundMime: "application/pdf",
      backgroundSha256: sha256Buffer(bytes),
      widthMm: 210,
      heightMm: 59.4,
      layout: DEFAULT_LAYOUT,
      createdById: admin.id,
      batApprovedAt: new Date(),
    },
  });
  const profile = await db.printProfile.create({ data: { name: "5 mm" } });
  base = {
    eventId: event.id,
    categoryId: standard.id,
    templateId: template.id,
    printProfileId: profile.id,
    layout: "SEQUENTIAL",
    actorId: admin.id,
  };
});

describe("génération des lots", () => {
  it("R15 : deux lots successifs 0001–0100 puis 0101–0200, QR indépendants", async () => {
    const a = await createBatch({ ...base, quantity: 100 });
    const b = await createBatch({ ...base, quantity: 100 });
    expect([a.firstNumber, a.lastNumber]).toEqual([1, 100]);
    expect([b.firstNumber, b.lastNumber]).toEqual([101, 200]);
    const tickets = await db.ticket.findMany({ where: { batchId: { in: [a.id, b.id] } } });
    expect(tickets).toHaveLength(200);
    expect(new Set(tickets.map((t) => t.qrHash)).size).toBe(200);
    expect(new Set(tickets.map((t) => t.number)).size).toBe(200);
    // La valeur QR n'est pas dérivable du numéro : chaque valeur chiffrée redonne son empreinte.
    for (const t of tickets.slice(0, 10)) expect(sha256(decryptSecret(t.qrSecretEnc))).toBe(t.qrHash);
  });

  it("générations simultanées : plages disjointes et continues", async () => {
    const before = (await db.category.findUniqueOrThrow({ where: { id: base.categoryId } })).nextNumber;
    const batches = await Promise.all(Array.from({ length: 6 }, () => createBatch({ ...base, quantity: 50 })));
    const ranges = batches.map((b) => [b.firstNumber, b.lastNumber]).sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i][1] - ranges[i][0] + 1).toBe(50);
      expect(ranges[i][0]).toBe(before + i * 50);
    }
    const numbers = await db.ticket.findMany({ where: { batchId: { in: batches.map((b) => b.id) } }, select: { number: true } });
    expect(new Set(numbers.map((n) => n.number)).size).toBe(300);
  });

  it("chaque catégorie a sa propre numérotation, à partir de 001", async () => {
    const vip = await createBatch({ ...base, categoryId: vipId, quantity: 20 });
    expect([vip.firstNumber, vip.lastNumber]).toEqual([1, 20]);
    const vip2 = await createBatch({ ...base, categoryId: vipId, quantity: 5 });
    expect([vip2.firstNumber, vip2.lastNumber]).toEqual([21, 25]);
    // Le même numéro existe dans deux catégories, avec des QR différents.
    const both = await db.ticket.findMany({ where: { eventId: base.eventId, number: 1 } });
    expect(both).toHaveLength(2);
    expect(both[0].qrHash).not.toBe(both[1].qrHash);
  });

  it("générations simultanées dans deux catégories : chacune reste continue", async () => {
    const [s0, v0] = await Promise.all([base.categoryId, vipId].map(async (id) => (await db.category.findUniqueOrThrow({ where: { id } })).nextNumber));
    const res = await Promise.all([
      createBatch({ ...base, quantity: 10 }),
      createBatch({ ...base, categoryId: vipId, quantity: 10 }),
      createBatch({ ...base, quantity: 10 }),
      createBatch({ ...base, categoryId: vipId, quantity: 10 }),
    ]);
    const std = res.filter((b) => b.categoryId === base.categoryId).map((b) => b.firstNumber).sort((a, b) => a - b);
    const vip = res.filter((b) => b.categoryId === vipId).map((b) => b.firstNumber).sort((a, b) => a - b);
    expect(std).toEqual([s0, s0 + 10]);
    expect(vip).toEqual([v0, v0 + 10]);
  });

  it("refus : quota dépassé, sans consommer de numéros", async () => {
    const before = (await db.category.findUniqueOrThrow({ where: { id: vipId } })).nextNumber;
    await expect(createBatch({ ...base, categoryId: vipId, quantity: 200 })).rejects.toThrow(/Quota dépassé/);
    const after = (await db.category.findUniqueOrThrow({ where: { id: vipId } })).nextNumber;
    expect(after).toBe(before);
  });

  it("refus : design à l'ancien format 210 × 74,25 (il serait réduit)", async () => {
    const t = await db.ticketTemplate.findUniqueOrThrow({ where: { id: base.templateId } });
    const old = await db.ticketTemplate.create({
      data: { ...t, id: undefined, name: "Ancien", heightMm: 74.25, layout: DEFAULT_LAYOUT, createdAt: undefined },
    });
    await expect(createBatch({ ...base, templateId: old.id, quantity: 5 })).rejects.toThrow(/5 tickets par A4/);
  });

  it("refus : BAT non validé, événement terminé", async () => {
    const t = await db.ticketTemplate.findUniqueOrThrow({ where: { id: base.templateId } });
    const draft = await db.ticketTemplate.create({
      data: { ...t, id: undefined, version: 2, batApprovedAt: null, layout: DEFAULT_LAYOUT, createdAt: undefined },
    });
    await expect(createBatch({ ...base, templateId: draft.id, quantity: 4 })).rejects.toThrow(BatchError);
    await db.event.update({ where: { id: base.eventId }, data: { status: "CLOSED" } });
    await expect(createBatch({ ...base, quantity: 4 })).rejects.toThrow(/terminé/);
    await db.event.update({ where: { id: base.eventId }, data: { status: "DRAFT" } });
  });
});

describe("rendu PDF", () => {
  it("R10 (5 par page) : 1 000 tickets → 200 pages A4, réimpression identique octet pour octet (R02)", async () => {
    const batch = await createBatch({ ...base, quantity: 1000 });
    expect(batch.ticketsPerPage).toBe(5);
    const ready = await renderBatch(batch.id);
    expect(ready.status).toBe("READY");
    expect(ready.pageCount).toBe(200);
    const pdf = await loadBatchPdf(ready);
    expect(await countPdfPages(pdf)).toBe(200);
    expect(sha256Buffer(pdf)).toBe(ready.pdfSha256);
    const { bytes } = await reprintBatch(batch.id, base.actorId, "Bourrage imprimante");
    expect(sha256Buffer(bytes)).toBe(ready.pdfSha256);
    expect(await db.ticket.count({ where: { batchId: batch.id } })).toBe(1000);
  });

  it("R11 (5 par page) : 1 002 tickets → 201 pages, aucun billet supplémentaire", async () => {
    const batch = await createBatch({ ...base, quantity: 1002 });
    const ready = await renderBatch(batch.id);
    expect(ready.pageCount).toBe(201);
    expect(await countPdfPages(await loadBatchPdf(ready))).toBe(201);
    expect(await db.ticket.count({ where: { batchId: batch.id } })).toBe(1002);
  });

  it("R14 : interruption puis relance, mêmes billets, aucun PDF partiel", async () => {
    const batch = await createBatch({ ...base, quantity: 40 });
    const before = await db.ticket.findMany({ where: { batchId: batch.id }, orderBy: { number: "asc" } });
    await expect(renderBatch(batch.id, { failAfterPages: 3 })).rejects.toThrow(/Interruption/);
    const failed = await db.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.pdfPath).toBeNull();
    await expect(loadBatchPdf(failed)).rejects.toThrow(BatchError);

    // Un lot en échec ne se relance pas tant qu'il n'est pas remis en file.
    await expect(renderBatch(batch.id)).rejects.toThrow(/pas en attente/);
    expect(await requeueBatch(batch.id)).toBe(true);
    const ready = await renderBatch(batch.id);
    expect(ready.status).toBe("READY");
    const after = await db.ticket.findMany({ where: { batchId: batch.id }, orderBy: { number: "asc" } });
    expect(after.map((t) => [t.id, t.number, t.qrHash])).toEqual(before.map((t) => [t.id, t.number, t.qrHash]));
  });

  it("découpe en piles : même nombre de pages, réimpression partielle", async () => {
    const batch = await createBatch({ ...base, quantity: 100, layout: "STACKS" });
    const ready = await renderBatch(batch.id);
    expect(ready.pageCount).toBe(20);
    const part = await reprintBatch(batch.id, base.actorId, "Pages froissées", [3, 5]);
    expect(await countPdfPages(part.bytes)).toBe(3);
    await expect(reprintBatch(batch.id, base.actorId, "x")).rejects.toThrow(/motif/);
    await expect(reprintBatch(batch.id, base.actorId, "Motif valable", [20, 30])).rejects.toThrow(/Pages invalides/);
  });

  it("un lot produit à 4 par page se réimprime à l'identique à 4 par page", async () => {
    const batch = await createBatch({ ...base, quantity: 8 });
    await db.batch.update({ where: { id: batch.id }, data: { ticketsPerPage: 4 } });
    const ready = await renderBatch(batch.id);
    expect(ready.pageCount).toBe(2);
    const { bytes } = await reprintBatch(batch.id, base.actorId, "Contrôle ancien format");
    expect(sha256Buffer(bytes)).toBe(ready.pdfSha256);
  });

  it("un lot prêt ne peut pas être régénéré", async () => {
    const batch = await createBatch({ ...base, quantity: 4 });
    await renderBatch(batch.id);
    await expect(renderBatch(batch.id)).rejects.toThrow(/pas en attente/);
  });
});
