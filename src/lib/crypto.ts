import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// ─── Mots de passe (scrypt, sel aléatoire, paramètres stockés avec le hash) ──

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const N = Number(n);
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return timingSafeEqual(actual, expected);
}

// ─── Jetons et empreintes ────────────────────────────────────────────────────

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Buffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Jeton de session opaque ; seul son sha256 est stocké en base. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// ─── Valeur QR ───────────────────────────────────────────────────────────────

/**
 * Contenu d'un QR de billet : préfixe de version + 192 bits aléatoires (CSPRNG).
 * Il ne contient ni numéro, ni prix, ni donnée personnelle : la validité se décide côté serveur.
 */
export const QR_PREFIX = "B1.";
const QR_PATTERN = /^B1\.[A-Za-z0-9_-]{32}$/;

export function newQrValue(): string {
  return QR_PREFIX + randomBytes(24).toString("base64url");
}

export function isWellFormedQr(value: string): boolean {
  return QR_PATTERN.test(value);
}

/** Valeur lue masquée pour les journaux de scan (jamais la valeur complète). */
export function maskQr(value: string): string {
  const v = value.slice(0, 200);
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 5)}…${v.slice(-3)}`;
}

// ─── Chiffrement des valeurs QR conservées pour la réimpression ──────────────

function qrKey(): Buffer {
  const b64 = process.env.QR_ENCRYPTION_KEY;
  if (!b64) throw new Error("QR_ENCRYPTION_KEY manquant");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("QR_ENCRYPTION_KEY doit faire 32 octets (base64)");
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", qrKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", qrKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
