import "server-only";
import ExcelJS from "exceljs";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "./db";
import { BLOCK_LABELS, COMMERCIAL_LABELS, MOVEMENT_LABELS, MOVEMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS } from "./labels";
import { formatNumber } from "./numbering";
import { namesFor } from "./people";
import type { EventReport, Period } from "./reports";
import { formatTicketRanges } from "./ticket-numbers";

// Exports (section 8) : CSV et XLSX avec filtres, auteur et date de génération ; PDF de clôture.

export type Cell = string | number | null;
export type Table = { name: string; columns: string[]; rows: Cell[][] };
export type ExportMeta = { eventName: string; author: string; generatedAt: Date; period: Period; timezone: string };

/** Horodatage local triable : « 2026-12-20 19:05:03 ». */
export function stamp(d: Date | null | undefined, tz: string): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(d);
}

const day = (d: Date | undefined, tz: string) => (d ? new Intl.DateTimeFormat("fr-FR", { timeZone: tz, dateStyle: "short" }).format(d) : "");

export function periodLabel(p: Period, tz: string): string {
  if (!p.from && !p.to) return "toute la période";
  return `${p.from ? `du ${day(p.from, tz)}` : ""}${p.from && p.to ? " " : ""}${p.to ? `au ${day(p.to, tz)}` : ""}`;
}

const between = (p: Period) => (p.from || p.to ? { ...(p.from ? { gte: p.from } : {}), ...(p.to ? { lte: p.to } : {}) } : undefined);

// ─── Tables ──────────────────────────────────────────────────────────────────

export async function ticketsTable(eventId: string, tz: string): Promise<Table> {
  const tickets = await db.ticket.findMany({
    where: { eventId },
    orderBy: { number: "asc" },
    include: { category: true, batch: { select: { firstNumber: true, lastNumber: true } } },
  });
  const gates = new Map((await db.gate.findMany({ where: { eventId } })).map((g) => [g.id, g.name]));
  const name = await namesFor(tickets.flatMap((t) => [t.holderId, t.sellerId]));
  return {
    name: "Billets",
    columns: ["Numéro", "Catégorie", "Prix facial (GNF)", "Lot", "État commercial", "Réception en attente", "Blocage", "Détenteur", "Vendeur", "Vendu le", "Activé le", "Entrée", "Porte", "Entrées"],
    rows: tickets.map((t) => [
      formatNumber(t.number),
      t.category.name,
      t.category.priceGnf,
      `${formatNumber(t.batch.firstNumber)}-${formatNumber(t.batch.lastNumber)}`,
      COMMERCIAL_LABELS[t.commercialState],
      t.pendingMovementId ? "oui" : "",
      BLOCK_LABELS[t.blockState],
      name(t.holderId),
      t.sellerId ? name(t.sellerId) : "",
      stamp(t.soldAt, tz),
      stamp(t.activatedAt, tz),
      stamp(t.usedAt, tz),
      t.usedGateId ? (gates.get(t.usedGateId) ?? "") : "",
      t.entryCount,
    ]),
  };
}

export async function salesTable(eventId: string, tz: string, period: Period): Promise<Table> {
  const sales = await db.sale.findMany({
    where: { eventId, ...(between(period) ? { soldAt: between(period) } : {}) },
    orderBy: { soldAt: "asc" },
    include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } },
  });
  const name = await namesFor(sales.flatMap((s) => [s.sellerId, s.createdById]));
  return {
    name: "Ventes",
    columns: ["Date", "Vendeur", "Type", "Billets", "Nombre", "Prix facial (GNF)", "Remise (GNF)", "Montant déclaré (GNF)", "Moyen", "Référence", "Motif", "Saisi par", "Identifiant"],
    rows: sales.map((s) => [
      stamp(s.soldAt, tz),
      name(s.sellerId),
      s.kind === "SALE" ? "Vente" : s.reversalType === "CANCELLATION" ? "Annulation" : "Correction de saisie",
      formatTicketRanges(s.tickets.map((t) => t.ticket), 1000),
      s.tickets.length * (s.kind === "SALE" ? 1 : -1),
      s.faceValueGnf,
      s.discountGnf,
      s.totalGnf,
      PAYMENT_METHOD_LABELS[s.paymentMethod],
      s.paymentRef ?? "",
      s.reason ?? "",
      name(s.createdById),
      s.id,
    ]),
  };
}

