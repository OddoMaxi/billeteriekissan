// Les heures d'un événement se saisissent et s'affichent dans son fuseau (section 11).

function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-12-31T20:00" saisi dans le fuseau de l'événement → instant UTC. */
export function parseLocalDateTime(value: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Date invalide : ${value}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Deux passes pour les changements d'heure.
  let utc = naive - offsetMs(new Date(naive), timeZone);
  utc = naive - offsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

/** Instant → valeur d'un <input type="datetime-local"> dans le fuseau donné. */
export function toLocalInput(date: Date | null | undefined, timeZone: string): string {
  if (!date) return "";
  const local = new Date(date.getTime() + offsetMs(date, timeZone));
  return local.toISOString().slice(0, 16);
}

export function formatDateTime(date: Date | null | undefined, timeZone: string): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-FR", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatGnf(amount: number): string {
  return `${new Intl.NumberFormat("fr-FR").format(amount)} GNF`;
}
