import { z } from "zod";
import { nominalTicket } from "./numbering";

// Zones variables d'un modèle de billet (section 5.4). Toutes les cotes sont en mm,
// mesurées depuis le coin haut-gauche du design, avant toute mise à l'échelle d'impression.

/** Format nominal : 210 × 59,4 mm (cinq tickets par A4 portrait). */
export const NOMINAL = nominalTicket();

/** Distance minimale entre une zone variable et un bord de coupe (bord du ticket ou ligne du talon). */
export const SAFE_MARGIN_MM = 4;
/** Taille minimale d'une zone QR (marge vierge incluse) ; en dessous, la lecture n'est pas garantie. */
export const MIN_QR_MM = 15;
export const RECOMMENDED_QR_MM = 15;

export const FONTS = ["Helvetica-Bold", "Helvetica", "Courier-Bold", "Times-Bold"] as const;

const mm = z.coerce.number().finite().min(0).max(300);

export const qrZoneSchema = z.object({
  x: mm,
  y: mm,
  /** Côté du carré réservé, marge vierge de 4 modules incluse. */
  size: z.coerce.number().min(5).max(80),
});

export const numberZoneSchema = z.object({
  x: mm,
  y: mm,
  width: z.coerce.number().min(5).max(200),
  height: z.coerce.number().min(3).max(60),
  fontSize: z.coerce.number().min(6).max(72), // points
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Couleur au format #RRGGBB."),
  font: z.enum(FONTS),
  /** Texte avant le numéro ; vide par défaut (« 001 » sans préfixe). */
  prefix: z.string().max(10).default(""),
});

export const STUB_LINE_STYLES = ["dashed", "dotted", "solid"] as const;

/** Ligne de détachement imprimée sur chaque billet, à l'abscisse du talon. */
export const stubLineStyleSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Couleur au format #RRGGBB."),
  style: z.enum(STUB_LINE_STYLES),
  /** Épaisseur en points (0,3 à 2). */
  thickness: z.coerce.number().min(0.3).max(2),
});

export const layoutSchema = z.object({
  /** Abscisse de la ligne de détachement du talon ; null = billet sans talon. */
  stubLineX: z.coerce.number().min(0).max(300).nullable(),
  /**
   * Ligne de détachement tracée par l'application ; absente = non tracée
   * (cas des modèles antérieurs : leurs lots se réimpriment à l'identique).
   */
  stubLine: stubLineStyleSchema.nullable().optional(),
  bodyQr: qrZoneSchema,
  bodyNumber: numberZoneSchema,
  stubQr: qrZoneSchema.nullable(),
  stubNumber: numberZoneSchema.nullable(),
});

export type QrZone = z.infer<typeof qrZoneSchema>;
export type NumberZone = z.infer<typeof numberZoneSchema>;
export type TemplateLayout = z.infer<typeof layoutSchema>;
export type StubLineStyle = z.infer<typeof stubLineStyleSchema>;

export const DEFAULT_STUB_LINE: StubLineStyle = { color: "#ffffff", style: "dashed", thickness: 0.6 };

/**
 * Disposition proposée pour le design nominal 210 × 59,4 mm :
 * corps de 0 à 155 mm, talon de 155 à 210 mm (55 mm).
 * Sur chaque partie, le numéro (8 mm de haut) est au-dessus du QR (30 mm, marge vierge incluse),
 * l'ensemble centré verticalement ; corps et talon sont alignés à la même hauteur.
 */
export const DEFAULT_LAYOUT: TemplateLayout = {
  stubLineX: 155,
  stubLine: { color: "#ffffff", style: "dashed", thickness: 0.6 },
  bodyNumber: { x: 117, y: 9, width: 32, height: 8, fontSize: 16, color: "#111111", font: "Helvetica-Bold", prefix: "" },
  bodyQr: { x: 118, y: 20, size: 30 },
  stubNumber: { x: 162.5, y: 9, width: 40, height: 8, fontSize: 16, color: "#111111", font: "Helvetica-Bold", prefix: "" },
  stubQr: { x: 167.5, y: 20, size: 30 },
};

type Rect = { name: string; x: number; y: number; w: number; h: number; part: "body" | "stub" };

