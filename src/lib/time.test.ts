import { describe, expect, it } from "vitest";
import { parseLocalDateTime, toLocalInput } from "./time";

describe("fuseaux horaires", () => {
  it("Conakry (UTC+0)", () => {
    const d = parseLocalDateTime("2026-12-31T20:00", "Africa/Conakry");
    expect(d.toISOString()).toBe("2026-12-31T20:00:00.000Z");
    expect(toLocalInput(d, "Africa/Conakry")).toBe("2026-12-31T20:00");
  });

  it("Paris en hiver (UTC+1) et aller-retour", () => {
    const d = parseLocalDateTime("2026-12-31T20:00", "Europe/Paris");
    expect(d.toISOString()).toBe("2026-12-31T19:00:00.000Z");
    expect(toLocalInput(d, "Europe/Paris")).toBe("2026-12-31T20:00");
  });
});
