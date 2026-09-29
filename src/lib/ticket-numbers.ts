import { formatNumber } from "./numbering";

// Saisie des numéros de billets (section 6) : plages continues et numéros isolés.
// Exemples acceptés : « 101-150 », « 101 à 150, 200 », « 12; 15–18 ». Numéros propres à une catégorie. Module pur, testé.

export const MAX_NUMBERS_PER_OPERATION = 10_000;

export type ParsedNumbers = { numbers: number[]; errors: string[] };

export function parseNumbers(input: string): ParsedNumbers {
  const errors: string[] = [];
  const set = new Set<number>();
  const parts = input
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const range = /^(\d{1,7})\s*(?:-|–|—|à|a)\s*(\d{1,7})$/i.exec(part);
    const single = /^\d{1,7}$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < 1) errors.push(`« ${part} » : les numéros commencent à 001.`);
      else if (a > b) errors.push(`« ${part} » : plage inversée.`);
      else if (b - a + 1 + set.size > MAX_NUMBERS_PER_OPERATION) errors.push(`Trop de billets (${MAX_NUMBERS_PER_OPERATION} maximum par opération).`);
      else for (let n = a; n <= b; n++) set.add(n);
    } else if (single) {
      const n = Number(part);
      if (n < 1) errors.push(`« ${part} » : les numéros commencent à 001.`);
      else set.add(n);
    } else {
      errors.push(`« ${part} » n'est ni un numéro ni une plage (ex. 101-150).`);
    }
  }
  if (parts.length === 0) errors.push("Saisissez au moins un numéro.");
  if (set.size > MAX_NUMBERS_PER_OPERATION) errors.push(`Trop de billets (${MAX_NUMBERS_PER_OPERATION} maximum par opération).`);
  return { numbers: [...set].sort((a, b) => a - b), errors: [...new Set(errors)] };
}

/** Regroupe des numéros en plages continues : [1,2,3,7] → [[1,3],[7,7]]. */
export function toRanges(numbers: number[]): [number, number][] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** « 001–003, 007 » ; tronqué au-delà de `max` plages. */
export function formatRanges(numbers: number[], max = 12): string {
  const ranges = toRanges(numbers);
  const text = ranges
    .slice(0, max)
    .map(([a, b]) => (a === b ? formatNumber(a) : `${formatNumber(a)}–${formatNumber(b)}`))
    .join(", ");
  return ranges.length > max ? `${text}… (+${ranges.length - max} plages)` : text;
}

/**
 * Plages préfixées par la catégorie (la numérotation est propre à chaque catégorie) :
 * « VIP 001–010, Standard 001–050 ». Sans préfixe s'il n'y a qu'une catégorie et `bare`.
 */
export function formatTicketRanges(tickets: { number: number; category: { name: string } }[], max = 12, bare = false): string {
  const byCat = new Map<string, number[]>();
  for (const t of tickets) byCat.set(t.category.name, [...(byCat.get(t.category.name) ?? []), t.number]);
  if (bare && byCat.size === 1) return formatRanges([...byCat.values()][0], max);
  return [...byCat].map(([name, nums]) => `${name} ${formatRanges(nums, max)}`).join(" · ");
}
