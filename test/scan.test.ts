import type { EventRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createBatch } from "@/lib/batches";
import { decryptSecret, sha256Buffer } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/permissions";
import { overrideAdmission, processScan, ScanError, type ScanController } from "@/lib/scan";
import { assignTickets, confirmMovement, declareIncident, recordSale, setActivation } from "@/lib/stock";
import { saveFile } from "@/lib/storage";
import { DEFAULT_LAYOUT } from "@/lib/template-layout";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const op = () => randomUUID();

let eventId: string, otherEventId: string;
let gateA: string, gateB: string;
let orga: Actor, seller: Actor;
let ctrl: ScanController, ctrlGateB: ScanController;
let stdCat: string, vipCat: string, reentryCat: string, slotCat: string, otherCat: string;
const qr = new Map<string, string>(); // `${categoryId}:${number}` → valeur QR

/**
 * Chaque catégorie a sa propre numérotation (001…). Pour la lisibilité, les tests gardent des repères uniques :
 * 1–100 = Standard 001–100, 101–110 = VIP 001–010, 111–120 = Pass 001–010, 121–130 = Matinée 001–010.
 */
function ticketOf(ref: number): { categoryId: string; number: number } {
  if (ref <= 100) return { categoryId: stdCat, number: ref };
  if (ref <= 110) return { categoryId: vipCat, number: ref - 100 };
  if (ref <= 120) return { categoryId: reentryCat, number: ref - 110 };
  return { categoryId: slotCat, number: ref - 120 };
}
const qrOf = (ref: number) => {
  const t = ticketOf(ref);
  return qr.get(`${t.categoryId}:${t.number}`)!;
};

async function member(email: string, role: EventRole, evId = eventId, gateIds: string[] = []): Promise<Actor> {
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x" } });
  await db.eventMembership.create({ data: { userId: u.id, eventId: evId, role, gateIds } });
  return { id: u.id, isAdmin: false, roles: new Set([role]) };
}

async function setupEvent(name: string) {
  const org = await db.organization.create({ data: { name: `Org ${name}` } });
  return db.event.create({
    data: { organizationId: org.id, name, venue: "Salle", doorsOpenAt: new Date(), startsAt: new Date(), endsAt: new Date(Date.now() + 864e5), status: "OPEN" },
  });
}

async function batchFor(evId: string, categoryId: string, quantity: number, adminId: string) {
  const bytes = readFileSync("public/gabarit/billet-demo.pdf");
  const path = `templates/scan-${evId}/design.pdf`;
  await saveFile(path, bytes);
  const tpl = await db.ticketTemplate.upsert({
    where: { eventId_name_version: { eventId: evId, name: "T", version: 1 } },
    update: {},
    create: { eventId: evId, name: "T", version: 1, backgroundPath: path, backgroundMime: "application/pdf", backgroundSha256: sha256Buffer(bytes), layout: DEFAULT_LAYOUT, createdById: adminId, batApprovedAt: new Date() },
  });
  const profile = await db.printProfile.upsert({ where: { name: "scan 5 mm" }, update: {}, create: { name: "scan 5 mm" } });
  const b = await createBatch({ eventId: evId, categoryId, templateId: tpl.id, printProfileId: profile.id, quantity, layout: "SEQUENTIAL", actorId: adminId });
  for (const t of await db.ticket.findMany({ where: { batchId: b.id } })) qr.set(`${categoryId}:${t.number}`, decryptSecret(t.qrSecretEnc));
  return b;
}

