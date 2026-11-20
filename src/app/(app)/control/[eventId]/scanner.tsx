"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Camera, CloudUpload, Keyboard, ListChecks, UserCheck, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { CameraFeed } from "./camera";
import {
  dequeue,
  deleteSnapshot,
  enqueue,
  isQrValue,
  loadLocalEntries,
  loadSnapshot,
  OfflineIndex,
  queuedItems,
  saveLocalEntry,
  saveSnapshot,
  sha256Hex,
  type LocalEntry,
  type Snapshot,
} from "./offline";

type Verdict = "VALID" | "REFUSED" | "CHECK";
type ScanResult = {
  scanId: string;
  verdict: Verdict;
  reason: string;
  title: string;
  message: string;
  number: string | null;
  category: string | null;
  previous: { at: string; gate: string | null } | null;
  overridable: boolean;
  serverTime: string;
  replayed: boolean;
  /** Verdict rendu par le poste, sans connexion (envoyé au serveur plus tard). */
  offline?: boolean;
};
type Display =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "pending" }
  | { kind: "result"; result: ScanResult; key: number }
  | { kind: "offline"; value: string; operationId: string; key: number }
  | { kind: "error"; message: string; session?: boolean; key: number };
type HistoryItem = { id: number; at: string; title: string; detail: string | null; verdict: Verdict | "OFFLINE" };

const TIMEOUT_MS = 4_000;
/** Avec une liste hors connexion prête, on n'attend pas le serveur aussi longtemps avant de juger localement. */
const TIMEOUT_WITH_FALLBACK_MS = 2_500;
/** Rafraîchissement de la liste hors connexion tant que le réseau est là. */
const SNAPSHOT_REFRESH_MS = 60_000;
const SYNC_BATCH = 50;
/** Même valeur relue dans ce délai = double signal du flasheur : même opération, même verdict. */
const DOUBLE_SIGNAL_MS = 1_200;
/** Retour automatique à « Prêt » après un verdict (les verdicts à vérifier restent affichés). */
const RESET_MS: Record<Verdict, number | null> = { VALID: 3_500, REFUSED: 6_000, CHECK: null };

const newOperationId = () => crypto.randomUUID();

