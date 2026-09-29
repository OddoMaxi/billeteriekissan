import type { Period } from "./reports";
import { parseLocalDateTime } from "./time";

/** Période « du … au … » (jours entiers dans le fuseau de l'événement) depuis des paramètres AAAA-MM-JJ. */
export function parsePeriod(from: unknown, to: unknown, tz: string): Period {
  const ok = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  return {
    from: ok(from) ? parseLocalDateTime(`${from}T00:00`, tz) : undefined,
    to: ok(to) ? new Date(parseLocalDateTime(`${to}T23:59`, tz).getTime() + 59_999) : undefined,
  };
}