const scan = (number: number, over: Partial<Parameters<typeof processScan>[0]> = {}) =>
  processScan({ eventId, gateId: gateA, controller: ctrl, value: qrOf(number), operationId: op(), ...over });

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: "admin-scan@test", name: "Admin", passwordHash: "x", isAdmin: true } });
  const ev = await setupEvent("Contrôle");
  eventId = ev.id;
  gateA = (await db.gate.create({ data: { eventId, name: "Porte A" } })).id;
  gateB = (await db.gate.create({ data: { eventId, name: "Porte VIP" } })).id;
  stdCat = (await db.category.create({ data: { eventId, name: "Standard", priceGnf: 100_000, quota: 1000 } })).id;
  vipCat = (await db.category.create({ data: { eventId, name: "VIP", priceGnf: 500_000, quota: 100, gateIds: [gateB] } })).id;
  reentryCat = (await db.category.create({ data: { eventId, name: "Pass", priceGnf: 200_000, quota: 100, reentryAllowed: true } })).id;
  slotCat = (await db.category.create({
    data: { eventId, name: "Matinée", priceGnf: 50_000, quota: 100, slotStart: new Date(Date.now() - 7200e3), slotEnd: new Date(Date.now() - 3600e3) },
  })).id;
  await batchFor(eventId, stdCat, 100, admin.id); // Standard 001–100
  await batchFor(eventId, vipCat, 10, admin.id); // VIP 001–010
  await batchFor(eventId, reentryCat, 10, admin.id); // Pass 001–010
  await batchFor(eventId, slotCat, 10, admin.id); // Matinée 001–010

  const other = await setupEvent("Autre");
  otherEventId = other.id;
  otherCat = (await db.category.create({ data: { eventId: otherEventId, name: "Std", priceGnf: 1, quota: 10 } })).id;
  await batchFor(otherEventId, otherCat, 5, admin.id);

  orga = await member("orga@scan", "ORGANIZER");
  seller = await member("vendeur@scan", "SELLER");
  const c = await member("ctrl@scan", "CONTROLLER");
  ctrl = { ...c, controllerGateIds: null };
  const c2 = await member("ctrl-b@scan", "CONTROLLER", eventId, [gateB]);
  ctrlGateB = { ...c2, controllerGateIds: [gateB] };

  // Vendus : Standard 001–060 et tout VIP, Pass, Matinée ; Standard 061–070 activés sans vente ;
  // Standard 071–100 en stock (ni vendus ni activés).
  for (const [categoryId, numbers] of [[stdCat, range(1, 60)], [vipCat, range(1, 10)], [reentryCat, range(1, 10)], [slotCat, range(1, 10)]] as const) {
    const m = await assignTickets({ eventId, actor: orga, fromHolderId: null, toUserId: seller.id, categoryId, numbers });
    await confirmMovement({ movementId: m.id, actor: seller });
    await recordSale({ eventId, actor: seller, sellerId: seller.id, categoryId, numbers, discountGnf: 0, paymentMethod: "CASH" });
  }
  await setActivation({ eventId, actor: orga, categoryId: stdCat, numbers: range(61, 70), active: true });
});

describe("R05 : admission unique, refus sur une autre porte avec mention de l'entrée initiale", () => {
  it("valide une fois, puis déjà utilisé partout", async () => {
    const first = await scan(1);
    expect(first).toMatchObject({ verdict: "VALID", reason: "OK", title: "VALIDE", number: "001", category: "Standard" });
    const again = await scan(1, { gateId: gateB, controller: { ...ctrl } });
    expect(again).toMatchObject({ verdict: "REFUSED", reason: "ALREADY_USED", title: "DÉJÀ UTILISÉ" });
    expect(again.previous?.gate).toBe("Porte A");
    expect(again.message).toMatch(/Entré à .* porte « Porte A »/);
  });
});

describe("R06 : refus avec motif correct", () => {
  it("QR inconnu, mal formé, autre événement, non activé, annulé, hors créneau", async () => {
    const unknown = await processScan({ eventId, gateId: gateA, controller: ctrl, value: "B1." + "x".repeat(32), operationId: op() });
    expect(unknown).toMatchObject({ verdict: "REFUSED", reason: "UNKNOWN", title: "INEXISTANT" });
    expect((await processScan({ eventId, gateId: gateA, controller: ctrl, value: "https://exemple.com", operationId: op() })).reason).toBe("UNKNOWN");

    const other = await processScan({ eventId, gateId: gateA, controller: ctrl, value: qr.get(`${otherCat}:1`)!, operationId: op() });
    expect(other).toMatchObject({ verdict: "REFUSED", reason: "OTHER_EVENT", title: "AUTRE ÉVÉNEMENT", number: null });

    expect(await scan(80)).toMatchObject({ verdict: "REFUSED", reason: "NOT_ACTIVATED", number: "080" });

    await declareIncident({ eventId, actor: orga, kind: "CANCEL", categoryId: stdCat, numbers: [81], reason: "Annulé" });
    expect(await scan(81)).toMatchObject({ verdict: "REFUSED", reason: "CANCELLED", title: "ANNULÉ" });

    expect(await scan(121)).toMatchObject({ verdict: "CHECK", reason: "OUT_OF_SLOT", title: "À VÉRIFIER", overridable: true });
    expect((await db.ticket.findFirstOrThrow({ where: ticketOf(121) })).entryState).toBe("NOT_USED");
  });

  it("billet activé sans vente : admis (politique vendu ou activé)", async () => {
    expect(await scan(61)).toMatchObject({ verdict: "VALID", reason: "OK" });
  });

  it("catégorie limitée à une porte", async () => {
    expect(await scan(101)).toMatchObject({ verdict: "REFUSED", reason: "FORBIDDEN_GATE" });
    expect(await scan(101, { gateId: gateB })).toMatchObject({ verdict: "VALID" });
  });

  it("toute tentative est conservée, valeur masquée", async () => {
    const s = await db.scan.findMany({ where: { eventId } });
    expect(s.length).toBeGreaterThanOrEqual(10);
    for (const x of s) expect(x.maskedValue.length).toBeLessThanOrEqual(9);
  });
});

