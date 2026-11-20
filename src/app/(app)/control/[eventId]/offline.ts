// Contrôle hors connexion côté poste : copie de l'événement (empreintes des QR), verdict local,
// file des lectures à envoyer au retour du réseau. Tout est stocké dans IndexedDB, sur le poste.

import type { OfflineSnapshot } from "@/lib/scan";

export type Snapshot = Extract<OfflineSnapshot, { disabled: false }>;
type Verdict = "VALID" | "REFUSED" | "CHECK";
export type LocalReason =
  | "OK"
  | "UNKNOWN"
  | "FORBIDDEN_GATE"
  | "NOT_ACTIVATED"
  | "CANCELLED"
  | "LOST"
  | "DESTROYED"
  | "ALREADY_USED"
  | "OUT_OF_SLOT"
  | "MANUAL_ENTRY"
  | "AMBIGUOUS_NUMBER"
  | "EVENT_CLOSED";

/** Lecture faite hors connexion, en attente d'envoi. */
export type QueueItem = {
  operationId: string;
  eventId: string;
  gateId: string;
  value: string;
  deviceTime: string;
  verdict: Verdict;
  reason: LocalReason;
};

/** Admission connue du poste (faite ici, en ligne ou non, depuis la dernière copie). */
export type LocalEntry = { at: number; gateId: string };

const DB_NAME = "controle-hors-ligne";
const QR_PATTERN = /^B1\.[A-Za-z0-9_-]{32}$/;
const STATE = { OK: 0, NOT_ACTIVATED: 1, USED: 2, CANCELLED: 3, LOST: 4, DESTROYED: 5 } as const;
const BLOCKS = { [STATE.CANCELLED]: "CANCELLED", [STATE.LOST]: "LOST", [STATE.DESTROYED]: "DESTROYED" } as const;

// ─── IndexedDB ───────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("snapshots");
      db.createObjectStore("queue", { keyPath: "operationId" });
      db.createObjectStore("used");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  }));
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const snapKey = (eventId: string, gateId: string) => `${eventId}:${gateId}`;

