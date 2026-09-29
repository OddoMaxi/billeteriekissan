import { PDFDocument } from "pdf-lib";

// Contrôle d'un design importé (section 5.1) : format, page unique, proportions, résolution.
// Aucun étirement ni recadrage silencieux : des proportions incorrectes sont refusées.

export type DesignMime = "application/pdf" | "image/png" | "image/jpeg";

export const MAX_DESIGN_BYTES = 15 * 1024 * 1024;
const RATIO_TOLERANCE = 0.01;
const MIN_DPI = 300;

export type DesignInspection = {
  mime: DesignMime;
  /** Dimensions natives : mm pour un PDF, pixels pour une image. */
  nativeWidth: number;
  nativeHeight: number;
  unit: "mm" | "px";
  errors: string[];
  warnings: string[];
};

export function detectMime(b: Uint8Array): DesignMime | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = v.getUint16(i + 2);
    // Marqueurs SOF (hors DHT, JPG, DAC) : hauteur puis largeur.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

export async function inspectDesign(
  bytes: Uint8Array,
  declared: { widthMm: number; heightMm: number },
): Promise<DesignInspection> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mime = detectMime(bytes);
  if (!mime) {
    return { mime: "application/pdf", nativeWidth: 0, nativeHeight: 0, unit: "mm", errors: ["Format non pris en charge : PDF, PNG ou JPEG uniquement."], warnings };
  }
  if (bytes.length > MAX_DESIGN_BYTES) errors.push("Fichier trop volumineux (15 Mo maximum).");

  let w = 0;
  let h = 0;
  let unit: "mm" | "px" = "px";
  if (mime === "application/pdf") {
    unit = "mm";
    try {
      const doc = await PDFDocument.load(bytes);
      if (doc.getPageCount() !== 1) errors.push(`Le PDF doit contenir une seule page (${doc.getPageCount()} trouvées).`);
      const page = doc.getPage(0);
      const { width, height } = page.getSize();
      const rotated = page.getRotation().angle % 180 !== 0;
      w = ((rotated ? height : width) * 25.4) / 72;
      h = ((rotated ? width : height) * 25.4) / 72;
      if (rotated) errors.push("La page du PDF est pivotée : exportez le design à l'horizontale, sans rotation.");
    } catch {
      errors.push("PDF illisible ou protégé par mot de passe.");
      return { mime, nativeWidth: 0, nativeHeight: 0, unit, errors, warnings };
    }
  } else {
    const size = mime === "image/png" ? pngSize(bytes) : jpegSize(bytes);
    if (!size) {
      errors.push("Image illisible.");
      return { mime, nativeWidth: 0, nativeHeight: 0, unit, errors, warnings };
    }
    w = size.w;
    h = size.h;
  }

  if (w <= h) errors.push("Le design doit être horizontal (plus large que haut).");
  const expected = declared.widthMm / declared.heightMm;
  const actual = w / h;
  if (Math.abs(actual / expected - 1) > RATIO_TOLERANCE) {
    errors.push(
      `Proportions incorrectes : ${actual.toFixed(3)} au lieu de ${expected.toFixed(3)} ` +
        `(${declared.widthMm} × ${declared.heightMm} mm). Le design n'est jamais étiré ni recadré : corrigez le fichier.`,
    );
  }

  if (unit === "mm") {
    if (Math.abs(w - declared.widthMm) > 1) {
      warnings.push(`Page de ${w.toFixed(1)} × ${h.toFixed(1)} mm : elle sera ramenée proportionnellement à ${declared.widthMm} × ${declared.heightMm} mm.`);
    }
    warnings.push("Vérifiez que les images contenues dans le PDF sont en 300 dpi au moins.");
  } else {
    const dpi = Math.round(w / (declared.widthMm / 25.4));
    if (dpi < MIN_DPI) {
      warnings.push(
        `Résolution insuffisante : ${dpi} dpi à la taille réelle (${MIN_DPI} dpi recommandés, soit ` +
          `${Math.round((declared.widthMm / 25.4) * MIN_DPI)} px de large). L'impression risque d'être floue.`,
      );
    }
  }

  return { mime, nativeWidth: w, nativeHeight: h, unit, errors, warnings };
}