describe("R07 : lectures simultanées et opérations répétées", () => {
  it("dix postes lisent le même billet au même instant : une seule admission", async () => {
    const results = await Promise.all(range(1, 10).map(() => scan(2)));
    expect(results.filter((r) => r.verdict === "VALID")).toHaveLength(1);
    expect(results.filter((r) => r.reason === "ALREADY_USED")).toHaveLength(9);
    const t = await db.ticket.findFirstOrThrow({ where: ticketOf(2) });
    expect(t.entryCount).toBe(1);
  });

  it("même opération renvoyée (double signal, relance réseau) : même verdict, une seule trace", async () => {
    const id = op();
    const [a, b] = await Promise.all([scan(3, { operationId: id }), scan(3, { operationId: id })]);
    const c = await scan(3, { operationId: id });
    expect(new Set([a.verdict, b.verdict, c.verdict])).toEqual(new Set(["VALID"]));
    expect(c.replayed).toBe(true);
    expect(await db.scan.count({ where: { operationId: id } })).toBe(1);
  });
});

describe("R13 : corps puis talon du même billet", () => {
  it("le même QR imprimé deux fois ne donne qu'une admission", async () => {
    expect((await scan(4)).verdict).toBe("VALID"); // corps
    expect(await scan(4)).toMatchObject({ verdict: "REFUSED", reason: "ALREADY_USED" }); // talon
  });
});

describe("droits du contrôleur (R09)", () => {
  it("porte non affectée, rôle retiré, porte fermée", async () => {
    await expect(scan(5, { controller: ctrlGateB })).rejects.toThrow(/pas affecté/);
    await expect(scan(5, { controller: { ...orga, controllerGateIds: null } })).rejects.toThrow(ScanError);
    await db.gate.update({ where: { id: gateA }, data: { active: false } });
    await expect(scan(5)).rejects.toThrow(/fermée/);
    await db.gate.update({ where: { id: gateA }, data: { active: true } });
  });

  it("événement non ouvert : refus", async () => {
    await db.event.update({ where: { id: eventId }, data: { status: "CLOSED" } });
    expect(await scan(5)).toMatchObject({ verdict: "REFUSED", reason: "EVENT_CLOSED" });
    await db.event.update({ where: { id: eventId }, data: { status: "OPEN" } });
  });
});

describe("entrée uniquement : pas de sortie ni de réentrée", () => {
  it("un billet donne droit à une seule entrée, même si la catégorie autorisait la réentrée", async () => {
    // « Pass » a été créé avec reentryAllowed = true : l'option n'a plus d'effet.
    expect((await scan(111)).reason).toBe("OK");
    expect(await scan(111)).toMatchObject({ verdict: "REFUSED", reason: "ALREADY_USED" });
    expect((await db.ticket.findFirstOrThrow({ where: ticketOf(111) })).entryCount).toBe(1);
  });

  it("l'API ne propose plus de mode sortie", async () => {
    // Un champ « mode » éventuellement envoyé par un ancien poste est ignoré : lecture d'entrée.
    const r = await processScan({ eventId, gateId: gateA, controller: ctrl, value: qrOf(112), operationId: op(), ...({ mode: "EXIT" } as object) });
    expect(r).toMatchObject({ verdict: "VALID", reason: "OK" });
  });
});

