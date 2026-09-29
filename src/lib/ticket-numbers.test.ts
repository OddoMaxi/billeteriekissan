import { describe, expect, it } from "vitest";
import { formatRanges, formatTicketRanges, parseNumbers, toRanges } from "./ticket-numbers";

describe("saisie des numéros", () => {
  it("plages et numéros isolés, séparateurs variés, sans doublon", () => {
    expect(parseNumbers("0101-0105, 0200; 103\n7 à 9").numbers).toEqual([7, 8, 9, 101, 102, 103, 104, 105, 200]);
    expect(parseNumbers("12–14").numbers).toEqual([12, 13, 14]);
  });

  it("erreurs explicites", () => {
    expect(parseNumbers("150-101").errors.join()).toMatch(/inversée/);
    expect(parseNumbers("abc").errors.join()).toMatch(/ni un numéro/);
    expect(parseNumbers("").errors.join()).toMatch(/au moins un/);
    expect(parseNumbers("0").errors.join()).toMatch(/commencent à 001\./);
    expect(parseNumbers("1-20000").errors.join()).toMatch(/Trop de billets/);
  });

  it("regroupement en plages", () => {
    expect(toRanges([3, 1, 2, 7, 9, 8])).toEqual([
      [1, 3],
      [7, 9],
    ]);
    expect(formatRanges([1, 2, 3, 7])).toBe("001–003, 007");
    expect(formatRanges([999, 1000, 1001])).toBe("999–1001");
  });
});

describe("plages par catégorie", () => {
  it("préfixe la catégorie, chaque catégorie ayant sa propre numérotation", () => {
    const t = (number: number, name: string) => ({ number, category: { name } });
    expect(formatTicketRanges([t(1, "VIP"), t(2, "VIP"), t(1, "Standard"), t(2, "Standard"), t(3, "Standard")])).toBe("VIP 001–002 · Standard 001–003");
    expect(formatTicketRanges([t(5, "VIP")], 12, true)).toBe("005");
  });
});
