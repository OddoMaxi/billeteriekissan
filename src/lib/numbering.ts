// Règles de numérotation et de composition des planches A4 (sections 5.3 et 5.4).
// Décision du projet (24/09/2026) : 5 tickets horizontaux par A4 portrait, au lieu de 4 dans le cahier,
// soit un ticket nominal de 210 × 59,4 mm. Fonctions pures : testées dans numbering.test.ts.

export const TICKETS_PER_PAGE = 5;

export const A4 = { widthMm: 210, heightMm: 297 };

/**
 * Numéro visible, propre à chaque catégorie (décision du projet, 26/09/2026) : au moins trois chiffres,
 * sans retour à zéro. 1 → "001", 999 → "999", 1000 → "1000".
 */
export function formatNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/** Quantité d'une plage continue complète. */
export function rangeQuantity(first: number, last: number): number {
  return last - first + 1;
}

/** Nombre de pages A4 : arrondi supérieur de quantité / tickets par page. */
export function pageCount(quantity: number, perPage: number = TICKETS_PER_PAGE): number {
  return Math.ceil(quantity / perPage);
}

/**
 * Numéros à placer sur chaque page, de haut en bas. `null` = emplacement vide
 * (dernière page incomplète : ni numéro ni QR, aucun billet supplémentaire).
 *
 * - SEQUENTIAL : 001-005 page 1, 006-010 page 2…
 * - STACKS : découpe en piles. La position i de la page p porte first + i × pages + p,
 *   de sorte que chaque pile découpée est continue et que les piles empilées
 *   dans l'ordre redonnent la suite complète.
 *   Ex. 100 tickets / 20 pages → page 1 : 001, 021, 041, 061, 081.
 */
export function pageLayout(
  first: number,
  quantity: number,
  layout: "SEQUENTIAL" | "STACKS",
  perPage: number = TICKETS_PER_PAGE,
): (number | null)[][] {
  const pages = pageCount(quantity, perPage);
  const result: (number | null)[][] = [];
  for (let p = 0; p < pages; p++) {
    const row: (number | null)[] = [];
    for (let slot = 0; slot < perPage; slot++) {
      const offset = layout === "SEQUENTIAL" ? p * perPage + slot : slot * pages + p;
      row.push(offset < quantity ? first + offset : null);
    }
    result.push(row);
  }
  return result;
}

export type PrintMargins = {
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  gapMm: number;
};

/** Format nominal d'un ticket : toute la largeur, 1/n de la hauteur d'un A4. */
export function nominalTicket(perPage: number = TICKETS_PER_PAGE): { widthMm: number; heightMm: number } {
  return { widthMm: A4.widthMm, heightMm: Math.round((A4.heightMm / perPage) * 100) / 100 };
}

/** Emplacement utile d'un ticket selon le profil d'impression. */
export function usableSlot(m: PrintMargins, perPage: number = TICKETS_PER_PAGE): { widthMm: number; heightMm: number } {
  return {
    widthMm: A4.widthMm - m.marginLeftMm - m.marginRightMm,
    heightMm: (A4.heightMm - m.marginTopMm - m.marginBottomMm - (perPage - 1) * m.gapMm) / perPage,
  };
}

/**
 * Ajustement proportionnel et centré du design dans l'emplacement utile :
 * aucun étirement ni recadrage.
 */
export function fitDesign(
  design: { widthMm: number; heightMm: number },
  slot: { widthMm: number; heightMm: number },
): { scale: number; offsetXMm: number; offsetYMm: number; widthMm: number; heightMm: number } {
  const scale = Math.min(slot.widthMm / design.widthMm, slot.heightMm / design.heightMm);
  const widthMm = design.widthMm * scale;
  const heightMm = design.heightMm * scale;
  return {
    scale,
    widthMm,
    heightMm,
    offsetXMm: (slot.widthMm - widthMm) / 2,
    offsetYMm: (slot.heightMm - heightMm) / 2,
  };
}