describe("saisie manuelle et dérogation supervisée", () => {
  it("un numéro tapé n'admet jamais directement ; numéro ambigu : préciser la catégorie", async () => {
    // « 006 » existe en Standard, VIP, Pass et Matinée : la catégorie doit être précisée.
    const ambiguous = await processScan({ eventId, gateId: gateA, controller: ctrl, value: "006", operationId: op() });
    expect(ambiguous).toMatchObject({ verdict: "REFUSED", reason: "AMBIGUOUS_NUMBER", title: "PRÉCISER LA CATÉGORIE", number: null });
    const r = await processScan({ eventId, gateId: gateA, controller: ctrl, value: "standard 006", operationId: op() });
    expect(r).toMatchObject({ verdict: "CHECK", reason: "MANUAL_ENTRY", number: "006", category: "Standard", overridable: true });
    expect((await db.ticket.findFirstOrThrow({ where: { categoryId: stdCat, number: 6 } })).entryState).toBe("NOT_USED");
    expect((await processScan({ eventId, gateId: gateA, controller: ctrl, value: "9999", operationId: op() })).reason).toBe("UNKNOWN");
    // Saisie d'un billet qui ne serait pas valide : refus direct, pas de dérogation possible.
    const manual = (v: string) => processScan({ eventId, gateId: gateA, controller: ctrl, value: v, operationId: op() });
    expect(await manual("90")).toMatchObject({ verdict: "REFUSED", reason: "NOT_ACTIVATED", overridable: false }); // seul Standard a un 090
    expect(await manual("Standard 1")).toMatchObject({ verdict: "REFUSED", reason: "ALREADY_USED" });
    expect(await manual("81")).toMatchObject({ verdict: "REFUSED", reason: "CANCELLED" });
    expect(await manual("VIP 002")).toMatchObject({ verdict: "REFUSED", reason: "FORBIDDEN_GATE" });
    expect(await manual("Inconnue 002")).toMatchObject({ verdict: "REFUSED", reason: "UNKNOWN" });
  });

  it("dérogation : superviseur seulement, motif obligatoire, admission unique et tracée", async () => {
    const check = await scan(122);
    expect(check.verdict).toBe("CHECK");
    await expect(overrideAdmission({ scanId: check.scanId, actor: ctrl, reason: "Retard train", operationId: op() })).rejects.toThrow(/superviseur/);
    await expect(overrideAdmission({ scanId: check.scanId, actor: orga, reason: "", operationId: op() })).rejects.toThrow(/motif/);
    const ok = await overrideAdmission({ scanId: check.scanId, actor: orga, reason: "Retard du car, validé par le chef de porte", operationId: op() });
    expect(ok).toMatchObject({ verdict: "VALID", reason: "OVERRIDE", title: "ADMIS PAR DÉROGATION" });
    const again = await overrideAdmission({ scanId: check.scanId, actor: orga, reason: "Encore une fois", operationId: op() });
    expect(again.reason).toBe("ALREADY_USED");
    const ex = await db.scan.findFirstOrThrow({ where: { eventId, exception: true } });
    expect(ex.exceptionReason).toMatch(/Retard du car/);
  });

  it("dérogation : l'état du billet est revérifié au moment d'admettre", async () => {
    const check = await scan(123);
    expect(check.verdict).toBe("CHECK");
    const sale = await db.saleTicket.findFirstOrThrow({ where: { ticket: { categoryId: slotCat, number: 3 } } });
    const { reverseSale } = await import("@/lib/stock");
    await reverseSale({ saleId: sale.saleId, actor: orga, numbers: [3], type: "CANCELLATION", reason: "Annulée entre-temps" });
    const r = await overrideAdmission({ scanId: check.scanId, actor: orga, reason: "Retard justifié", operationId: op() });
    expect(r).toMatchObject({ verdict: "REFUSED", reason: "CANCELLED" });
  });

  it("une lecture refusée ne peut pas être forcée", async () => {
    const refused = await scan(82);
    await expect(overrideAdmission({ scanId: refused.scanId, actor: orga, reason: "Je force", operationId: op() })).rejects.toThrow(/dérogation/);
  });
});
