import { describe, expect, it } from "vitest";
import { fitDesign, formatNumber, nominalTicket, pageCount, pageLayout, rangeQuantity, usableSlot } from "./numbering";

describe("numérotation visible", () => {
  it("au moins trois chiffres, sans retour à zéro", () => {
    expect(formatNumber(1)).toBe("001");
    expect(formatNumber(6)).toBe("006");
    expect(formatNumber(99)).toBe("099");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1000)).toBe("1000");
    expect(formatNumber(3000)).toBe("3000");
    expect(formatNumber(10000)).toBe("10000");
  });

  it("quantité d'une plage continue", () => {
    expect(rangeQuantity(251, 500)).toBe(250);
    expect(rangeQuantity(1, 1000)).toBe(1000);
  });
});

describe("planches A4 à 5 tickets", () => {
  it("format nominal : 210 × 59,4 mm", () => {
    expect(nominalTicket()).toEqual({ widthMm: 210, heightMm: 59.4 });
  });

  it("1 000 tickets → 200 pages", () => {
    expect(pageCount(1000)).toBe(200);
    const pages = pageLayout(1, 1000, "SEQUENTIAL");
    expect(pages).toHaveLength(200);
    expect(pages.flat()).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it("1 002 tickets → 201 pages, trois emplacements vides sur la dernière", () => {
    const pages = pageLayout(1, 1002, "SEQUENTIAL");
    expect(pages).toHaveLength(201);
    expect(pages[200]).toEqual([1001, 1002, null, null, null]);
    expect(pages.flat().filter((n) => n !== null)).toHaveLength(1002);
  });

  it("ordre de haut en bas puis de page en page", () => {
    expect(pageLayout(1, 10, "SEQUENTIAL")).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ]);
  });

  it("R15 : un second lot continue la séquence", () => {
    expect(pageLayout(101, 100, "SEQUENTIAL")[0]).toEqual([101, 102, 103, 104, 105]);
  });

  it("découpe en piles : 100 tickets, page 1 = 001, 021, 041, 061, 081", () => {
    const pages = pageLayout(1, 100, "STACKS");
    expect(pages).toHaveLength(20);
    expect(pages[0]).toEqual([1, 21, 41, 61, 81]);
    // Les piles 1 à 5, chacune lue de page en page, redonnent 1…100.
    const assembled = [0, 1, 2, 3, 4].flatMap((slot) => pages.map((p) => p[slot]));
    expect(assembled).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("découpe en piles avec dernière page incomplète : aucun doublon, aucun billet en trop", () => {
    const pages = pageLayout(1, 102, "STACKS");
    expect(pages).toHaveLength(21);
    const nums = pages.flat().filter((n): n is number => n !== null);
    expect(nums.sort((a, b) => a - b)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
    const assembled = [0, 1, 2, 3, 4].flatMap((slot) => pages.map((p) => p[slot])).filter((n) => n !== null);
    expect(assembled).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
  });

  it("ancien format à 4 par page toujours calculable (lots déjà produits)", () => {
    expect(pageCount(1000, 4)).toBe(250);
    expect(pageLayout(1, 100, "STACKS", 4)[0]).toEqual([1, 26, 51, 76]);
  });

  it("zone utile, 5 mm par bord → 200 × 57,4 mm", () => {
    const slot = usableSlot({ marginTopMm: 5, marginBottomMm: 5, marginLeftMm: 5, marginRightMm: 5, gapMm: 0 });
    expect(slot.widthMm).toBe(200);
    expect(slot.heightMm).toBeCloseTo(57.4);
  });

  it("espacement entre tickets : 4 intervalles pour 5 tickets", () => {
    const slot = usableSlot({ marginTopMm: 5, marginBottomMm: 5, marginLeftMm: 5, marginRightMm: 5, gapMm: 2 });
    expect(slot.heightMm).toBeCloseTo((297 - 10 - 8) / 5);
  });

  it("ajustement proportionnel sans étirement", () => {
    const fit = fitDesign(nominalTicket(), { widthMm: 200, heightMm: 57.4 });
    expect(fit.widthMm / fit.heightMm).toBeCloseTo(210 / 59.4);
    expect(fit.widthMm).toBeLessThanOrEqual(200);
    expect(fit.heightMm).toBeLessThanOrEqual(57.4 + 1e-9);
  });
});
