"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  checkLayout,
  DEFAULT_LAYOUT,
  DEFAULT_STUB_LINE,
  FONTS,
  SAFE_MARGIN_MM,
  type StubLineStyle,
  type NumberZone,
  type QrZone,
  type TemplateLayout,
} from "@/lib/template-layout";

type ActionState = { error?: string; ok?: string } | null;
type ZoneKey = "bodyQr" | "bodyNumber" | "stubQr" | "stubNumber";

const LABELS: Record<ZoneKey, string> = {
  bodyNumber: "Numéro (corps)",
  bodyQr: "QR (corps)",
  stubNumber: "Numéro (talon)",
  stubQr: "QR (talon)",
};

const round = (n: number) => Math.round(n * 2) / 2; // pas de 0,5 mm

/** Rendu de la première page d'un PDF en image, dans le navigateur (pdf.js). */
async function pdfToDataUrl(url: string, widthPx: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ url }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: widthPx / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL("image/png");
}

export function LayoutEditor({
  templateId,
  backgroundUrl,
  mime,
  widthMm,
  heightMm,
  initialLayout,
  locked,
  nextVersion,
  saveAction,
}: {
  templateId: string;
  backgroundUrl: string;
  mime: string;
  widthMm: number;
  heightMm: number;
  initialLayout: TemplateLayout;
  locked: boolean;
  nextVersion: number;
  saveAction: (prev: ActionState, form: FormData) => Promise<ActionState>;
}) {
  const [layout, setLayout] = useState<TemplateLayout>(initialLayout);
  const [bg, setBg] = useState<string | null>(mime === "application/pdf" ? null : backgroundUrl);
  const [bgError, setBgError] = useState(false);
  const [selected, setSelected] = useState<ZoneKey | null>(null);
  const [state, formAction, pending] = useActionState(saveAction, null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ key: ZoneKey; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (mime !== "application/pdf") return;
    pdfToDataUrl(backgroundUrl, 2000).then(setBg, () => setBgError(true));
  }, [backgroundUrl, mime]);

  const check = useMemo(() => checkLayout(layout, { widthMm, heightMm }), [layout, widthMm, heightMm]);
  const dirty = JSON.stringify(layout) !== JSON.stringify(initialLayout);

  function zone(key: ZoneKey): { x: number; y: number; w: number; h: number } | null {
    const z = layout[key];
    if (!z) return null;
    return "size" in z ? { x: z.x, y: z.y, w: z.size, h: z.size } : { x: z.x, y: z.y, w: z.width, h: z.height };
  }

  function update<K extends ZoneKey>(key: K, patch: Partial<NonNullable<TemplateLayout[K]>>) {
    setLayout((l) => ({ ...l, [key]: { ...l[key]!, ...patch } }));
  }

  function toMm(e: PointerEvent) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  function onDown(key: ZoneKey, e: PointerEvent) {
    const z = zone(key)!;
    const p = toMm(e);
    drag.current = { key, dx: p.x - z.x, dy: p.y - z.y };
    setSelected(key);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!drag.current) return;
    const p = toMm(e);
    const { key, dx, dy } = drag.current;
    update(key, { x: round(p.x - dx), y: round(p.y - dy) } as never);
  }

  function submit() {
    const data = new FormData();
    data.set("templateId", templateId);
    data.set("layout", JSON.stringify(layout));
    startTransition(() => formAction(data));
  }

  const previewUrl = `/api/templates/${templateId}/preview?guides=1&layout=${encodeURIComponent(JSON.stringify(layout))}`;
  const m = SAFE_MARGIN_MM;
  const stub = layout.stubLineX;
  const keys: ZoneKey[] = ["bodyNumber", "bodyQr", "stubNumber", "stubQr"];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border border-slate-300 bg-slate-200 p-2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${widthMm} ${heightMm}`}
          className="block w-full min-w-[40rem] touch-none select-none"
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
        >
          <rect width={widthMm} height={heightMm} fill="#fff" />
          {bg && <image href={bg} width={widthMm} height={heightMm} preserveAspectRatio="none" />}
          {/* Marges de sécurité */}
          {(stub === null
            ? [[m, widthMm - 2 * m]]
            : [
                [m, stub - 2 * m],
                [stub + m, widthMm - stub - 2 * m],
              ]
          ).map(([x, w]) => (
            <rect key={x} x={x} y={m} width={w} height={heightMm - 2 * m} fill="none" stroke="#1a5ad8" strokeWidth={0.3} strokeDasharray="1 1" />
          ))}
          {stub !== null && layout.stubLine && (
            // Ligne réellement imprimée (épaisseur en points convertie en mm).
            <line
              x1={stub}
              x2={stub}
              y1={0}
              y2={heightMm}
              stroke={layout.stubLine.color}
              strokeWidth={(layout.stubLine.thickness * 25.4) / 72}
              strokeDasharray={SVG_DASHES[layout.stubLine.style]}
              strokeLinecap={layout.stubLine.style === "dotted" ? "round" : "butt"}
            />
          )}
          {stub !== null && !layout.stubLine && (
            <line x1={stub} x2={stub} y1={0} y2={heightMm} stroke="#d11" strokeWidth={0.4} strokeDasharray="2 1" />
          )}
          {keys.map((key) => {
            const z = zone(key);
            if (!z) return null;
            const active = selected === key;
            return (
              <g key={key} className="cursor-move" onPointerDown={(e) => onDown(key, e)}>
                <rect
                  x={z.x}
                  y={z.y}
                  width={z.w}
                  height={z.h}
                  fill={active ? "rgba(26,90,216,0.35)" : "rgba(220,30,30,0.25)"}
                  stroke={active ? "#1a5ad8" : "#d11"}
                  strokeWidth={0.4}
                />
                <text x={z.x + z.w / 2} y={z.y + z.h / 2 + 0.8} fontSize={Math.min(2.4, z.h / 3)} textAnchor="middle" fill="#000" fontWeight={700}>
                  {LABELS[key]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="text-xs text-slate-500">
        Faites glisser les zones (pas de 0,5 mm) ou saisissez les cotes. Rouge : zones variables · bleu : marge de sécurité de {m} mm · ligne du talon telle qu&apos;imprimée (pointillés rouges si elle n&apos;est pas tracée).
        {mime === "application/pdf" && !bg && !bgError && " Chargement du design…"}
        {bgError && " Le fond PDF n'a pas pu être affiché ici ; utilisez l'aperçu PDF."}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold">Talon</legend>
          <label className="flex items-center gap-2 font-normal">
            <input
              type="checkbox"
              checked={stub !== null}
              onChange={(e) =>
                setLayout((l) =>
                  e.target.checked
                    ? { ...l, stubLineX: DEFAULT_LAYOUT.stubLineX, stubLine: DEFAULT_STUB_LINE, stubQr: DEFAULT_LAYOUT.stubQr, stubNumber: DEFAULT_LAYOUT.stubNumber }
                    : { ...l, stubLineX: null, stubLine: null, stubQr: null, stubNumber: null },
                )
              }
            />
            Le design comporte un talon détachable
          </label>
          {stub !== null && (
            <div className="mt-2 space-y-2">
              <MmInput label="Ligne du talon, x" value={stub} onChange={(v) => setLayout((l) => ({ ...l, stubLineX: v }))} />
              <label className="flex items-center gap-2 font-normal">
                <input
                  type="checkbox"
                  checked={!!layout.stubLine}
                  onChange={(e) => setLayout((l) => ({ ...l, stubLine: e.target.checked ? DEFAULT_STUB_LINE : null }))}
                />
                Tracer la ligne de détachement sur les billets
              </label>
              {layout.stubLine && <StubLineFields value={layout.stubLine} onChange={(p) => setLayout((l) => ({ ...l, stubLine: { ...l.stubLine!, ...p } }))} />}
              <label className="flex items-center gap-2 font-normal">
                <input
                  type="checkbox"
                  checked={!!layout.stubNumber}
                  onChange={(e) => setLayout((l) => ({ ...l, stubNumber: e.target.checked ? (initialLayout.stubNumber ?? DEFAULT_LAYOUT.stubNumber) : null }))}
                />
                Numéro sur le talon
              </label>
              <label className="flex items-center gap-2 font-normal">
                <input
                  type="checkbox"
                  checked={!!layout.stubQr}
                  onChange={(e) => setLayout((l) => ({ ...l, stubQr: e.target.checked ? (initialLayout.stubQr ?? DEFAULT_LAYOUT.stubQr) : null }))}
                />
                QR sur le talon (même contenu : un seul billet, une seule admission)
              </label>
            </div>
          )}
        </fieldset>

        {keys.map((key) => {
          const z = layout[key];
          if (!z) return null;
          return (
            <fieldset
              key={key}
              className={`rounded-md border p-3 ${selected === key ? "border-blue-500" : "border-slate-200"}`}
              onFocus={() => setSelected(key)}
            >
              <legend className="px-1 text-sm font-semibold">{LABELS[key]}</legend>
              {"size" in z ? (
                <QrFields zone={z} onChange={(p) => update(key, p as never)} />
              ) : (
                <NumberFields zone={z} onChange={(p) => update(key, p as never)} />
              )}
            </fieldset>
          );
        })}
      </div>

      {(check.errors.length > 0 || check.warnings.length > 0) && (
        <div className="space-y-1 text-sm">
          {check.errors.map((e) => <p key={e} className="text-red-700">✗ {e}</p>)}
          {check.warnings.map((w) => <p key={w} className="text-orange-700">⚠ {w}</p>)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || !dirty || check.errors.length > 0}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {pending ? "…" : locked ? `Enregistrer comme version ${nextVersion}` : "Enregistrer la disposition"}
        </button>
        <a href={previewUrl} target="_blank" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100">
          Aperçu PDF avec repères
        </a>
        <button type="button" onClick={() => setLayout(initialLayout)} disabled={!dirty} className="text-sm text-slate-600 hover:underline disabled:opacity-40">
          Annuler les changements
        </button>
        <button type="button" onClick={() => setLayout(DEFAULT_LAYOUT)} className="text-sm text-slate-600 hover:underline">
          Disposition proposée
        </button>
        {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
        {state?.ok && !dirty && <p className="text-sm text-green-700">{state.ok}</p>}
      </div>
      {locked && (
        <p className="text-xs text-slate-500">
          Le BAT de cette version est validé : elle est figée. Enregistrer crée la version {nextVersion}, qui devra passer un nouveau BAT.
        </p>
      )}
    </div>
  );
}

const SVG_DASHES: Record<StubLineStyle["style"], string | undefined> = {
  dashed: "2.5 1.5",
  dotted: "0.4 1.1",
  solid: undefined,
};

function StubLineFields({ value, onChange }: { value: StubLineStyle; onChange: (p: Partial<StubLineStyle>) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 pl-6">
      <label className="block font-normal">
        <span className="text-xs text-slate-600">Style</span>
        <select value={value.style} onChange={(e) => onChange({ style: e.target.value as StubLineStyle["style"] })} className="!mt-0.5 !py-1">
          <option value="dashed">Tirets</option>
          <option value="dotted">Pointillés</option>
          <option value="solid">Trait plein</option>
        </select>
      </label>
      <label className="block font-normal">
        <span className="text-xs text-slate-600">Couleur</span>
        <input type="color" value={value.color} onChange={(e) => onChange({ color: e.target.value })} className="!mt-0.5 !h-8 !p-0.5" />
      </label>
      <label className="block font-normal">
        <span className="text-xs text-slate-600">Épaisseur (pt)</span>
        <input
          type="number"
          step={0.1}
          min={0.3}
          max={2}
          value={value.thickness}
          onChange={(e) => onChange({ thickness: Number(e.target.value) })}
          className="!mt-0.5 !py-1"
        />
      </label>
    </div>
  );
}

function MmInput({ label, value, onChange, step = 0.5 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="block font-normal">
      <span className="text-xs text-slate-600">{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="!mt-0.5 !py-1" />
    </label>
  );
}

function QrFields({ zone, onChange }: { zone: QrZone; onChange: (p: Partial<QrZone>) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <MmInput label="x (mm)" value={zone.x} onChange={(x) => onChange({ x })} />
      <MmInput label="y (mm)" value={zone.y} onChange={(y) => onChange({ y })} />
      <MmInput label="côté (mm)" value={zone.size} onChange={(size) => onChange({ size })} />
    </div>
  );
}

function NumberFields({ zone, onChange }: { zone: NumberZone; onChange: (p: Partial<NumberZone>) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <MmInput label="x (mm)" value={zone.x} onChange={(x) => onChange({ x })} />
      <MmInput label="y (mm)" value={zone.y} onChange={(y) => onChange({ y })} />
      <MmInput label="largeur" value={zone.width} onChange={(width) => onChange({ width })} />
      <MmInput label="hauteur" value={zone.height} onChange={(height) => onChange({ height })} />
      <MmInput label="taille (pt)" step={1} value={zone.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
      <label className="col-span-2 block font-normal">
        <span className="text-xs text-slate-600">Police</span>
        <select value={zone.font} onChange={(e) => onChange({ font: e.target.value as NumberZone["font"] })} className="!mt-0.5 !py-1">
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
      </label>
      <label className="block font-normal">
        <span className="text-xs text-slate-600">Couleur</span>
        <input type="color" value={zone.color} onChange={(e) => onChange({ color: e.target.value })} className="!mt-0.5 !h-8 !p-0.5" />
      </label>
      <label className="col-span-4 block font-normal">
        <span className="text-xs text-slate-600">Préfixe (vide par défaut : « 001 »)</span>
        <input value={zone.prefix} maxLength={10} onChange={(e) => onChange({ prefix: e.target.value })} className="!mt-0.5 !py-1" />
      </label>
    </div>
  );
}