export async function loadSnapshot(eventId: string, gateId: string): Promise<Snapshot | null> {
  try {
    return (await run<Snapshot | undefined>("snapshots", "readonly", (s) => s.get(snapKey(eventId, gateId)))) ?? null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(eventId: string, snap: Snapshot): Promise<void> {
  await run("snapshots", "readwrite", (s) => s.put(snap, snapKey(eventId, snap.gate.id)));
}

export async function deleteSnapshot(eventId: string, gateId: string): Promise<void> {
  await run("snapshots", "readwrite", (s) => s.delete(snapKey(eventId, gateId)));
}

export async function loadLocalEntries(eventId: string): Promise<Map<string, LocalEntry>> {
  const map = new Map<string, LocalEntry>();
  try {
    const range = IDBKeyRange.bound(`${eventId}:`, `${eventId}:￿`);
    const [keys, values] = await Promise.all([
      run<IDBValidKey[]>("used", "readonly", (s) => s.getAllKeys(range)),
      run<LocalEntry[]>("used", "readonly", (s) => s.getAll(range)),
    ]);
    keys.forEach((k, i) => map.set(String(k).slice(eventId.length + 1), values[i]));
  } catch {}
  return map;
}

export async function saveLocalEntry(eventId: string, hash: string, entry: LocalEntry): Promise<void> {
  await run("used", "readwrite", (s) => s.put(entry, `${eventId}:${hash}`));
}

export async function enqueue(item: QueueItem): Promise<void> {
  await run("queue", "readwrite", (s) => s.put(item));
}

export async function queuedItems(eventId: string): Promise<QueueItem[]> {
  try {
    const all = await run<QueueItem[]>("queue", "readonly", (s) => s.getAll());
    return all.filter((i) => i.eventId === eventId).sort((a, b) => a.deviceTime.localeCompare(b.deviceTime));
  } catch {
    return [];
  }
}

export async function dequeue(operationIds: string[]): Promise<void> {
  await run("queue", "readwrite", (s) => {
    for (const id of operationIds) s.delete(id);
  });
}

// ─── Empreinte et verdict local ──────────────────────────────────────────────

/** sha256 hexadécimal, identique à l'empreinte stockée côté serveur. Null si le navigateur ne sait pas la calculer (http). */
export async function sha256Hex(value: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isQrValue(value: string): boolean {
  return QR_PATTERN.test(value);
}

/** Index des billets de la copie, à reconstruire à chaque nouvelle copie. */
export class OfflineIndex {
  private byHash = new Map<string, Snapshot["tickets"][number]>();
  constructor(readonly snap: Snapshot) {
    for (const t of snap.tickets) this.byHash.set(t[0], t);
  }

  get size() {
    return this.snap.tickets.length;
  }

  /**
   * Verdict hors connexion, dans le même ordre de contrôle que le serveur.
   * `hash` : empreinte du QR lu (null pour une saisie de numéro). `local` : admissions connues du poste.
   */
  verdict(value: string, hash: string | null, local: Map<string, LocalEntry>, now: number): LocalVerdict {
    const { snap } = this;
    const fmt = (ms: number) =>
      new Intl.DateTimeFormat("fr-FR", { timeZone: snap.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
    const out = (verdict: Verdict, reason: LocalReason, t?: Snapshot["tickets"][number], previous?: LocalEntry | null): LocalVerdict => ({
      verdict,
      reason,
      title: TITLES[reason],
      message: message(reason, previous ? { at: fmt(previous.at), gate: snap.gateNames[previous.gateId] ?? null } : null, fmt(Date.parse(snap.generatedAt))),
      number: t ? String(t[2]).padStart(3, "0") : null,
      category: t ? (snap.categories[t[1]]?.name ?? null) : null,
      previous: previous ? { at: fmt(previous.at), gate: snap.gateNames[previous.gateId] ?? null } : null,
      hash: t ? t[0] : null,
    });

    if (snap.eventStatus !== "OPEN") return out("REFUSED", "EVENT_CLOSED");

    const typed = /^(?:(.+?)\s+)?(\d{1,7})$/.exec(value);
    let t: Snapshot["tickets"][number] | undefined;
    if (typed) {
      const cat = typed[1]?.trim().toLowerCase();
      const candidates = snap.tickets.filter((x) => x[2] === Number(typed[2]) && (!cat || snap.categories[x[1]]?.name.toLowerCase() === cat));
      if (candidates.length > 1) return out("REFUSED", "AMBIGUOUS_NUMBER");
      t = candidates[0];
    } else {
      if (!isQrValue(value) || !hash) return out("REFUSED", "UNKNOWN");
      t = this.byHash.get(hash);
    }
    if (!t) return out("REFUSED", "UNKNOWN");

    const state = t[3];
    if (state in BLOCKS) return out("REFUSED", BLOCKS[state as keyof typeof BLOCKS], t);
    const cat = snap.categories[t[1]];
    if (cat && !cat.allowedHere) return out("REFUSED", "FORBIDDEN_GATE", t);
    // Vendu après la dernière copie ? Impossible à savoir hors connexion : le superviseur tranche.
    if (state === STATE.NOT_ACTIVATED) return out("CHECK", "NOT_ACTIVATED", t);
    const entered = local.get(t[0]) ?? (state === STATE.USED ? { at: t[4] ?? 0, gateId: t[5] ?? "" } : null);
    if (entered) return out("REFUSED", "ALREADY_USED", t, entered);
    if (typed) return out("CHECK", "MANUAL_ENTRY", t);
    if (cat && ((cat.slotStart && now < cat.slotStart) || (cat.slotEnd && now > cat.slotEnd))) return out("CHECK", "OUT_OF_SLOT", t);
    return out("VALID", "OK", t);
  }
}

export type LocalVerdict = {
  verdict: Verdict;
  reason: LocalReason;
  title: string;
  message: string;
  number: string | null;
  category: string | null;
  previous: { at: string; gate: string | null } | null;
  /** Empreinte du billet reconnu (pour retenir son admission). */
  hash: string | null;
};

const TITLES: Record<LocalReason, string> = {
  OK: "VALIDE",
  UNKNOWN: "INEXISTANT",
  FORBIDDEN_GATE: "MAUVAISE PORTE",
  NOT_ACTIVATED: "À VÉRIFIER",
  CANCELLED: "ANNULÉ",
  LOST: "DÉCLARÉ PERDU",
  DESTROYED: "DÉTRUIT",
  ALREADY_USED: "DÉJÀ UTILISÉ",
  OUT_OF_SLOT: "À VÉRIFIER",
  MANUAL_ENTRY: "À VÉRIFIER",
  AMBIGUOUS_NUMBER: "PRÉCISER LA CATÉGORIE",
  EVENT_CLOSED: "CONTRÔLE FERMÉ",
};

function message(reason: LocalReason, previous: { at: string; gate: string | null } | null, copyTime: string): string {
  switch (reason) {
    case "OK":
      return "Première entrée.";
    case "UNKNOWN":
      return "Ce QR ne correspond à aucun billet.";
    case "FORBIDDEN_GATE":
      return "Cette catégorie n'entre pas par cette porte.";
    case "NOT_ACTIVATED":
      return `Non vendu d'après la liste de ${copyTime} : il a pu être vendu depuis. Appelez le superviseur.`;
    case "CANCELLED":
      return "Billet annulé : non utilisable.";
    case "LOST":
      return "Billet déclaré perdu : non utilisable.";
    case "DESTROYED":
      return "Billet détruit ou remplacé : non utilisable.";
    case "ALREADY_USED":
      return previous ? `Entré à ${previous.at}${previous.gate ? `, porte « ${previous.gate} »` : ""}.` : "Billet déjà utilisé.";
    case "OUT_OF_SLOT":
      return "Hors du créneau de la catégorie : appelez le superviseur.";
    case "MANUAL_ENTRY":
      return "Numéro saisi à la main : la dérogation exige la connexion. Appelez le superviseur.";
    case "AMBIGUOUS_NUMBER":
      return "Ce numéro existe dans plusieurs catégories : saisissez la catégorie puis le numéro (ex. « VIP 012 »).";
    case "EVENT_CLOSED":
      return "L'événement n'est pas ouvert au contrôle.";
  }
}
