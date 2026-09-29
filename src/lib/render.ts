import { LineCapStyle, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { DesignMime } from "./design-file";
import { A4, fitDesign, TICKETS_PER_PAGE, usableSlot, type PrintMargins } from "./numbering";
import {
  SAFE_MARGIN_MM,
  layoutRects,
  type NumberZone,
  type QrZone,
  type StubLineStyle,
  type TemplateLayout,
} from "./template-layout";

// Rendu PDF des billets (sections 5.2 à 5.4) : planches A4 portrait, cinq tickets
// horizontaux empilés (décision du projet), design ajusté proportionnellement,
// repères de coupe dans les marges.

const PT_PER_MM = 72 / 25.4;
const pt = (mm: number) => mm * PT_PER_MM;

export type RenderTemplate = {
  bytes: Uint8Array;
  mime: DesignMime;
  widthMm: number;
  heightMm: number;
  layout: TemplateLayout;
};

export type TicketFace = { number: string; qrValue: string };

type Background = { draw: (page: PDFPage, x: number, y: number, w: number, h: number) => void };

async function embedBackground(doc: PDFDocument, t: RenderTemplate): Promise<Background> {
  if (t.mime === "application/pdf") {
    const [embedded] = await doc.embedPdf(t.bytes, [0]);
    return { draw: (page, x, y, width, height) => page.drawPage(embedded, { x, y, width, height }) };
  }
  const img = t.mime === "image/png" ? await doc.embedPng(t.bytes) : await doc.embedJpg(t.bytes);
  return { draw: (page, x, y, width, height) => page.drawImage(img, { x, y, width, height }) };
}

const FONT_MAP = {
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  Helvetica: StandardFonts.Helvetica,
  "Courier-Bold": StandardFonts.CourierBold,
  "Times-Bold": StandardFonts.TimesRomanBold,
} as const;

type Fonts = Record<keyof typeof FONT_MAP, PDFFont>;

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  const entries = await Promise.all(
    Object.entries(FONT_MAP).map(async ([k, v]) => [k, await doc.embedFont(v)] as const),
  );
  return Object.fromEntries(entries) as Fonts;
}

function hexColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Repère d'un ticket placé sur la page : conversion des mm du design en points PDF. */
type Placement = { leftMm: number; topMm: number; scale: number; pageHeightMm: number };

function toPage(p: Placement, xMm: number, yMm: number, hMm: number) {
  return {
    x: pt(p.leftMm + xMm * p.scale),
    y: pt(p.pageHeightMm - (p.topMm + (yMm + hMm) * p.scale)),
  };
}

/**
 * Opérateurs PDF bruts d'un QR : carré blanc (marge vierge de 4 modules incluse), puis
 * modules noirs regroupés en rectangles par rangée. Écrits directement dans un flux compressé
 * par page : quelques Ko par ticket au lieu de milliers d'objets (indispensable à 10 000 billets).
 */
function qrOperators(p: Placement, zone: QrZone, value: string): string {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const sizePt = pt(zone.size * p.scale);
  const unit = sizePt / (n + 8);
  const { x, y } = toPage(p, zone.x, zone.y, zone.size);
  const f = (v: number) => v.toFixed(3);
  const top = y + sizePt - 4 * unit; // haut de la première rangée de modules
  const ops: string[] = [`1 g ${f(x)} ${f(y)} ${f(sizePt)} ${f(sizePt)} re f`, "0 g"];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < n && qr.modules.get(row, col)) col++;
      ops.push(`${f(x + (4 + start) * unit)} ${f(top - (row + 1) * unit)} ${f((col - start) * unit)} ${f(unit)} re`);
    }
  }
  // Un seul remplissage pour tous les modules : pas de filet entre rectangles adjacents.
  ops.push("f");
  return ops.join("\n");
}

/** Ajoute des opérateurs bruts à la page, dans un flux compressé isolé par q/Q. */
function appendRawContent(doc: PDFDocument, page: PDFPage, ops: string[]) {
  if (ops.length === 0) return;
  const stream = doc.context.flateStream(`q\n${ops.join("\n")}\nQ\n`);
  page.node.addContentStream(doc.context.register(stream));
}