export function layoutRects(l: TemplateLayout): Rect[] {
  const rects: Rect[] = [
    { name: "QR du corps", x: l.bodyQr.x, y: l.bodyQr.y, w: l.bodyQr.size, h: l.bodyQr.size, part: "body" },
    { name: "Numéro du corps", x: l.bodyNumber.x, y: l.bodyNumber.y, w: l.bodyNumber.width, h: l.bodyNumber.height, part: "body" },
  ];
  if (l.stubQr) rects.push({ name: "QR du talon", x: l.stubQr.x, y: l.stubQr.y, w: l.stubQr.size, h: l.stubQr.size, part: "stub" });
  if (l.stubNumber) {
    rects.push({ name: "Numéro du talon", x: l.stubNumber.x, y: l.stubNumber.y, w: l.stubNumber.width, h: l.stubNumber.height, part: "stub" });
  }
  return rects;
}

export type LayoutCheck = { errors: string[]; warnings: string[] };

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Contrôle une disposition par rapport au design : aucune zone ne doit franchir une limite
 * de coupe ni en approcher à moins de SAFE_MARGIN_MM, ni chevaucher une autre zone.
 */
export function checkLayout(l: TemplateLayout, design: { widthMm: number; heightMm: number }): LayoutCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = SAFE_MARGIN_MM;
  const rects = layoutRects(l);

  if (l.stubLineX !== null && (l.stubLineX <= 2 * m || l.stubLineX >= design.widthMm - 2 * m)) {
    errors.push("La ligne du talon doit être à l'intérieur du billet.");
  }
  if (l.stubLineX === null && (l.stubQr || l.stubNumber || l.stubLine)) {
    errors.push("Des zones de talon sont définies alors que le billet n'a pas de talon.");
  }

  for (const r of rects) {
    let left = 0;
    let right = design.widthMm;
    if (l.stubLineX !== null) {
      if (r.part === "body") right = l.stubLineX;
      else left = l.stubLineX;
    }
    if (r.x < left + m || r.x + r.w > right - m || r.y < m || r.y + r.h > design.heightMm - m) {
      errors.push(
        `${r.name} : doit rester à au moins ${m} mm des limites de coupe ` +
          `(zone autorisée x ${r1(left + m)}–${r1(right - m)} mm, y ${m}–${r1(design.heightMm - m)} mm).`,
      );
    }
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.push(`${a.name} et ${b.name} se chevauchent.`);
      }
    }
  }

  for (const [name, qr] of [["QR du corps", l.bodyQr], ["QR du talon", l.stubQr]] as const) {
    if (!qr) continue;
    if (qr.size < MIN_QR_MM) errors.push(`${name} : ${qr.size} mm est trop petit (minimum ${MIN_QR_MM} mm).`);
    else if (qr.size < RECOMMENDED_QR_MM) warnings.push(`${name} : ${qr.size} mm, lecture à valider au BAT (${RECOMMENDED_QR_MM} mm recommandés).`);
  }

  // Le numéro doit tenir sur 5 chiffres (au-delà de 9999) dans sa zone.
  for (const [name, n] of [["Numéro du corps", l.bodyNumber], ["Numéro du talon", l.stubNumber]] as const) {
    if (!n) continue;
    const textMm = estimateTextWidthMm(`${n.prefix}10000`, n.fontSize, n.font);
    if (textMm > n.width) warnings.push(`${name} : un numéro à 5 chiffres (${r1(textMm)} mm) dépasserait la zone de ${n.width} mm.`);
    if ((n.fontSize * 25.4) / 72 > n.height) errors.push(`${name} : la taille de police dépasse la hauteur de la zone.`);
  }

  return { errors, warnings };
}

/** Largeur approximative d'un texte de chiffres (≈ 0,556 em en Helvetica, 0,6 em en Courier). */
export function estimateTextWidthMm(text: string, fontSizePt: number, font: (typeof FONTS)[number]): number {
  const em = font.startsWith("Courier") ? 0.6 : font.startsWith("Times") ? 0.5 : 0.556;
  return (text.length * em * fontSizePt * 25.4) / 72;
}
