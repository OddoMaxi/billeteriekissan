"use client";

import jsQR from "jsqr";
import { Flashlight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Intervalle entre deux analyses d'image (ms) : assez rapide, sans vider la batterie. */
const SCAN_EVERY_MS = 120;
/** Un même QR maintenu devant l'objectif n'est relu qu'après être sorti du champ pendant ce délai. */
const SAME_CODE_GAP_MS = 1_500;
/** Largeur maximale de l'image analysée par jsQR (réduite pour la vitesse). */
const MAX_DECODE_WIDTH = 720;

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = { new (opts: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

/** Lecteur natif (Chrome Android…) si disponible, sinon jsQR (iPhone, Firefox). */
async function nativeDetector(): Promise<Detector | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? new Ctor({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

function cameraErrorMessage(e: unknown): string {
  if (typeof window !== "undefined" && !window.isSecureContext) return "La caméra exige une connexion sécurisée (https).";
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Accès à la caméra refusé. Autorisez la caméra pour ce site dans les réglages du navigateur, puis réessayez.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Aucune caméra disponible sur cet appareil.";
  if (name === "NotReadableError") return "La caméra est utilisée par une autre application. Fermez-la puis réessayez.";
  return "Impossible de démarrer la caméra.";
}

/**
 * Flux de la caméra arrière, affiché en fond de la scène de contrôle.
 * Le flux reste ouvert tant que le mode caméra est actif ; l'analyse ne tourne que si `active`.
 */
export function CameraFeed({ active, onCode }: { active: boolean; onCode: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const activeRef = useRef(active);
  const onCodeRef = useRef(onCode);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [torch, setTorch] = useState<boolean | null>(null); // null = lampe non disponible
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    activeRef.current = active;
    onCodeRef.current = onCode;
  });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const seen = { value: "", at: 0 };

    async function start() {
      setError(null);
      setStarting(true);
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("", window.isSecureContext ? "NotFoundError" : "SecurityError");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => {});
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorch(caps.torch ? false : null);
        setStarting(false);
        const detector = await nativeDetector();
        loop(detector);
      } catch (e) {
        if (!stopped) {
          setError(cameraErrorMessage(e));
          setStarting(false);
        }
      }
    }

    async function decode(detector: Detector | null): Promise<string | null> {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      if (detector) {
        try {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue ?? null;
        } catch {
          // Lecteur natif défaillant : on bascule sur jsQR.
        }
      }
      if (!ctx) return null;
      const scale = Math.min(1, MAX_DECODE_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
    }

    function loop(detector: Detector | null) {
      timer = setTimeout(async () => {
        if (stopped) return;
        if (activeRef.current && !document.hidden) {
          const value = (await decode(detector))?.trim();
          if (value && !stopped) {
            const t = Date.now();
            const sameAsBefore = value === seen.value && t - seen.at < SAME_CODE_GAP_MS;
            seen.value = value;
            seen.at = t;
            if (!sameAsBefore) onCodeRef.current(value);
          }
        } else if (seen.value) {
          // Pendant l'affichage du verdict, on continue de « voir » le billet pour ne pas le relire aussitôt.
          const value = (await decode(detector))?.trim();
          if (value && value === seen.value) seen.at = Date.now();
        }
        loop(detector);
      }, SCAN_EVERY_MS);
    }

    void start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
  }, [attempt]);

  async function toggleTorch(e: React.MouseEvent) {
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  }

  return (
    <>
      <video ref={videoRef} muted playsInline autoPlay className="absolute inset-0 h-full w-full rounded-2xl bg-black object-cover" />
      {(error || starting) && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 rounded-2xl bg-slate-900 p-6 text-center" onClick={(e) => e.stopPropagation()}>
          {starting ? (
            <p className="text-lg text-slate-300">Démarrage de la caméra…</p>
          ) : (
            <>
              <p className="text-2xl font-black">CAMÉRA INDISPONIBLE</p>
              <p className="text-slate-300">{error}</p>
              <button onClick={() => setAttempt((n) => n + 1)} className="rounded-xl bg-white px-5 py-2.5 font-bold text-slate-900">
                Réessayer
              </button>
            </>
          )}
        </div>
      )}
      {torch !== null && active && !error && (
        <button
          onClick={toggleTorch}
          className={`absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${torch ? "bg-amber-300 text-slate-900" : "bg-black/50 text-white"}`}
        >
          <Flashlight className="h-4 w-4" />
          {torch ? "Lampe allumée" : "Lampe"}
        </button>
      )}
    </>
  );
}