function drawNumber(page: PDFPage, p: Placement, zone: NumberZone, number: string, fonts: Fonts) {
  const font = fonts[zone.font];
  const size = zone.fontSize * p.scale;
  const text = zone.prefix + number;
  const width = font.widthOfTextAtSize(text, size);
  // Hauteur de l'ascendante ≈ hauteur des chiffres : sert à centrer verticalement.
  const digitHeight = font.heightAtSize(size, { descender: false });
  const box = toPage(p, zone.x, zone.y, zone.height);
  page.drawText(text, {
    x: box.x + (pt(zone.width * p.scale) - width) / 2,
    y: box.y + (pt(zone.height * p.scale) - digitHeight) / 2,
    size,
    font,
    color: hexColor(zone.color),
  });
}

/** Dessine fond et numéros ; renvoie les opérateurs QR à ajouter au flux brut de la page. */
function drawTicket(page: PDFPage, p: Placement, t: RenderTemplate, bg: Background, fonts: Fonts, face: TicketFace): string[] {
  const origin = toPage(p, 0, 0, t.heightMm);
  bg.draw(page, origin.x, origin.y, pt(t.widthMm * p.scale), pt(t.heightMm * p.scale));
  const l = t.layout;
  if (l.stubLineX !== null && l.stubLine) drawStubLine(page, p, t.heightMm, l.stubLineX, l.stubLine);
  drawNumber(page, p, l.bodyNumber, face.number, fonts);
  // Talon : même numéro et même contenu QR ; en base, un seul billet et une seule admission.
  if (l.stubNumber) drawNumber(page, p, l.stubNumber, face.number, fonts);
  const ops = [qrOperators(p, l.bodyQr, face.qrValue)];
  if (l.stubQr) ops.push(qrOperators(p, l.stubQr, face.qrValue));
  return ops;
}

/** Tirets et pointillés en mm (à la taille nominale du design). */
const DASHES: Record<StubLineStyle["style"], number[] | undefined> = {
  dashed: [2.5, 1.5],
  dotted: [0.4, 1.1],
  solid: undefined,
};

/** Ligne de détachement du talon, sur toute la hauteur du ticket. */
function drawStubLine(page: PDFPage, p: Placement, heightMm: number, xMm: number, s: StubLineStyle) {
  const top = toPage(p, xMm, 0, 0);
  const bottom = toPage(p, xMm, heightMm, 0);
  const dash = DASHES[s.style];
  page.drawLine({
    start: { x: top.x, y: top.y },
    end: { x: bottom.x, y: bottom.y },
    thickness: s.thickness * p.scale,
    color: hexColor(s.color),
    dashArray: dash?.map((d) => pt(d * p.scale)),
    lineCap: s.style === "dotted" ? LineCapStyle.Round : LineCapStyle.Butt,
  });
}

export type SheetOptions = {
  template: RenderTemplate;
  profile: PrintMargins & { cropMarks: boolean };
  /** Tickets par page, de haut en bas ; null = emplacement laissé vide. */
  pages: (TicketFace | null)[][];
  /** Emplacements par page (5 par défaut ; 4 pour les lots produits avant le changement de format). */
  perPage?: number;
  /** Mention imprimée dans la marge haute (BAT), si la marge le permet. */
  header?: string;
  title?: string;
  onPage?: (pagesDone: number) => void;
};

