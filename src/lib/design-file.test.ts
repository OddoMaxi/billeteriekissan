import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { inspectDesign } from "./design-file";
import { NOMINAL } from "./template-layout";

const mm = (v: number) => (v * 72) / 25.4;

async function pdf(pages: [number, number][]) {
  const doc = await PDFDocument.create();
  for (const [w, h] of pages) doc.addPage([mm(w), mm(h)]);
  return doc.save();
}

/** En-tête PNG minimal (signature + IHDR) : suffit à la lecture des dimensions. */
function pngHeader(w: number, h: number) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

describe("contrôle du design importé", () => {
  it("accepte un PDF d'une page au format nominal", async () => {
    const r = await inspectDesign(await pdf([[210, 59.4]]), NOMINAL);
    expect(r.errors).toEqual([]);
    expect(r.mime).toBe("application/pdf");
  });

  it("refuse un PDF de plusieurs pages", async () => {
    const r = await inspectDesign(await pdf([[210, 59.4], [210, 59.4]]), NOMINAL);
    expect(r.errors.join()).toMatch(/une seule page/);
  });

  it("refuse un design à l'ancien format 210 × 74,25 (4 par page), sans étirement", async () => {
    const r = await inspectDesign(await pdf([[210, 74.25]]), NOMINAL);
    expect(r.errors.join()).toMatch(/Proportions incorrectes/);
  });

  it("accepte un PDF homothétique en le signalant", async () => {
    const r = await inspectDesign(await pdf([[420, 118.8]]), NOMINAL);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/ramenée proportionnellement/);
  });

  it("PNG 2480 × 702 px (300 dpi) : aucun avertissement de résolution", async () => {
    const r = await inspectDesign(pngHeader(2480, 702), NOMINAL);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("PNG basse résolution : avertissement", async () => {
    const r = await inspectDesign(pngHeader(1240, 351), NOMINAL);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/150 dpi/);
  });

  it("refuse un format inconnu", async () => {
    const r = await inspectDesign(new TextEncoder().encode("GIF89a…"), NOMINAL);
    expect(r.errors.join()).toMatch(/PDF, PNG ou JPEG/);
  });
});
