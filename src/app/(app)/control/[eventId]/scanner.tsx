"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

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
};
type Display =
  | { kind: "idle" }
  | { kind: "pending"; value: string }
  | { kind: "result"; result: ScanResult }
  | { kind: "offline"; value: string; operationId: string }
  | { kind: "error"; message: string; session?: boolean };
type HistoryItem = { at: string; title: string; number: string | null; verdict: Verdict | "OFFLINE" };

const TIMEOUT_MS = 4_000;
/** Même valeur relue dans ce délai = double signal du flasheur : même opération, même verdict. */
const DOUBLE_SIGNAL_MS = 1_200;

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

/** Signal sonore : aigu = valide, deux graves = refusé, moyen long = à vérifier. */
function beep(kind: Verdict | "OFFLINE") {
  try {
    const ctx = new AudioContext();
    const tones: [number, number, number][] =
      kind === "VALID" ? [[880, 0, 0.15]] : kind === "CHECK" ? [[520, 0, 0.45]] : [[220, 0, 0.18], [220, 0.25, 0.18]];
    for (const [freq, start, dur] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === "VALID" ? "sine" : "square";
      o.frequency.value = freq;
      g.gain.value = 0.25;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // Pas de son disponible : l'affichage suffit.
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return null; // réseau indisponible ou délai dépassé
  } finally {
    clearTimeout(timer);
  }
}

export function Scanner({
  eventId,
  gate,
  canOverride,
  reentry,
  tz,
}: {
  eventId: string;
  gate: { id: string; name: string };
  canOverride: boolean;
  reentry: boolean;
  tz: string;
}) {
  const [display, setDisplay] = useState<Display>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [online, setOnline] = useState(true);
  // Préférence de son propre au poste (lue au premier rendu côté navigateur).
  const [sound, setSound] = useState(() => {
    try {
      return typeof window === "undefined" || localStorage.getItem("controle-son") !== "0";
    } catch {
      return true;
    }
  });
  const [mode, setMode] = useState<"ENTRY" | "EXIT">("ENTRY");
  const [overrideReason, setOverrideReason] = useState("");
  const [incident, setIncident] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ value: string; at: number; operationId: string } | null>(null);
  const device = useRef("");

  useEffect(() => {
    device.current = deviceId();
  }, []);

  // Champ de lecture toujours prêt : on y revient dès que le focus se perd dans le vide.
  useEffect(() => {
    const id = setInterval(() => {
      const a = document.activeElement;
      if (!a || a === document.body) inputRef.current?.focus();
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Témoin réseau.
  useEffect(() => {
    let stop = false;
    const ping = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
        if (!stop) setOnline(r.ok);
      } catch {
        if (!stop) setOnline(false);
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
  }, []);

  const pushHistory = useCallback((item: HistoryItem) => setHistory((h) => [item, ...h].slice(0, 8)), []);

  const send = useCallback(
    async (value: string, operationId: string) => {
      setDisplay({ kind: "pending", value });
      setOverrideReason("");
      const r = await postJson("/api/scan", { eventId, gateId: gate.id, value, operationId, deviceId: device.current, mode });
      const now = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
      if (!r) {
        // Jamais « valide » sans réponse du serveur.
        setOnline(false);
        setDisplay({ kind: "offline", value, operationId });
        pushHistory({ at: now, title: "CONNEXION INDISPONIBLE", number: null, verdict: "OFFLINE" });
        if (sound) beep("OFFLINE");
        return;
      }
      setOnline(true);
      if (r.status !== 200) {
        setDisplay({ kind: "error", message: String(r.data.error ?? "Erreur du serveur."), session: r.status === 401 });
        if (sound) beep("REFUSED");
        return;
      }
      const result = r.data as unknown as ScanResult;
      setDisplay({ kind: "result", result });
      pushHistory({ at: now, title: result.title, number: result.number, verdict: result.verdict });
      if (sound) beep(result.verdict);
    },
    [eventId, gate.id, mode, pushHistory, sound, tz],
  );

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = e.currentTarget.value.trim();
    e.currentTarget.value = "";
    if (!value || display.kind === "pending") return;
    const now = Date.now();
    const repeat = last.current && last.current.value === value && now - last.current.at < DOUBLE_SIGNAL_MS;
    const operationId = repeat ? last.current!.operationId : newOperationId();
    last.current = { value, at: now, operationId };
    void send(value, operationId);
  }

  async function override(result: ScanResult) {
    const r = await postJson("/api/scan/override", { scanId: result.scanId, reason: overrideReason, operationId: newOperationId() });
    if (!r) return setNotice("Connexion indisponible : dérogation non enregistrée.");
    if (r.status !== 200) return setNotice(String(r.data.error ?? "Erreur."));
    const res = r.data as unknown as ScanResult;
    setDisplay({ kind: "result", result: res });
    pushHistory({ at: new Date().toLocaleTimeString("fr-FR"), title: res.title, number: res.number, verdict: res.verdict });
    if (sound) beep(res.verdict);
    setNotice(null);
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

  const panel = (() => {
    switch (display.kind) {
      case "idle":
        return { bg: "bg-slate-200 text-slate-600", title: mode === "EXIT" ? "MODE SORTIE" : "PRÊT", sub: "Scannez un billet" };
      case "pending":
        return { bg: "bg-slate-300 text-slate-700", title: "…", sub: "Vérification en cours" };
      case "offline":
        return { bg: "bg-slate-900 text-white", title: "CONNEXION INDISPONIBLE", sub: "Billet NON validé. Appliquez la procédure papier, puis renvoyez la lecture." };
      case "error":
        return { bg: "bg-red-700 text-white", title: display.session ? "SESSION FERMÉE" : "CONTRÔLE IMPOSSIBLE", sub: display.message };
      case "result": {
        const r = display.result;
        const bg = r.verdict === "VALID" ? "bg-green-600 text-white" : r.verdict === "CHECK" ? "bg-orange-500 text-white" : "bg-red-600 text-white";
        return { bg, title: r.title, sub: r.message };
      }
    }
  })();

  const result = display.kind === "result" ? display.result : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded bg-slate-800 px-2 py-1 font-semibold text-white">{gate.name}</span>
        <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium ${online ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-green-600" : "animate-pulse bg-red-600"}`} />
          {online ? "Connecté" : "Hors connexion"}
        </span>
        {reentry && (
          <div className="inline-flex overflow-hidden rounded border border-slate-300">
            {(["ENTRY", "EXIT"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setDisplay({ kind: "idle" });
                  inputRef.current?.focus();
                }}
                className={`px-3 py-1 font-medium ${mode === m ? "bg-slate-800 text-white" : "bg-white"}`}
              >
                {m === "ENTRY" ? "Entrée" : "Sortie"}
              </button>
            ))}
          </div>
        )}
        <label className="ml-auto flex items-center gap-2 font-normal">
          <input
            type="checkbox"
            suppressHydrationWarning
            checked={sound}
            onChange={(e) => {
              setSound(e.target.checked);
              try {
                localStorage.setItem("controle-son", e.target.checked ? "1" : "0");
              } catch {}
            }}
          />
          Son
        </label>
      </div>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          // Flasheur Bluetooth en mode clavier : pas de clavier virtuel, sauf saisie manuelle demandée.
          inputMode={keyboard ? "text" : "none"}
          aria-label="Champ de lecture du flasheur"
          placeholder="Scannez un billet…"
          className="!mt-0 !py-3 text-center !text-lg"
        />
        <button
          onClick={() => {
            setKeyboard((k) => !k);
            inputRef.current?.focus();
          }}
          className={`shrink-0 rounded-md border px-3 text-sm ${keyboard ? "border-slate-800 bg-slate-800 text-white" : "border-slate-300 bg-white"}`}
          title="Afficher le clavier pour saisir un numéro (saisie manuelle : vérification supervisée)"
        >
          Clavier
        </button>
      </div>

      <div className={`rounded-xl px-6 py-10 text-center shadow-sm transition-colors ${panel.bg}`} role="status" aria-live="assertive">
        <div className="text-5xl font-black tracking-tight sm:text-7xl">{panel.title}</div>
        {result?.number && (
          <div className="mt-4 text-3xl font-bold sm:text-4xl">
            N° {result.number} <span className="font-semibold opacity-90">· {result.category}</span>
          </div>
        )}
        <div className="mt-3 text-lg sm:text-xl">{panel.sub}</div>
        {result?.replayed && <div className="mt-2 text-sm opacity-80">(lecture déjà traitée : même verdict)</div>}
      </div>

      {display.kind === "offline" && (
        <button
          onClick={() => send(display.value, display.operationId)}
          className="w-full rounded-lg bg-slate-800 py-4 text-lg font-bold text-white hover:bg-slate-900"
        >
          Renvoyer la même lecture
        </button>
      )}
      {display.kind === "error" && display.session && (
        <a href="/login" className="block w-full rounded-lg bg-slate-800 py-4 text-center text-lg font-bold text-white">Se reconnecter</a>
      )}

      {result?.overridable && (
        <div className="rounded-lg border-2 border-orange-400 bg-orange-50 p-4">
          {canOverride ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block grow">
                Motif de la dérogation (superviseur)
                <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Billet papier vérifié, retard justifié…" />
              </label>
              <button
                onClick={() => override(result)}
                disabled={overrideReason.trim().length < 5}
                className="rounded-md bg-orange-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
              >
                Admettre par dérogation
              </button>
            </div>
          ) : (
            <p className="text-lg font-semibold text-orange-900">Ne pas faire entrer : appelez le superviseur.</p>
          )}
        </div>
      )}

      {notice && <p className="rounded-md bg-slate-100 p-3 text-sm">{notice}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Dernières lectures</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">Aucune lecture.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {history.map((h, i) => (
                <li key={i} className="flex gap-2">
                  <span className="tabular-nums text-slate-500">{h.at}</span>
                  <span
                    className={`font-semibold ${h.verdict === "VALID" ? "text-green-700" : h.verdict === "CHECK" ? "text-orange-600" : h.verdict === "OFFLINE" ? "text-slate-900" : "text-red-700"}`}
                  >
                    {h.title}
                  </span>
                  {h.number && <span>n° {h.number}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Incident / superviseur</h2>
          {incident === null ? (
            <button onClick={() => setIncident("")} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100">
              Signaler un incident
            </button>
          ) : (
            <div className="space-y-2">
              <textarea value={incident} onChange={(e) => setIncident(e.target.value)} rows={2} placeholder="Litige, copie de billet, flasheur en panne…" />
              <div className="flex gap-2">
                <button onClick={sendIncident} disabled={incident.trim().length < 3} className="rounded-md bg-slate-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  Envoyer au superviseur
                </button>
                <button onClick={() => setIncident(null)} className="px-3 py-2 text-sm text-slate-600">Annuler</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
