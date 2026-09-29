// Génère le design fictif de référence et son gabarit coté, à partir de DEFAULT_LAYOUT.
// Usage : npx tsx scripts/demo-design.ts   (sorties dans public/gabarit/)
//
//  - public/gabarit/billet-demo.pdf   : fond à importer (PDF vectoriel, 1 page, 210 × 59,4 mm)
//  - public/gabarit/billet-demo.png   : même fond en PNG 300 dpi (2480 × 702 px)
//  - public/gabarit/gabarit-zones.pdf : gabarit pour les graphistes, zones réservées et cotes
//
// Les zones du QR et du numéro restent vierges : ils sont ajoutés à la génération.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import { DEFAULT_LAYOUT, NOMINAL, SAFE_MARGIN_MM, layoutRects } from "../src/lib/template-layout";

const W = NOMINAL.widthMm;
const H = NOMINAL.heightMm;
const L = DEFAULT_LAYOUT;
const STUB = L.stubLineX!;
const OUT = path.resolve("public/gabarit");

const NAVY = "#0f1f3d";
const NAVY_2 = "#1b3363";
const GOLD = "#e8b23a";

/** Panneau clair derrière les zones variables d'une partie (corps ou talon), 3 mm autour. */
function panel(part: "body" | "stub") {
  const rects = layoutRects(L).filter((r) => r.part === part);
  const x1 = Math.min(...rects.map((r) => r.x)) - 3;
  const y1 = Math.min(...rects.map((r) => r.y)) - 3.5;
  const x2 = Math.max(...rects.map((r) => r.x + r.w)) + 3;
  const y2 = Math.max(...rects.map((r) => r.y + r.h)) + 4.5;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function designSvg(guides: boolean): string {
  const bp = panel("body");
  const sp = panel("stub");
  const g: string[] = [];

  if (guides) {
    const zone = (x: number, y: number, w: number, h: number, label: string) => `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(220,30,30,0.12)" stroke="#d11" stroke-width="0.3" stroke-dasharray="1.2 0.8"/>
      <text x="${x + w / 2}" y="${y + h / 2 - 1}" font-size="2" fill="#b00" text-anchor="middle" font-weight="700">${label}</text>
      <text x="${x + w / 2}" y="${y + h / 2 + 1.8}" font-size="1.6" fill="#b00" text-anchor="middle">x ${x} · y ${y} · ${w} × ${h} mm</text>`;
    g.push(zone(L.bodyNumber.x, L.bodyNumber.y, L.bodyNumber.width, L.bodyNumber.height, "NUMÉRO"));
    g.push(zone(L.bodyQr.x, L.bodyQr.y, L.bodyQr.size, L.bodyQr.size, "QR CODE"));
    g.push(zone(L.stubNumber!.x, L.stubNumber!.y, L.stubNumber!.width, L.stubNumber!.height, "NUMÉRO"));
    g.push(zone(L.stubQr!.x, L.stubQr!.y, L.stubQr!.size, L.stubQr!.size, "QR CODE"));
    const m = SAFE_MARGIN_MM;
    g.push(`
      <rect x="${m}" y="${m}" width="${STUB - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#1a5ad8" stroke-width="0.25" stroke-dasharray="0.8 0.8"/>
      <rect x="${STUB + m}" y="${m}" width="${W - STUB - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#1a5ad8" stroke-width="0.25" stroke-dasharray="0.8 0.8"/>
      <text x="${m + 0.8}" y="${H - m - 0.8}" font-size="1.7" fill="#1a5ad8">Marge de sécurité ${m} mm (aucune zone variable au-delà)</text>
      <text x="${STUB + 0.8}" y="2.6" font-size="1.7" fill="#d11" font-weight="700">Ligne du talon x = ${STUB} mm</text>
      <text x="1" y="2.6" font-size="1.7" fill="#333" font-weight="700">Format ${W} × ${String(H).replace(".", ",")} mm (5 par A4) — cotes depuis le coin haut-gauche</text>
      <text x="${STUB / 2}" y="${H - 1.2}" font-size="1.7" fill="#333" text-anchor="middle">Corps : 0 → ${STUB} mm</text>
      <text x="${(STUB + W) / 2}" y="${H - 1.2}" font-size="1.7" fill="#333" text-anchor="middle">Talon : ${STUB} → ${W} mm</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm"
  font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY_2}"/><stop offset="1" stop-color="${NAVY}"/>
    </linearGradient>
    <pattern id="stripes" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <rect width="1.1" height="4" fill="${GOLD}" opacity="0.18"/>
    </pattern>
  </defs>

  <!-- Corps -->
  <rect width="${STUB}" height="${H}" fill="url(#bg)"/>
  <rect width="26" height="${H}" fill="url(#stripes)"/>
  <rect x="0" y="0" width="3" height="${H}" fill="${GOLD}"/>

  <text x="10" y="11.5" font-size="2.8" fill="${GOLD}" font-weight="700" letter-spacing="0.6">GUINÉE EVENTS PRÉSENTE</text>
  <text x="10" y="21" font-size="8.6" fill="#fff" font-weight="800" letter-spacing="-0.2">FESTIVAL</text>
  <text x="10" y="29.6" font-size="8.6" fill="#fff" font-weight="800" letter-spacing="-0.2">CONAKRY 2026</text>
  <text x="10" y="35.2" font-size="3" fill="#c9d5ee">Concert live · Stade du 28 Septembre</text>

  <text x="10" y="42" font-size="3.2" fill="#fff" font-weight="700">SAM. 20 DÉC. 2026 · 19H00</text>
  <text x="10" y="46.2" font-size="2.4" fill="#c9d5ee">Ouverture des portes 17h00</text>

  <rect x="72" y="37.5" width="26" height="7.5" rx="1.2" fill="${GOLD}"/>
  <text x="85" y="42.7" font-size="3.3" fill="${NAVY}" font-weight="800" text-anchor="middle">STANDARD</text>
  <text x="85" y="49.4" font-size="2.8" fill="#fff" font-weight="700" text-anchor="middle">100 000 GNF</text>

  <text x="10" y="52.6" font-size="1.65" fill="#9fb0d3">Valable pour une seule entrée. Toute copie ou duplication est refusée au contrôle.</text>
  <text x="10" y="54.8" font-size="1.65" fill="#9fb0d3">Ne pas plier ni couvrir le QR code. Billet ni repris ni échangé.</text>

  <!-- Panneau clair du corps : zones réservées au numéro et au QR -->
  <rect x="${bp.x}" y="${bp.y}" width="${bp.w}" height="${bp.h}" rx="2" fill="#fff"/>
  <text x="${bp.x + bp.w / 2}" y="${bp.y + 2.4}" font-size="1.9" fill="#667" text-anchor="middle" letter-spacing="0.4">N° BILLET</text>
  <text x="${bp.x + bp.w / 2}" y="${bp.y + bp.h - 1.3}" font-size="1.7" fill="#667" text-anchor="middle">Présentez ce code à l'entrée</text>

  <!-- Talon -->
  <rect x="${STUB}" width="${W - STUB}" height="${H}" fill="${NAVY}"/>
  <rect x="${STUB}" y="0" width="${W - STUB}" height="3" fill="${GOLD}"/>
  <rect x="${STUB}" y="${H - 3}" width="${W - STUB}" height="3" fill="${GOLD}"/>
  <rect x="${sp.x}" y="${sp.y}" width="${sp.w}" height="${sp.h}" rx="2" fill="#fff"/>
  <text x="${sp.x + sp.w / 2}" y="${sp.y + 2.4}" font-size="1.9" fill="#667" text-anchor="middle" letter-spacing="0.4">TALON · N°</text>
  <text x="${sp.x + sp.w / 2}" y="${sp.y + sp.h - 1.3}" font-size="1.7" fill="#667" text-anchor="middle">Conservé par l'organisateur</text>

  <!-- Ligne de détachement : tracée par l'application à la génération (option du modèle), pas dans le design -->
  <circle cx="${STUB}" cy="0" r="2.2" fill="#fff"/>
  <circle cx="${STUB}" cy="${H}" r="2.2" fill="#fff"/>
  <text x="${STUB + 1.3}" y="${H / 2}" font-size="1.6" fill="#9fb0d3" transform="rotate(-90 ${STUB + 1.3} ${H / 2})" text-anchor="middle">✂ détacher ici</text>
  ${g.join("\n")}
</svg>`;
}

/** Chrome arrondit le format de page : on recadre à exactement W × H mm (origine haut-gauche). */
async function exactSize(pdf: Uint8Array): Promise<Uint8Array> {
  const pt = (mm: number) => (mm * 72) / 25.4;
  const src = await PDFDocument.load(pdf);
  const srcPage = src.getPage(0);
  const { height } = srcPage.getSize();
  const doc = await PDFDocument.create();
  doc.setTitle(`Billet de démonstration ${W} × ${H} mm`);
  const embedded = await doc.embedPage(srcPage, { left: 0, right: pt(W), top: height, bottom: height - pt(H) });
  doc.addPage([pt(W), pt(H)]).drawPage(embedded, { x: 0, y: 0, width: pt(W), height: pt(H) });
  return doc.save();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const html = (svg: string) =>
    `<!doctype html><html><head><style>@page{size:${W}mm ${H}mm;margin:0}html,body{margin:0;padding:0}svg{display:block}</style></head><body>${svg}</body></html>`;

  for (const [name, guides] of [["billet-demo", false], ["gabarit-zones", true]] as const) {
    const svg = designSvg(guides);
    await page.setContent(html(svg));
    const raw = await page.pdf({ width: `${W}mm`, height: `${H}mm`, printBackground: true, pageRanges: "1" });
    await writeFile(path.join(OUT, `${name}.pdf`), await exactSize(raw));
    if (!guides) {
      // PNG 300 dpi : 210 mm → 2 480 px de large.
      const pxW = Math.round((W / 25.4) * 300);
      const pxH = Math.round((H / 25.4) * 300);
      await page.setViewportSize({ width: pxW, height: pxH });
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg.replace(`width="${W}mm" height="${H}mm"`, `width="${pxW}" height="${pxH}"`)}</body></html>`);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: pxW, height: pxH } });
    }
    await writeFile(path.join(OUT, `${name}.svg`), svg);
  }
  await browser.close();
  console.log(`Design et gabarit écrits dans ${OUT}`);
}

main();