function deviceId(): string {
  try {
    let id = localStorage.getItem("poste-controle");
    if (!id) {
      id = `poste-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem("poste-controle", id);
    }
    return id;
  } catch {
    return "poste-inconnu";
  }
}

/** Signal sonore : deux notes montantes = valide, deux graves = refusé, note longue = à vérifier. */
function beep(kind: Verdict | "OFFLINE") {
  try {
    const ctx = new AudioContext();
    const tones: [number, number, number][] =
      kind === "VALID" ? [[880, 0, 0.12], [1320, 0.1, 0.14]] : kind === "CHECK" ? [[520, 0, 0.45]] : [[220, 0, 0.18], [220, 0.25, 0.18]];
    for (const [freq, start, dur] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === "VALID" ? "sine" : "square";
      o.frequency.value = freq;
      g.gain.value = 0.22;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // Pas de son disponible : l'affichage suffit.
  }
}

/** Préférence « caméra » du poste, conservée dans le navigateur. */
const CAMERA_PREF = "controle-camera";
const cameraListeners = new Set<() => void>();
let cameraMemory: boolean | null = null; // repli si le stockage du navigateur est bloqué
function subscribeCameraPref(cb: () => void) {
  cameraListeners.add(cb);
  return () => cameraListeners.delete(cb);
}
function readCameraPref(): boolean {
  if (cameraMemory !== null) return cameraMemory;
  try {
    return localStorage.getItem(CAMERA_PREF) === "1";
  } catch {
    return false;
  }
}
function writeCameraPref(on: boolean) {
  cameraMemory = on;
  try {
    localStorage.setItem(CAMERA_PREF, on ? "1" : "0");
  } catch {}
  cameraListeners.forEach((cb) => cb());
}

/** Vibration du téléphone (ignorée là où elle n'existe pas, ex. iPhone). */
function vibrate(kind: Verdict | "OFFLINE") {
  try {
    navigator.vibrate?.(kind === "VALID" ? 80 : kind === "CHECK" ? [300] : [180, 90, 180]);
  } catch {}
}

async function postJson(url: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return null; // réseau indisponible ou délai dépassé
  } finally {
    clearTimeout(timer);
  }
}

// ─── Visuels ─────────────────────────────────────────────────────────────────

function VerdictIcon({ kind }: { kind: Verdict | "OFFLINE" }) {
  const path =
    kind === "VALID"
      ? "M7 13l3.5 3.5L17.5 9"
      : kind === "REFUSED"
        ? "M8 8l8 8M16 8l-8 8"
        : kind === "CHECK"
          ? "M12 7v6M12 16.5v.5"
          : "M4 9a12 12 0 0116 0M7 12.5a7 7 0 0110 0M3 3l18 18";
  return (
    <div className="scan-pop mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-white/20 ring-4 ring-white/30 sm:h-28 sm:w-28">
      <svg viewBox="0 0 24 24" className="h-14 w-14 sm:h-16 sm:w-16" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={path} className="scan-draw" />
      </svg>
    </div>
  );
}

/** Cadre de visée avec ligne de balayage ; accélère quand un billet est en cours de lecture. */
function ScanFrame({ reading, camera = false }: { reading: boolean; camera?: boolean }) {
  const corner = "absolute h-9 w-9 border-[5px] transition-colors " + (reading ? "border-brand-400" : camera ? "border-white" : "border-slate-500");
  return (
    <div className={`relative mx-auto ${camera ? "h-56 w-56 sm:h-64 sm:w-64" : "h-40 w-40 sm:h-48 sm:w-48"}`}>
      <span className={`${corner} left-0 top-0 rounded-tl-2xl border-b-0 border-r-0`} />
      <span className={`${corner} right-0 top-0 rounded-tr-2xl border-b-0 border-l-0`} />
      <span className={`${corner} bottom-0 left-0 rounded-bl-2xl border-r-0 border-t-0`} />
      <span className={`${corner} bottom-0 right-0 rounded-br-2xl border-l-0 border-t-0`} />
      {!camera && (
      <svg viewBox="0 0 24 24" className={`absolute inset-0 m-auto h-20 w-20 ${reading ? "text-brand-300" : "scan-breathe text-slate-600"}`} fill="currentColor">
        <path d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm9-2h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h3v2h-3v-2zm-4 4h2v3h-2v-3zm4 0h3v3h-3v-3zm-2 2h2v1h-2v-1z" />
      </svg>
      )}
      <span
        className={`absolute left-3 right-3 h-0.5 rounded-full ${
          reading ? "scan-laser-fast bg-brand-400 shadow-[0_0_12px_2px_rgba(253,99,131,0.7)]" : "scan-laser bg-emerald-400/80 shadow-[0_0_10px_1px_rgba(52,211,153,0.6)]"
        }`}
      />
    </div>
  );
}

/** Bouton de la barre d'outils du poste ; `highlight` = mode activable (caméra, saisie). */
function ToolButton({ active, highlight, label, title, icon, onClick }: { active: boolean; highlight?: boolean; label: string; title: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-pressed={active}
      suppressHydrationWarning
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium transition-colors ${
        active && highlight ? "bg-brand-600 text-white" : active ? "text-white" : "text-slate-400 hover:text-white"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// ─── Écran de contrôle ───────────────────────────────────────────────────────

export function Scanner({ eventId, gate, canOverride, tz }: { eventId: string; gate: { id: string; name: string }; canOverride: boolean; tz: string }) {
  const [display, setDisplay] = useState<Display>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [admitted, setAdmitted] = useState(0);
  const [online, setOnline] = useState(true);
  // Préférence de son propre au poste (lue au premier rendu côté navigateur).
  const [sound, setSound] = useState(() => {
    try {
      return typeof window === "undefined" || localStorage.getItem("controle-son") !== "0";
    } catch {
      return true;
    }
  });
  const [overrideReason, setOverrideReason] = useState("");
  const [incident, setIncident] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  // Lecture par la caméra du téléphone (préférence propre au poste ; désactivée au rendu serveur).
  const camera = useSyncExternalStore(subscribeCameraPref, readCameraPref, () => false);
  const inputRef = useRef<HTMLInputElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ value: string; at: number; operationId: string } | null>(null);
  const device = useRef("");
  const seq = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Contrôle hors connexion : liste des billets (empreintes), admissions connues du poste, lectures à envoyer.
  const [offlineIdx, setOfflineIdx] = useState<OfflineIndex | null>(null);
  const [offlineOff, setOfflineOff] = useState(false);
  const [pending, setPending] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string | null>(null); // dernière vérification réussie de la liste
  const idxRef = useRef<OfflineIndex | null>(null);
  const localEntries = useRef(new Map<string, LocalEntry>());
  const onlineRef = useRef(true);
  const flushing = useRef(false);
  const lastLocal = useRef<{ operationId: string; result: ScanResult } | null>(null);

  const markOnline = useCallback((v: boolean) => {
    onlineRef.current = v;
    setOnline(v);
  }, []);
  const applyIndex = useCallback((idx: OfflineIndex | null) => {
    idxRef.current = idx;
    setOfflineIdx(idx);
  }, []);

  useEffect(() => {
    device.current = deviceId();
  }, []);

  /** Envoie au serveur les lectures faites hors connexion, dans l'ordre, par paquets. */
  const flushQueue = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (;;) {
        const items = await queuedItems(eventId);
        setPending(items.length);
        if (items.length === 0) return;
        const batch = items
          .slice(0, SYNC_BATCH)
          .map((i) => ({ operationId: i.operationId, gateId: i.gateId, value: i.value, deviceTime: i.deviceTime, verdict: i.verdict, reason: i.reason }));
        const r = await postJson("/api/scan/sync", { eventId, deviceId: device.current, items: batch }, 15_000);
        if (!r) return markOnline(false);
        if (r.status !== 200) {
          setNotice(
            r.status === 401
              ? `Session fermée : reconnectez-vous pour envoyer ${items.length} lecture(s) faite(s) hors connexion.`
              : `Envoi des lectures hors connexion impossible : ${String(r.data.error ?? "erreur du serveur")}`,
          );
          return;
        }
        const results = r.data.results as { operationId: string; ok: boolean; conflict?: boolean; error?: string }[];
        await dequeue(results.map((x) => x.operationId));
        const conflicts = results.filter((x) => x.conflict).length;
        const failed = results.filter((x) => !x.ok);
        if (conflicts > 0) {
          setNotice(`Attention : ${conflicts} entrée(s) validée(s) hors connexion refusée(s) par le serveur (billet déjà entré ailleurs, copie…). Le superviseur est informé.`);
        } else if (failed.length > 0) {
          setNotice(`${failed.length} lecture(s) hors connexion non enregistrée(s) : ${failed[0].error}`);
        }
      }
    } catch {
      // Stockage ou réseau indisponible : nouvel essai au prochain passage.
    } finally {
      flushing.current = false;
    }
  }, [eventId, markOnline]);

  /** Télécharge la liste hors connexion de la porte (seulement si elle a changé). */
  const refreshSnapshot = useCallback(async () => {
    if (!globalThis.crypto?.subtle) return; // http : empreintes impossibles à calculer, pas de mode hors connexion
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const current = idxRef.current?.snap.version;
      const res = await fetch(`/api/scan/offline?eventId=${eventId}&gateId=${gate.id}`, {
        cache: "no-store",
        headers: current ? { "If-None-Match": `"${current}"` } : {},
        signal: ctrl.signal,
      });
      if (res.status === 304) return setCheckedAt(new Date().toISOString());
      if (!res.ok) return;
      const data = (await res.json()) as Snapshot | { disabled: true };
      if (data.disabled) {
        setOfflineOff(true);
        applyIndex(null);
        await deleteSnapshot(eventId, gate.id);
        return;
      }
      setOfflineOff(false);
      applyIndex(new OfflineIndex(data));
      setCheckedAt(data.generatedAt);
      await saveSnapshot(eventId, data);
    } catch {
      // Réseau coupé pendant le téléchargement : on garde la liste précédente.
    } finally {
      clearTimeout(timer);
    }
  }, [eventId, gate.id, applyIndex]);

  // Au démarrage : liste et lectures en attente gardées sur le poste, puis mise à jour régulière.
  useEffect(() => {
    let stop = false;
    void (async () => {
      const [snap, entries, queue] = await Promise.all([loadSnapshot(eventId, gate.id), loadLocalEntries(eventId), queuedItems(eventId)]);
      if (stop) return;
      localEntries.current = entries;
      setPending(queue.length);
      if (snap && !idxRef.current) applyIndex(new OfflineIndex(snap));
      void refreshSnapshot();
    })();
    const id = setInterval(() => {
      if (onlineRef.current) void refreshSnapshot();
    }, SNAPSHOT_REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [eventId, gate.id, refreshSnapshot, applyIndex]);

  // Service worker : l'écran de contrôle se rouvre sans connexion (en production uniquement).
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        await navigator.serviceWorker.ready;
        // Fichiers chargés avant l'installation du service worker : copiés pour une réouverture hors connexion.
        const own = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => {
            const url = new URL(u);
            return url.origin === location.origin && url.pathname.startsWith("/_next/static/");
          });
        const statics = await caches.open("controle-static-v1");
        await Promise.all(own.map((u) => statics.match(u).then((hit) => (hit ? undefined : statics.add(u))).catch(() => {})));
        await (await caches.open("controle-pages-v1")).add(location.href).catch(() => {});
      })
      .catch(() => {});
  }, []);

  // Champ de lecture (invisible) toujours prêt : on y revient dès que le focus se perd dans le vide.
  useEffect(() => {
    const id = setInterval(() => {
      const a = document.activeElement;
      if (!a || a === document.body) (manual ? manualRef : inputRef).current?.focus();
    }, 400);
    return () => clearInterval(id);
  }, [manual]);

  // Témoin réseau.
  useEffect(() => {
    let stop = false;
    const ping = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
        if (stop) return;
        markOnline(r.ok);
        if (r.ok) void flushQueue();
      } catch {
        if (!stop) markOnline(false);
      } finally {
        clearTimeout(t);
      }
    };
    ping();
    const id = setInterval(ping, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [markOnline, flushQueue]);

  const now = useCallback(
    (at?: string) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", ...(at ? {} : { second: "2-digit" }) }).format(at ? new Date(at) : new Date()),
    [tz],
  );
  const pushHistory = useCallback((item: Omit<HistoryItem, "id">) => setHistory((h) => [{ ...item, id: ++seq.current }, ...h].slice(0, 8)), []);

  /** Affiche un état, puis revient à « Prêt » après le délai prévu. */
  const show = useCallback((d: Display, resetAfter: number | null) => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setDisplay(d);
    if (resetAfter) resetTimer.current = setTimeout(() => setDisplay({ kind: "idle" }), resetAfter);
  }, []);

  const showResult = useCallback(
    (result: ScanResult) => {
      show({ kind: "result", result, key: ++seq.current }, RESET_MS[result.verdict]);
      const detail = [result.number ? `${result.category} ${result.number}` : null, result.offline ? "hors ligne" : null].filter(Boolean).join(" · ");
      pushHistory({ at: now(), title: result.title, detail: detail || null, verdict: result.verdict });
      if (result.verdict === "VALID" && !result.replayed) setAdmitted((n) => n + 1);
      if (sound) beep(result.verdict);
      vibrate(result.verdict);
    },
    [now, pushHistory, show, sound],
  );

  /** Retient qu'un billet est entré par ce poste (pour le refuser s'il repasse, même hors connexion). */
  const rememberEntry = useCallback(
    (hash: string, at: number) => {
      const entry = { at, gateId: gate.id };
      localEntries.current.set(hash, entry);
      return saveLocalEntry(eventId, hash, entry).catch(() => {});
    },
    [eventId, gate.id],
  );

  /** Verdict rendu par le poste à partir de la liste hors connexion ; la lecture part au serveur plus tard. */
  const judgeLocally = useCallback(
    async (value: string, operationId: string, idx: OfflineIndex) => {
      const at = Date.now();
      const hash = isQrValue(value) ? await sha256Hex(value) : null;
      const v = idx.verdict(value, hash, localEntries.current, at);
      // La lecture est gardée sur le poste avant d'afficher le verdict : rien ne se perd si la page se ferme aussitôt.
      let stored = true;
      try {
        await Promise.all([
          enqueue({ operationId, eventId, gateId: gate.id, value, deviceTime: new Date(at).toISOString(), verdict: v.verdict, reason: v.reason }),
          v.verdict === "VALID" && v.hash ? rememberEntry(v.hash, at) : null,
        ]);
        setPending((n) => n + 1);
      } catch {
        stored = false;
      }
      const result: ScanResult = {
        scanId: "",
        verdict: v.verdict,
        reason: v.reason,
        title: v.title,
        message: v.message,
        number: v.number,
        category: v.category,
        previous: v.previous,
        overridable: false,
        serverTime: new Date(at).toISOString(),
        replayed: false,
        offline: true,
      };
      lastLocal.current = { operationId, result };
      showResult(result);
      if (!stored) setNotice("Attention : cette lecture n'a pas pu être gardée sur le poste (stockage du navigateur indisponible).");
    },
    [eventId, gate.id, rememberEntry, showResult],
  );

  const send = useCallback(
    async (value: string, operationId: string) => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      setOverrideReason("");
      setNotice(null);
      // Double signal d'une lecture déjà jugée hors connexion : même verdict, rien de plus.
      if (lastLocal.current?.operationId === operationId) {
        showResult({ ...lastLocal.current.result, replayed: true });
        return;
      }
      const idx = idxRef.current;
      if (!onlineRef.current && idx) return judgeLocally(value, operationId, idx);
      setDisplay({ kind: "pending" });
      const r = await postJson(
        "/api/scan",
        { eventId, gateId: gate.id, value, operationId, deviceId: device.current },
        idx ? TIMEOUT_WITH_FALLBACK_MS : TIMEOUT_MS,
      );
      // Serveur injoignable (réseau coupé, serveur en panne) : verdict local si la liste est prête.
      if (!r || r.status >= 502) {
        markOnline(false);
        if (idx) return judgeLocally(value, operationId, idx);
      }
      if (!r) {
        // Jamais « valide » sans réponse du serveur ni liste hors connexion.
        show({ kind: "offline", value, operationId, key: ++seq.current }, null);
        pushHistory({ at: now(), title: "CONNEXION INDISPONIBLE", detail: null, verdict: "OFFLINE" });
        if (sound) beep("OFFLINE");
        vibrate("OFFLINE");
        return;
      }
      markOnline(true);
      if (r.status !== 200) {
        show({ kind: "error", message: String(r.data.error ?? "Erreur du serveur."), session: r.status === 401, key: ++seq.current }, null);
        if (sound) beep("REFUSED");
        return;
      }
      const result = r.data as unknown as ScanResult;
      showResult(result);
      if (result.verdict === "VALID" && isQrValue(value)) {
        const hash = await sha256Hex(value);
        if (hash) rememberEntry(hash, Date.now());
      }
    },
    [eventId, gate.id, judgeLocally, markOnline, now, pushHistory, rememberEntry, show, showResult, sound],
  );

  function submit(raw: string) {
    const value = raw.trim();
    if (!value || display.kind === "pending") return;
    const t = Date.now();
    const repeat = last.current && last.current.value === value && t - last.current.at < DOUBLE_SIGNAL_MS;
    const operationId = repeat ? last.current!.operationId : newOperationId();
    last.current = { value, at: t, operationId };
    void send(value, operationId);
  }

  function onScanKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = e.currentTarget.value;
    e.currentTarget.value = "";
    submit(value);
  }

  function onManual(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = manualRef.current!;
    submit(input.value);
    input.value = "";
  }

  async function override(result: ScanResult) {
    const r = await postJson("/api/scan/override", { scanId: result.scanId, reason: overrideReason, operationId: newOperationId() });
    if (!r) return setNotice("Connexion indisponible : dérogation non enregistrée.");
    if (r.status !== 200) return setNotice(String(r.data.error ?? "Erreur."));
    showResult(r.data as unknown as ScanResult);
    inputRef.current?.focus();
  }

  async function sendIncident() {
    const r = await postJson("/api/scan/incident", { eventId, gateId: gate.id, message: incident ?? "" });
    if (!r) return setNotice("Connexion indisponible : incident non transmis. Prévenez le superviseur directement.");
    if (r.status !== 200) return setNotice(String(r.data.error ?? "Erreur."));
    setIncident(null);
    setNotice("Incident transmis au superviseur.");
    inputRef.current?.focus();
  }

  const refocus = () => (manual ? manualRef : inputRef).current?.focus();
  const result = display.kind === "result" ? display.result : null;
  const verdictKind: Verdict | "OFFLINE" | null =
    result ? result.verdict : display.kind === "offline" ? "OFFLINE" : display.kind === "error" ? "REFUSED" : null;
  const stageBg =
    verdictKind === "VALID"
      ? "bg-gradient-to-b from-emerald-500 to-emerald-700"
      : verdictKind === "CHECK"
        ? "bg-gradient-to-b from-amber-400 to-orange-600"
        : verdictKind === "REFUSED"
          ? "bg-gradient-to-b from-red-500 to-red-700"
          : verdictKind === "OFFLINE"
            ? "bg-slate-800 ring-2 ring-red-500/60"
            : camera
              ? "bg-black/35"
              : "bg-slate-900";
  const resetMs = result ? RESET_MS[result.verdict] : null;

  return (
    <div className="relative -mx-4 overflow-hidden bg-slate-950 p-3 text-white sm:mx-0 sm:rounded-3xl sm:p-6 sm:shadow-xl" onClick={refocus}>
      {/* Champ de lecture du flasheur : invisible, le contenu du QR n'est jamais affiché. */}
      <input
        ref={inputRef}
        autoFocus
        onKeyDown={onScanKey}
        onInput={(e) => {
          if (e.currentTarget.value && (display.kind === "idle" || display.kind === "result")) {
            if (resetTimer.current) clearTimeout(resetTimer.current);
            setDisplay({ kind: "reading" });
          }
        }}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="none"
        aria-label="Champ de lecture du flasheur"
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
      />

      {/* En-tête : état du poste, puis outils */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="rounded-full bg-white px-3 py-1 font-semibold text-slate-900">{gate.name}</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ${online ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/20 text-red-200"}`}
        >
          {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5 animate-pulse" />}
          {online ? "En ligne" : offlineIdx ? "Hors connexion · contrôle local" : "Hors connexion"}
        </span>
        {!offlineOff &&
          (offlineIdx ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1 text-slate-300"
              title={`${offlineIdx.size.toLocaleString("fr-FR")} billets gardés sur ce poste pour le contrôle sans connexion`}
            >
              <ListChecks className="h-3.5 w-3.5" />
              Liste à jour {now(checkedAt ?? offlineIdx.snap.generatedAt)}
            </span>
          ) : (
            <span className="rounded-full bg-amber-500/20 px-3 py-1 text-amber-200" title="Le contrôle sans connexion n'est pas encore prêt sur ce poste">
              Hors ligne non prêt
            </span>
          ))}
        {pending > 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/20 px-3 py-1 tabular-nums text-brand-200"
            title="Lectures faites hors connexion, envoyées dès le retour du réseau"
          >
            <CloudUpload className="h-3.5 w-3.5" />
            {pending} à envoyer
          </span>
        )}
        <span
          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1 tabular-nums text-slate-300"
          title="Entrées validées sur ce poste depuis l'ouverture de la page"
        >
          <UserCheck className="h-3.5 w-3.5" />
          {admitted} entrée{admitted > 1 ? "s" : ""}
        </span>
        <div className="ml-auto flex rounded-xl bg-white/[0.07] p-1" role="toolbar" aria-label="Outils du poste">
          <ToolButton
            active={sound}
            label={sound ? "Son" : "Muet"}
            title="Signal sonore"
            icon={sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            onClick={() => {
              setSound((s) => {
                try {
                  localStorage.setItem("controle-son", s ? "0" : "1");
                } catch {}
                return !s;
              });
              inputRef.current?.focus();
            }}
          />
          <ToolButton
            active={camera}
            highlight
            label="Caméra"
            title="Lire les billets avec la caméra de l'appareil"
            icon={<Camera className="h-4 w-4" />}
            onClick={() => writeCameraPref(!camera)}
          />
          <ToolButton
            active={manual}
            highlight
            label="Saisie"
            title="Saisir un numéro à la main (vérification supervisée)"
            icon={<Keyboard className="h-4 w-4" />}
            onClick={() => setManual((m) => !m)}
          />
        </div>
      </div>

      {/* Scène principale : la clé relance les animations à chaque nouveau verdict.
          Le flux caméra est hors de la scène pour ne pas être redémarré à chaque verdict. */}
      <div className="relative">
      {camera && <CameraFeed active={display.kind === "idle"} onCode={submit} />}
      <div
        key={"key" in display ? display.key : display.kind === "pending" ? "pending" : "ready"}
        className={`relative flex min-h-[22rem] flex-col items-center justify-center overflow-hidden rounded-2xl px-6 py-8 text-center transition-colors duration-300 sm:min-h-[26rem] ${stageBg} ${verdictKind === "REFUSED" ? "scan-shake" : ""}`}
        role="status"
        aria-live="assertive"
      >
        {(display.kind === "idle" || display.kind === "reading") && (
          <div className="scan-fade-up">
            <ScanFrame reading={display.kind === "reading"} camera={camera} />
            <div className="mt-6 text-3xl font-black tracking-tight drop-shadow sm:text-4xl">{display.kind === "reading" ? "Lecture…" : "Prêt"}</div>
            <div className={`mt-2 drop-shadow ${camera ? "text-white/90" : "text-slate-400"}`}>
              {display.kind === "reading" ? "Billet détecté" : camera ? "Visez le QR du billet avec la caméra" : "Présentez le QR du billet au lecteur"}
            </div>
          </div>
        )}

        {display.kind === "pending" && (
          <div className="scan-fade-up">
            <svg viewBox="0 0 50 50" className="scan-spin mx-auto h-24 w-24 text-brand-400">
              <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="5" />
              <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray="30 100" />
            </svg>
            <div className="mt-6 text-3xl font-black tracking-tight">Vérification…</div>
          </div>
        )}

        {result && (
          <div className="scan-fade-up w-full">
            <VerdictIcon kind={result.verdict} />
            <div className="mt-5 text-5xl font-black tracking-tight sm:text-6xl">{result.title}</div>
            {result.number && (
              <div className="mt-3 inline-flex items-baseline gap-2 rounded-xl bg-black/15 px-4 py-2">
                <span className="text-lg font-semibold uppercase opacity-90">{result.category}</span>
                <span className="text-4xl font-black tabular-nums sm:text-5xl">{result.number}</span>
              </div>
            )}
            <div className="mt-4 text-lg font-medium sm:text-xl">{result.message}</div>
            {result.offline && (
              <div className="mt-3 inline-block rounded-full bg-black/25 px-3 py-1 text-sm font-semibold uppercase tracking-wide">Hors connexion</div>
            )}
            {result.replayed && <div className="mt-2 text-sm opacity-80">Lecture déjà traitée : même verdict</div>}
          </div>
        )}

        {display.kind === "offline" && (
          <div className="scan-fade-up w-full">
            <VerdictIcon kind="OFFLINE" />
            <div className="mt-5 text-4xl font-black tracking-tight sm:text-5xl">CONNEXION INDISPONIBLE</div>
            <div className="mt-3 text-lg text-slate-300">Billet NON validé. Appliquez la procédure papier, puis renvoyez la lecture.</div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void send(display.value, display.operationId);
              }}
              className="mt-6 rounded-xl bg-white px-6 py-3 text-lg font-bold text-slate-900 hover:bg-slate-100"
            >
              Renvoyer la même lecture
            </button>
          </div>
        )}

        {display.kind === "error" && (
          <div className="scan-fade-up w-full">
            <VerdictIcon kind="REFUSED" />
            <div className="mt-5 text-4xl font-black tracking-tight">{display.session ? "SESSION FERMÉE" : "CONTRÔLE IMPOSSIBLE"}</div>
            <div className="mt-3 text-lg">{display.message}</div>
            {display.session && (
              <a href="/login" className="mt-6 inline-block rounded-xl bg-white px-6 py-3 text-lg font-bold text-slate-900">
                Se reconnecter
              </a>
            )}
          </div>
        )}

        {/* Retour automatique à « Prêt » */}
        {resetMs && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/20">
            <div className="scan-countdown h-full bg-white/70" style={{ animationDuration: `${resetMs}ms` }} />
          </div>
        )}
      </div>
      </div>

      {/* Saisie manuelle (visible uniquement sur demande) */}
      {manual && (
        <form onSubmit={onManual} className="scan-fade-up mt-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
          <input
            ref={manualRef}
            autoFocus
            autoComplete="off"
            placeholder="Numéro (012) ou catégorie + numéro (VIP 012)"
            className="!mt-0 !rounded-xl !border-slate-700 !bg-slate-900 !py-3 !text-lg !text-white placeholder:!text-slate-500"
          />
          <button className="shrink-0 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700">Vérifier</button>
        </form>
      )}

      {/* Dérogation (verdict « à vérifier ») */}
      {result?.overridable && (
        <div className="scan-fade-up mt-4 rounded-2xl border border-amber-400/50 bg-amber-400/10 p-4" onClick={(e) => e.stopPropagation()}>
          {canOverride ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block grow !text-amber-100">
                Motif de la dérogation (superviseur)
                <input
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Billet papier vérifié, retard justifié…"
                  className="!border-amber-400/40 !bg-slate-900 !text-white"
                />
              </label>
              <button
                onClick={() => override(result)}
                disabled={overrideReason.trim().length < 5}
                className="rounded-xl bg-amber-500 px-5 py-2.5 font-semibold text-slate-950 disabled:opacity-40"
              >
                Admettre par dérogation
              </button>
            </div>
          ) : (
            <p className="text-lg font-semibold text-amber-200">Ne pas faire entrer : appelez le superviseur.</p>
          )}
        </div>
      )}

      {notice && <p className="scan-fade-up mt-4 rounded-xl bg-white/10 p-3 text-sm">{notice}</p>}

      {/* Historique et incident */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-white/5 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Dernières lectures</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">Aucune lecture pour l&apos;instant.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.map((h) => (
                <li key={h.id} className="scan-fade-up flex items-center gap-3">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      h.verdict === "VALID" ? "bg-emerald-400" : h.verdict === "CHECK" ? "bg-amber-400" : h.verdict === "OFFLINE" ? "bg-slate-400" : "bg-red-400"
                    }`}
                  />
                  <span className="tabular-nums text-slate-500">{h.at}</span>
                  <span className="font-semibold">{h.title}</span>
                  {h.detail && <span className="text-slate-400">{h.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl bg-white/5 p-4" onClick={(e) => e.stopPropagation()}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Incident / superviseur</h2>
          {incident === null ? (
            <button onClick={() => setIncident("")} className="rounded-xl bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15">
              Signaler un incident
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={incident}
                onChange={(e) => setIncident(e.target.value)}
                rows={2}
                placeholder="Litige, copie de billet, flasheur en panne…"
                className="!border-slate-700 !bg-slate-900 !text-white"
              />
              <div className="flex gap-2">
                <button
                  onClick={sendIncident}
                  disabled={incident.trim().length < 3}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-40"
                >
                  Envoyer au superviseur
                </button>
                <button onClick={() => setIncident(null)} className="px-3 py-2 text-sm text-slate-400">
                  Annuler
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