export async function paymentsTable(eventId: string, tz: string, period: Period): Promise<Table> {
  const payments = await db.payment.findMany({ where: { eventId, ...(between(period) ? { declaredAt: between(period) } : {}) }, orderBy: { declaredAt: "asc" } });
  const name = await namesFor(payments.flatMap((p) => [p.sellerId, p.declaredById, p.validatedById]));
  return {
    name: "Versements",
    columns: ["Déclaré le", "Vendeur", "Montant (GNF)", "Moyen", "Référence", "Déclaré par", "État", "Traité par", "Traité le", "Motif du rejet"],
    rows: payments.map((p) => [
      stamp(p.declaredAt, tz),
      name(p.sellerId),
      p.amountGnf,
      PAYMENT_METHOD_LABELS[p.method],
      p.reference ?? "",
      name(p.declaredById),
      p.rejectedAt ? "Rejeté" : p.validatedAt ? "Validé" : "En attente",
      p.validatedById ? name(p.validatedById) : "",
      stamp(p.validatedAt ?? p.rejectedAt, tz),
      p.rejectReason ?? "",
    ]),
  };
}

export async function scansTable(eventId: string, tz: string, period: Period): Promise<Table> {
  const scans = await db.scan.findMany({
    where: { eventId, ...(between(period) ? { serverTime: between(period) } : {}) },
    orderBy: { serverTime: "asc" },
    include: { ticket: { select: { number: true, eventId: true } }, gate: { select: { name: true } } },
  });
  const name = await namesFor(scans.map((s) => s.controllerId));
  return {
    name: "Contrôle",
    columns: ["Heure serveur", "Porte", "Contrôleur", "Poste", "Billet", "Verdict", "Motif", "Dérogation", "Valeur lue (masquée)"],
    rows: scans.map((s) => [
      stamp(s.serverTime, tz),
      s.gate.name,
      name(s.controllerId),
      s.deviceId ?? "",
      s.ticket && s.ticket.eventId === eventId ? formatNumber(s.ticket.number) : "",
      s.verdict === "VALID" ? "Valide" : s.verdict === "CHECK" ? "À vérifier" : "Refusé",
      s.reason,
      s.exception ? (s.exceptionReason ?? "oui") : "",
      s.maskedValue,
    ]),
  };
}

export async function movementsTable(eventId: string, tz: string, period: Period): Promise<Table> {
  const movements = await db.stockMovement.findMany({
    where: { eventId, ...(between(period) ? { createdAt: between(period) } : {}) },
    orderBy: { createdAt: "asc" },
    include: { tickets: { include: { ticket: { select: { number: true, category: { select: { name: true } } } } } } },
  });
  const name = await namesFor(movements.flatMap((m) => [m.fromUserId, m.toUserId, m.createdById, m.resolvedById]));
  return {
    name: "Mouvements",
    columns: ["Date", "Opération", "De", "À", "Nombre", "Billets", "État", "Par", "Accusé / refus par", "Le", "Motif", "Incident"],
    rows: movements.map((m) => [
      stamp(m.createdAt, tz),
      MOVEMENT_LABELS[m.kind],
      ["ASSIGN", "RETURN"].includes(m.kind) ? name(m.fromUserId) : "",
      ["ASSIGN", "RETURN"].includes(m.kind) ? name(m.toUserId) : "",
      m.quantity,
      formatTicketRanges(m.tickets.map((t) => t.ticket), 1000),
      MOVEMENT_STATUS_LABELS[m.status],
      name(m.createdById),
      m.resolvedById ? name(m.resolvedById) : "",
      stamp(m.resolvedAt, tz),
      m.reason ?? "",
      m.incident ?? "",
    ]),
  };
}

export const TABLES = {
  tickets: (id: string, tz: string) => ticketsTable(id, tz),
  sales: salesTable,
  payments: paymentsTable,
  scans: scansTable,
  movements: movementsTable,
} as const;
export type TableKey = keyof typeof TABLES;