export async function renderSheets(opts: SheetOptions): Promise<Uint8Array> {
  const { template: t, profile } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? "Billets");
  doc.setProducer("Billetterie");
  doc.setCreationDate(new Date(0)); // sortie déterministe : une réimpression est identique octet pour octet
  doc.setModificationDate(new Date(0));
  const bg = await embedBackground(doc, t);
  const fonts = await embedFonts(doc);

  const perPage = opts.perPage ?? TICKETS_PER_PAGE;
  const slot = usableSlot(profile, perPage);
  const fit = fitDesign(t, slot);

  for (const [index, faces] of opts.pages.entries()) {
    if (faces.length > perPage) throw new Error(`${perPage} tickets au plus par page`);
    const page = doc.addPage([pt(A4.widthMm), pt(A4.heightMm)]);
    const cutsY: number[] = [];
    const raw: string[] = [];
    faces.forEach((face, i) => {
      const slotTop = profile.marginTopMm + i * (slot.heightMm + profile.gapMm);
      const placement: Placement = {
        leftMm: profile.marginLeftMm + fit.offsetXMm,
        topMm: slotTop + fit.offsetYMm,
        scale: fit.scale,
        pageHeightMm: A4.heightMm,
      };
      cutsY.push(placement.topMm, placement.topMm + fit.heightMm);
      if (face) raw.push(...drawTicket(page, placement, t, bg, fonts, face));
    });
    appendRawContent(doc, page, raw);
    if (profile.cropMarks) {
      const left = profile.marginLeftMm + fit.offsetXMm;
      drawCropMarks(page, { left, right: left + fit.widthMm, ys: cutsY });
    }
    if (opts.header && profile.marginTopMm >= 4) {
      const font = fonts.Helvetica;
      page.drawText(opts.header, { x: pt(profile.marginLeftMm + 3), y: pt(A4.heightMm - profile.marginTopMm + 1.2), size: 6.5, font, color: rgb(0.35, 0.35, 0.35) });
    }
    opts.onPage?.(index + 1);
    // Rend la main à la boucle d'événements : une génération ne bloque pas les scans en cours.
    if (index % 4 === 3) await new Promise((r) => setImmediate(r));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * Repères de coupe tracés uniquement dans les marges, jamais sur le contenu utile.
 * Un repère n'est tracé que si la marge laisse au moins 2 mm.
 */
function drawCropMarks(page: PDFPage, c: { left: number; right: number; ys: number[] }) {
  const gap = 1; // espace entre le repère et le bord du ticket
  const maxLen = 5;
  const color = rgb(0, 0, 0);
  const thickness = 0.25;
  const ys = [...new Set(c.ys.map((y) => Math.round(y * 1000) / 1000))];
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: pt(x1), y: pt(A4.heightMm - y1) }, end: { x: pt(x2), y: pt(A4.heightMm - y2) }, thickness, color });

  const leftLen = Math.min(maxLen, c.left - gap);
  const rightLen = Math.min(maxLen, A4.widthMm - c.right - gap);
  for (const y of ys) {
    if (leftLen >= 1) line(c.left - gap - leftLen, y, c.left - gap, y);
    if (rightLen >= 1) line(c.right + gap, y, c.right + gap + rightLen, y);
  }
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const topLen = Math.min(maxLen, top - gap);
  const bottomLen = Math.min(maxLen, A4.heightMm - bottom - gap);
  for (const x of [c.left, c.right]) {
    if (topLen >= 1) line(x, top - gap - topLen, x, top - gap);
    if (bottomLen >= 1) line(x, bottom + gap, x, bottom + gap + bottomLen);
  }
}

/**
 * Aperçu d'un seul ticket à sa taille nominale, avec en option les repères de conception :
 * zones variables (rouge), marge de sécurité (bleu) et ligne du talon.
 */
export async function renderTicketPreview(t: RenderTemplate, face: TicketFace, guides: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Aperçu du billet");
  const bg = await embedBackground(doc, t);
  const fonts = await embedFonts(doc);
  const page = doc.addPage([pt(t.widthMm), pt(t.heightMm)]);
  const p: Placement = { leftMm: 0, topMm: 0, scale: 1, pageHeightMm: t.heightMm };
  appendRawContent(doc, page, drawTicket(page, p, t, bg, fonts, face));

  if (guides) {
    const red = rgb(0.85, 0.1, 0.1);
    const blue = rgb(0.1, 0.35, 0.85);
    const rect = (x: number, y: number, w: number, h: number, color: typeof red) =>
      page.drawRectangle({ ...toPage(p, x, y, h), width: pt(w), height: pt(h), borderColor: color, borderWidth: 0.5, borderDashArray: [2, 2] });
    for (const r of layoutRects(t.layout)) rect(r.x, r.y, r.w, r.h, red);
    const m = SAFE_MARGIN_MM;
    const stub = t.layout.stubLineX;
    if (stub === null) rect(m, m, t.widthMm - 2 * m, t.heightMm - 2 * m, blue);
    else {
      rect(m, m, stub - 2 * m, t.heightMm - 2 * m, blue);
      rect(stub + m, m, t.widthMm - stub - 2 * m, t.heightMm - 2 * m, blue);
      page.drawLine({ start: { x: pt(stub), y: 0 }, end: { x: pt(stub), y: pt(t.heightMm) }, thickness: 0.6, color: red, dashArray: [4, 2] });
    }
  }
  return doc.save();
}
