"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { formatNumber, pageCount, pageLayout, TICKETS_PER_PAGE } from "@/lib/numbering";

type ActionState = { error?: string; ok?: string } | null;
type Option = { id: string; label: string };
type CategoryOption = Option & { remaining: number; nextNumber: number };

export function BatchForm({
  eventId,
  categories,
  templates,
  profiles,
  action,
}: {
  eventId: string;
  categories: CategoryOption[];
  templates: Option[];
  profiles: Option[];
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [printProfileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [quantity, setQuantity] = useState(100);
  const [layout, setLayout] = useState<"SEQUENTIAL" | "STACKS">("SEQUENTIAL");
  const [confirmed, setConfirmed] = useState(false);

  const category = categories.find((c) => c.id === categoryId);
  // Chaque catégorie a sa propre numérotation (001, 002…).
  const nextNumber = category?.nextNumber ?? 1;
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 10_000;
  const pages = valid ? pageCount(quantity) : 0;
  const lastFill = valid ? quantity - (pages - 1) * TICKETS_PER_PAGE : 0;
  const firstPage = valid ? pageLayout(nextNumber, quantity, layout)[0] : [];
  const overQuota = category ? quantity > category.remaining : false;
  const previewUrl = `/api/batches/preview?${new URLSearchParams({ categoryId, templateId, printProfileId, quantity: String(quantity), layout })}`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  }

  if (templates.length === 0) {
    return <p className="text-sm text-slate-600">Aucun modèle prêt pour la production. Importez le design du ticket au format 210 × 59,4 mm, placez le QR et les numéros, puis validez son BAT dans{" "}
        <a href={`/events/${eventId}/templates`} className="text-blue-700 underline">Modèles de billets</a>.</p>;
  }
  if (categories.length === 0) return <p className="text-sm text-slate-600">Créez d&apos;abord une catégorie dans « Paramètres ».</p>;

  return (
    <form onSubmit={submit} className="space-y-4">
      <input type="hidden" name="eventId" value={eventId} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          Catégorie
          <select name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.label} — {c.remaining.toLocaleString("fr-FR")} disponibles</option>
            ))}
          </select>
        </label>
        <label className="block">
          Modèle (BAT validé)
          <select name="templateId" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label className="block">
          Profil d&apos;impression
          <select name="printProfileId" value={printProfileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="block">
          Quantité
          <input name="quantity" type="number" min={1} max={10000} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} required />
        </label>
        <label className="block">
          Disposition des tickets
          <select name="layout" value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
            <option value="SEQUENTIAL">Séquentielle (001–005 sur la page 1)</option>
            <option value="STACKS">Découpe en piles</option>
          </select>
        </label>
      </div>

      {valid && (
        <div className="rounded-md bg-slate-50 p-4 text-sm">
          <p>
            Numéros prévus en {category?.label} : <strong>{formatNumber(nextNumber)}</strong> à <strong>{formatNumber(nextNumber + quantity - 1)}</strong>{" "}
            <span className="text-slate-500">(attribués définitivement à la génération)</span>
          </p>
          <p>
            <strong>{pages}</strong> page{pages > 1 ? "s" : ""} A4, cinq tickets par page ; dernière page :{" "}
            {lastFill === TICKETS_PER_PAGE
              ? "complète"
              : `${lastFill} ticket${lastFill > 1 ? "s" : ""} et ${TICKETS_PER_PAGE - lastFill} emplacement${TICKETS_PER_PAGE - lastFill > 1 ? "s vides" : " vide"}`}.
          </p>
          <p>Page 1, de haut en bas : {firstPage.map((n) => (n === null ? "vide" : formatNumber(n))).join(", ")}</p>
          {layout === "STACKS" && (
            <p className="mt-1 text-slate-600">
              Après découpe, empilez les piles des positions 1, 2, 3, 4 puis 5 : la suite redevient continue.
            </p>
          )}
          {overQuota && <p className="mt-1 font-medium text-red-700">Quantité supérieure au quota disponible de la catégorie.</p>}
          <a href={previewUrl} target="_blank" className="mt-3 inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100">
            Aperçu : première planche et dernière page
          </a>
        </div>
      )}

      <label className="flex items-center gap-2 font-normal">
        <input type="checkbox" name="confirm" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        J&apos;ai vérifié l&apos;aperçu ; les billets générés ne pourront pas être supprimés (seulement annulés).
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !valid || overQuota || !confirmed}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {pending ? "Génération…" : `Générer ${valid ? quantity.toLocaleString("fr-FR") : ""} billets`}
        </button>
        {state?.error && <p className="text-sm text-red-700" role="alert">{state.error}</p>}
      </div>
    </form>
  );
}