export async function buildTable(key: TableKey, eventId: string, tz: string, period: Period): Promise<Table> {
  return key === "tickets" ? ticketsTable(eventId, tz) : TABLES[key](eventId, tz, period);
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** CSV pour Excel en français : BOM UTF-8, séparateur « ; », ligne d'en-tête d'identification. */
export function toCsv(t: Table, meta: ExportMeta): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = `${t.name} — ${meta.eventName} — ${periodLabel(meta.period, meta.timezone)} — export du ${stamp(meta.generatedAt, meta.timezone)} par ${meta.author}`;
  return "﻿" + [esc(head), t.columns.map(esc).join(";"), ...t.rows.map((r) => r.map(esc).join(";"))].join("\r\n") + "\r\n";
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

export async function toXlsx(report: EventReport, tables: Table[], meta: ExportMeta, holderName: (id: string | null) => string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.author;
  wb.created = meta.generatedAt;

  const s = wb.addWorksheet("Synthèse");
  s.columns = [{ width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  s.addRow([`Synthèse — ${meta.eventName}`]).font = { bold: true, size: 14 };
  s.addRow(["Période des flux", periodLabel(meta.period, meta.timezone)]);
  s.addRow(["Généré le", stamp(meta.generatedAt, meta.timezone)]);
  s.addRow(["Par", meta.author]);
  s.addRow(["Montants", "déclarés par les vendeurs ; seuls les versements validés sont rapprochés"]);
  s.addRow([]);
  const t = report.totals;
  const m = report.moneyTotals;
  const section = (title: string) => (s.addRow([title]).font = { bold: true });
  section("Billets (état actuel)");
  for (const [k, v] of [
    ["Générés", t.generated], ["Imprimés (lots prêts)", t.printed], ["En stock central", t.inStock], ["Chez les détenteurs", t.withHolders],
    ["Vendus (valides)", t.sold], ["Activés", t.activated], ["dont activés sans vente", t.activatedNotSold], ["Retournés", t.returned],
    ["Annulés", t.cancelled], ["Perdus", t.lost], ["Détruits", t.destroyed], ["Utilisés à l'entrée", t.used], ["Vendus non utilisés", t.soldNotUsed],
  ] as const) s.addRow([k, v]);
  s.addRow([]);
  section("Recettes (période)");
  for (const [k, v] of [
    ["Recettes théoriques (prix facial des billets vendus)", t.theoreticalGnf], ["Prix facial des ventes", m.faceGnf], ["Remises", m.discountGnf],
    ["Ventes déclarées", m.salesGnf], ["Corrections de saisie", m.correctionsGnf], ["Remboursements", m.refundsGnf], ["Recettes nettes déclarées", m.netGnf],
    ["Versements validés (rapprochés)", m.paymentsValidatedGnf], ["Versements en attente de validation", m.paymentsPendingGnf], ["Solde restant dû", m.balanceGnf],
  ] as const) {
    const row = s.addRow([k, v]);
    row.getCell(2).numFmt = "#,##0 \"GNF\"";
  }
  s.addRow([]);
  section("Écarts et points d'attention");
  if (report.anomalies.length === 0) s.addRow(["Aucun"]);
  for (const a of report.anomalies) s.addRow([a.level === "error" ? "ÉCART" : a.level === "warning" ? "Attention" : "Info", a.message]);
  s.addRow([]);
  section("Caisse par vendeur");
  const hdr = s.addRow(["Vendeur", "Billets vendus", "Ventes", "Corrections", "Remboursements", "Recettes nettes", "Versé (validé)", "Solde dû"]);
  hdr.font = { bold: true };
  for (const r of report.money) {
    const row = s.addRow([holderName(r.sellerId), r.ticketsSold, r.salesGnf, r.correctionsGnf, r.refundsGnf, r.netGnf, r.paymentsValidatedGnf, r.balanceGnf]);
    for (let c = 3; c <= 8; c++) row.getCell(c).numFmt = "#,##0";
  }

  for (const table of tables) {
    const ws = wb.addWorksheet(table.name);
    ws.addRow([`${table.name} — ${meta.eventName} — ${periodLabel(meta.period, meta.timezone)} — ${stamp(meta.generatedAt, meta.timezone)} — ${meta.author}`]).font = { italic: true, color: { argb: "FF666666" } };
    const header = ws.addRow(table.columns);
    header.font = { bold: true };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    for (const r of table.rows) ws.addRow(r);
    ws.views = [{ state: "frozen", ySplit: 2 }];
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: table.columns.length } };
    ws.columns.forEach((col, i) => {
      const longest = Math.max(table.columns[i].length, ...table.rows.slice(0, 500).map((r) => String(r[i] ?? "").length));
      col.width = Math.min(50, Math.max(10, longest + 2));
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── PDF de clôture ──────────────────────────────────────────────────────────

/** Les polices standard du PDF (WinAnsi) n'ont pas certains caractères typographiques. */
function pdfSafe(text: string): string {
  return text
    .replace(/[   ]/g, " ")
    .replace(/[−‒–]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E -ÿŒœ—‘’“”…€]/g, "?");
}

const gnf = (n: number) => `${n.toLocaleString("fr-FR")} GNF`;

class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  readonly pages: PDFPage[] = [];
  static readonly W = 595.28;
  static readonly H = 841.89;
  static readonly M = 40;

  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PdfWriter.W, PdfWriter.H]);
    this.pages.push(this.page);
    this.y = PdfWriter.H - PdfWriter.M;
  }

  ensure(h: number) {
    if (this.y - h < PdfWriter.M + 20) this.newPage();
  }

  text(t: string, o: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {}) {
    const size = o.size ?? 9;
    this.ensure(size + 4);
    this.page.drawText(pdfSafe(t), { x: PdfWriter.M, y: this.y - size, size, font: o.bold ? this.bold : this.font, color: rgb(...(o.color ?? [0.1, 0.1, 0.1])) });
    this.y -= size + (o.gap ?? 4);
  }

  heading(t: string) {
    this.y -= 8;
    this.ensure(40);
    this.text(t, { size: 12, bold: true, gap: 6 });
  }

  /** Tableau simple ; colonnes numériques alignées à droite ; en-tête répété à chaque page. */
  table(columns: string[], rows: Cell[][], widths: number[]) {
    const size = 7.5;
    const rowH = 12;
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = (PdfWriter.W - 2 * PdfWriter.M) / total;
    const w = widths.map((x) => x * scale);
    const fit = (s: string, width: number, font: PDFFont) => {
      let out = pdfSafe(s);
      while (out.length > 1 && font.widthOfTextAtSize(out, size) > width - 4) out = out.slice(0, -2) + "…";
      return out;
    };
    // Une colonne est numérique si sa première valeur l'est : son en-tête s'aligne alors à droite aussi.
    const numeric = columns.map((_, i) => typeof rows[0]?.[i] === "number");
    const drawRow = (cells: Cell[], header: boolean) => {
      this.ensure(rowH);
      let x = PdfWriter.M;
      if (header) this.page.drawRectangle({ x, y: this.y - rowH + 2, width: PdfWriter.W - 2 * PdfWriter.M, height: rowH, color: rgb(0.89, 0.91, 0.94) });
      cells.forEach((c, i) => {
        const font = header ? this.bold : this.font;
        const s = fit(typeof c === "number" ? c.toLocaleString("fr-FR") : (c ?? ""), w[i], font);
        const tw = font.widthOfTextAtSize(s, size);
        const right = header ? numeric[i] : typeof c === "number";
        this.page.drawText(s, { x: right ? x + w[i] - tw - 2 : x + 2, y: this.y - rowH + 5, size, font, color: rgb(0.1, 0.1, 0.1) });
        x += w[i];
      });
      this.y -= rowH;
    };
    drawRow(columns, true);
    for (const r of rows) {
      if (this.y - rowH < PdfWriter.M + 20) {
        this.newPage();
        drawRow(columns, true);
      }
      drawRow(r, false);
    }
    this.y -= 4;
  }

  pairs(items: [string, string][]) {
    for (const [k, v] of items) {
      this.ensure(12);
      this.page.drawText(pdfSafe(k), { x: PdfWriter.M, y: this.y - 9, size: 9, font: this.font, color: rgb(0.3, 0.3, 0.3) });
      this.page.drawText(pdfSafe(v), { x: PdfWriter.M + 250, y: this.y - 9, size: 9, font: this.bold });
      this.y -= 13;
    }
  }
}

