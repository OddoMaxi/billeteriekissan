import { describe, expect, it } from "vitest";
import { checkLayout, DEFAULT_LAYOUT, layoutSchema, NOMINAL, type TemplateLayout } from "./template-layout";

const clone = (): TemplateLayout => structuredClone(DEFAULT_LAYOUT);

describe("disposition des zones variables", () => {
  it("anciens modèles sans ligne de talon : toujours valides", () => {
    const legacy = layoutSchema.parse({ ...clone(), stubLine: undefined });
    expect(legacy.stubLine).toBeUndefined();
    expect(checkLayout(legacy, NOMINAL).errors).toEqual([]);
  });

  it("la disposition proposée est valide sur le design nominal, sans avertissement", () => {
    expect(checkLayout(DEFAULT_LAYOUT, NOMINAL)).toEqual({ errors: [], warnings: [] });
  });

  it("refuse un QR qui franchit la ligne du talon", () => {
    const l = clone();
    l.bodyQr.x = 130; // 130 + 30 = 160 > 155
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/QR du corps/);
  });

  it("refuse une zone trop proche du bord de coupe", () => {
    const l = clone();
    l.stubQr!.y = 30; // 30 + 30 = 60 > 59,4 - 4
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/QR du talon/);
  });

  it("refuse les chevauchements", () => {
    const l = clone();
    l.bodyNumber.y = 30;
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/se chevauchent/);
  });

  it("billet sans talon : zones et ligne de talon interdites", () => {
    const l = clone();
    l.stubLineX = null;
    l.stubLine = null;
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/talon/);
    l.stubLine = { color: "#ffffff", style: "dashed", thickness: 0.6 };
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/talon/);
    l.stubQr = null;
    l.stubNumber = null;
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/talon/);
    l.stubLine = null;
    expect(checkLayout(l, NOMINAL).errors).toEqual([]);
  });

  it("QR : refusé sous 15 mm, accepté sans avertissement à partir de 15 mm", () => {
    const l = clone();
    l.bodyQr.size = 14;
    expect(checkLayout(l, NOMINAL).errors.join()).toMatch(/trop petit/);
    l.bodyQr.size = 16;
    expect(checkLayout(l, NOMINAL)).toEqual({ errors: [], warnings: [] });
  });
});
