"use client";

import { startTransition, useActionState, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

type Quote = { quantity: number; faceValueGnf: number; maxDiscountGnf: number; ranges: string; numbers: string; sellerId: string; categoryId: string };
type QuoteState = { error?: string; quote?: Quote } | null;
type ActionState = { error?: string; ok?: string } | null;

const gnf = (n: number) => `${n.toLocaleString("fr-FR")} GNF`;

/**
 * Vente en deux temps : 1) saisie ou scan des billets, contrôle et chiffrage ; 2) remise,
 * moyen de paiement et confirmation. Rien n'est enregistré avant la confirmation.
 */
export function SaleForm({
  eventId,
  sellers,
  categories,
  defaultSellerId,
  canOverrideDiscount,
  quoteAction,
  saleAction,
  qrAction,
}: {
  eventId: string;
  sellers: { id: string; name: string }[];
  /** Catégories de l'événement : chaque catégorie a sa propre numérotation. */
  categories: { id: string; name: string }[];
  defaultSellerId: string;
  canOverrideDiscount: boolean;
  quoteAction: (prev: QuoteState, form: FormData) => Promise<QuoteState>;
  saleAction: (prev: ActionState, form: FormData) => Promise<ActionState>;
  qrAction: (eventId: string, value: string) => Promise<{ number?: string; categoryId?: string; categoryName?: string; error?: string }>;
}) {
  const [quoteState, quote, quoting] = useActionState(quoteAction, null);
  const [numbers, setNumbers] = useState("");
  const [sellerId, setSellerId] = useState(defaultSellerId);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [discount, setDiscount] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [saleState, sell, selling] = useActionState(async (prev: ActionState, form: FormData) => {
    const r = await saleAction(prev, form);
    if (r?.ok) {
      // Vente enregistrée : on repart d'une saisie vide, prêt pour la suivante.
      setDone(r.ok);
      setNumbers("");
      setDiscount(0);
      scanRef.current?.focus();
    }
    return r;
  }, null);

  const q =
    quoteState?.quote && quoteState.quote.numbers === numbers && quoteState.quote.sellerId === sellerId && quoteState.quote.categoryId === categoryId
      ? quoteState.quote
      : null;

  async function onScan(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = e.currentTarget.value;
    e.currentTarget.value = "";
    if (!value.trim()) return;
    const r = await qrAction(eventId, value);
    if (r.error || !r.number) return setScanMsg(r.error ?? "QR illisible.");
    const list = numbers.split(/[,;\s]+/).filter(Boolean);
    // Une vente porte sur une seule catégorie : le premier billet scanné la fixe.
    if (list.length === 0 && r.categoryId) setCategoryId(r.categoryId);
    else if (r.categoryId && r.categoryId !== categoryId) {
      return setScanMsg(`${r.categoryName} ${r.number} : autre catégorie, enregistrez-le dans une vente séparée.`);
    }
    if (list.includes(r.number)) return setScanMsg(`${r.number} déjà dans la liste.`);
    setNumbers([...list, r.number].join(", "));
    setScanMsg(`${r.categoryName ?? ""} ${r.number} ajouté.`.trim());
    setDone(null);
  }

  function check(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const data = new FormData(e.currentTarget);
    startTransition(() => quote(data));
  }

  function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => sell(data));
  }


  return (
    <div className="space-y-4">
      <form onSubmit={check} className="space-y-3">
        <input type="hidden" name="eventId" value={eventId} />
        {sellers.length > 1 ? (
          <label className="block">
            Vendeur
            <select name="sellerId" value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        ) : (
          <input type="hidden" name="sellerId" value={sellerId} />
        )}
        {categories.length > 1 ? (
          <label className="block">
            Catégorie
            <select
              name="categoryId"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setDone(null);
              }}
            >
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ) : (
          <input type="hidden" name="categoryId" value={categoryId} />
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            Billets vendus
            <textarea
              name="numbers"
              rows={2}
              value={numbers}
              onChange={(e) => {
                setNumbers(e.target.value);
                setDone(null);
              }}
              placeholder="101-110, 125"
              required
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">Plages continues et numéros isolés, séparés par des virgules.</span>
          </label>
          <label className="block">
            Ou scanner les QR (flasheur)
            <input ref={scanRef} onKeyDown={onScan} placeholder="Placez le curseur ici puis scannez" autoComplete="off" />
            <span className="mt-1 block text-xs font-normal text-slate-500">{scanMsg ?? "Chaque billet scanné s'ajoute à la liste. Le scan ne vend rien tant que la vente n'est pas confirmée."}</span>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button disabled={quoting} className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50">
            {quoting ? "…" : "Vérifier les billets"}
          </button>
          {quoteState?.error && <p className="text-sm text-red-700" role="alert">{quoteState.error}</p>}
          {done && <p className="text-sm text-green-700">{done}</p>}
        </div>
      </form>

      {q && !done && (
        <form onSubmit={confirm} className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
          <input type="hidden" name="eventId" value={eventId} />
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="categoryId" value={q.categoryId} />
          <input type="hidden" name="numbers" value={q.numbers} />
          <p className="text-sm">
            <strong>{q.quantity}</strong> billet(s) : {q.ranges}
            <br />
            Prix facial : <strong>{gnf(q.faceValueGnf)}</strong>
            {q.maxDiscountGnf > 0 && <> · remise autorisée jusqu&apos;à {gnf(q.maxDiscountGnf)}</>}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              Remise (GNF)
              <input
                name="discountGnf"
                type="number"
                min={0}
                max={canOverrideDiscount ? q.faceValueGnf : q.maxDiscountGnf}
                step={1}
                value={discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
                disabled={!canOverrideDiscount && q.maxDiscountGnf === 0}
              />
            </label>
            <label className="block">
              Moyen de paiement déclaré
              <select name="paymentMethod" defaultValue="CASH">
                <option value="CASH">Espèces</option>
                <option value="TRANSFER">Transfert (mobile money, virement)</option>
                <option value="OTHER">Autre</option>
              </select>
            </label>
            <label className="block">
              Référence (facultatif)
              <input name="paymentRef" placeholder="N° de transaction…" />
            </label>
          </div>
          {canOverrideDiscount && discount > q.maxDiscountGnf && (
            <label className="block">
              Motif de la remise exceptionnelle
              <input name="reason" required />
            </label>
          )}
          <p className="text-base">
            Montant encaissé : <strong>{gnf(Math.max(0, q.faceValueGnf - (discount || 0)))}</strong>
          </p>
          <div className="flex items-center gap-3">
            <button disabled={selling} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50">
              {selling ? "…" : "Confirmer la vente"}
            </button>
            {saleState?.error && <p className="text-sm text-red-700" role="alert">{saleState.error}</p>}
          </div>
        </form>
      )}
    </div>
  );
}