export async function closingPdf(report: EventReport, meta: ExportMeta, holderName: (id: string | null) => string, gateName: (id: string) => string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Rapport de clôture — ${meta.eventName}`);
  doc.setAuthor(meta.author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new PdfWriter(doc, font, bold);
  const ev = report.event;
  const tz = meta.timezone;
  const t = report.totals;
  const m = report.moneyTotals;

  w.text("RAPPORT DE CLÔTURE", { size: 16, bold: true, gap: 6 });
  w.text(`${ev.name} — ${ev.organization.name}`, { size: 12, bold: true });
  w.text(`${ev.venue}${ev.address ? `, ${ev.address}` : ""} · ${stamp(ev.startsAt, tz)} → ${stamp(ev.endsAt, tz)} (${tz})`);
  w.text(`Flux (ventes, versements, entrées) : ${periodLabel(meta.period, tz)} · états des billets au ${stamp(meta.generatedAt, tz)}`);
  w.text(`Généré le ${stamp(meta.generatedAt, tz)} par ${meta.author}. Montants déclarés : seuls les versements validés sont rapprochés.`, { color: [0.4, 0.4, 0.4] });

  w.heading("1. Billets par catégorie");
  w.table(
    ["Catégorie", "Quota", "Générés", "Vendus", "Activés*", "Stock", "Détenteurs", "Annulés", "Pertes**", "Utilisés", "Absents"],
    [
      ...report.perCategory.map((r) => [r.name, r.quota, r.generated, r.sold, r.activatedNotSold, r.inStock, r.withHolders, r.cancelled, r.lost + r.destroyed, r.used, r.soldNotUsed]),
      ["Total", t.quota, t.generated, t.sold, t.activatedNotSold, t.inStock, t.withHolders, t.cancelled, t.lost + t.destroyed, t.used, t.soldNotUsed],
    ],
    [18, 8, 8, 8, 9, 9, 9, 8, 9, 8, 8],
  );
  w.text("* activés sans vente déclarée · ** perdus ou détruits · Absents : vendus non utilisés à l'entrée", { size: 7, color: [0.4, 0.4, 0.4] });

  w.heading("2. Recettes");
  w.pairs([
    ["Recettes théoriques (prix facial des billets vendus)", gnf(t.theoreticalGnf)],
    ["Ventes déclarées", gnf(m.salesGnf)],
    ["dont remises accordées", gnf(m.discountGnf)],
    ["Corrections de saisie", m.correctionsGnf ? `- ${gnf(m.correctionsGnf)}` : gnf(0)],
    ["Remboursements déclarés", m.refundsGnf ? `- ${gnf(m.refundsGnf)}` : gnf(0)],
    ["Recettes nettes déclarées", gnf(m.netGnf)],
    ["Versements validés (rapprochés)", gnf(m.paymentsValidatedGnf)],
    ["Versements déclarés non validés", gnf(m.paymentsPendingGnf)],
    ["Solde restant dû par les vendeurs", gnf(m.balanceGnf)],
  ]);

  w.heading("3. Caisse par vendeur");
  w.table(
    ["Vendeur", "Billets", "Ventes", "Corrections", "Rembours.", "Nettes", "Versé validé", "En attente", "Solde dû"],
    report.money.map((r) => [holderName(r.sellerId), r.ticketsSold, r.salesGnf, r.correctionsGnf, r.refundsGnf, r.netGnf, r.paymentsValidatedGnf, r.paymentsPendingGnf, r.balanceGnf]),
    [20, 7, 11, 10, 10, 11, 11, 10, 11],
  );

  w.heading("4. Stock par détenteur (état actuel)");
  w.table(
    ["Détenteur", "Reçus", "Sortis", "Vendus", "Bloqués", "À réceptionner", "En main", "Attendu", "Écart"],
    report.holders
      .filter((h) => h.holderId === null || h.received + h.inHand + h.pendingIn > 0)
      .map((h) => [holderName(h.holderId), h.received, h.given, h.soldFromHand, h.blockedInHand, h.pendingIn, h.inHand, h.expected, h.gap]),
    [22, 9, 9, 9, 9, 11, 9, 9, 8],
  );

  w.heading("5. Contrôle d'entrée");
  const gates = [...new Set(report.entries.map((e) => e.gateId))];
  const c = (g: string, v: string) => report.entries.find((e) => e.gateId === g && e.verdict === v)?._count ?? 0;
  w.table(["Porte", "Valides", "Refusés", "À vérifier"], gates.map((g) => [gateName(g), c(g, "VALID"), c(g, "REFUSED"), c(g, "CHECK")]), [30, 12, 12, 12]);
  if (report.byHour.length) {
    w.text("Entrées valides par heure :", { bold: true });
    w.text(report.byHour.map((h) => `${new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit" }).format(h.hour)} : ${h.count}`).join(" · "));
  }
  w.text(`Admissions par dérogation : ${report.exceptions} · incidents de porte non traités : ${report.incidentsOpen}`);

  w.heading("6. Écarts et points d'attention");
  if (report.anomalies.length === 0) w.text("Aucun écart relevé.");
  for (const a of report.anomalies) w.text(`${a.level === "error" ? "ÉCART" : a.level === "warning" ? "ATTENTION" : "INFO"} — ${a.message}`, { color: a.level === "error" ? [0.75, 0.1, 0.1] : [0.1, 0.1, 0.1] });

  w.heading("7. Validation");
  w.text("Établi par : ______________________________    Date et signature : ______________________________", { gap: 14 });
  w.text("Vérifié par : _____________________________    Date et signature : ______________________________");

  w.pages.forEach((p, i) =>
    p.drawText(pdfSafe(`${ev.name} — rapport de clôture — généré le ${stamp(meta.generatedAt, tz)} par ${meta.author} — page ${i + 1}/${w.pages.length}`), {
      x: PdfWriter.M,
      y: 20,
      size: 7,
      font,
      color: rgb(0.45, 0.45, 0.45),
    }),
  );
  return doc.save();
}
