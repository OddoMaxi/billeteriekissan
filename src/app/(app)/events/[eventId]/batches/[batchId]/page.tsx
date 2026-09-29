import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Stat } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { workerAlive } from "@/lib/batches";
import { db } from "@/lib/db";
import { formatNumber, pageCount } from "@/lib/numbering";
import { formatDateTime, formatGnf } from "@/lib/time";
import { destroyPdfAction, retryBatch } from "../../../batch-actions";
import { activationAction } from "../../../stock-actions";
import { BatchStatusBadge } from "../status";
import { AutoRefresh } from "./auto-refresh";

export default async function BatchPage({ params }: PageProps<"/events/[eventId]/batches/[batchId]">) {
  const { eventId, batchId } = await params;
  const access = await requireEventPermission(eventId, "tickets.view");
  const isAdmin = access.user.isAdmin;
  const b = await db.batch.findFirst({
    where: { id: batchId, eventId },
    include: { event: true, category: true, template: true, printProfile: true },
  });
  if (!b) notFound();
  const [creator, states, blocked, activated] = await Promise.all([
    db.user.findUnique({ where: { id: b.createdById }, select: { name: true } }),
    db.ticket.groupBy({ by: ["commercialState"], where: { batchId }, _count: true }),
    db.ticket.findMany({ where: { batchId, blockState: { not: "NONE" } }, orderBy: { number: "asc" }, select: { number: true, blockState: true } }),
    db.ticket.count({ where: { batchId, activatedAt: { not: null } } }),
  ]);
  const count = (s: string) => states.find((x) => x.commercialState === s)?._count ?? 0;
  const tz = b.event.timezone;
  const totalPages = b.pageCount ?? pageCount(b.quantity, b.ticketsPerPage);
  const inProgress = b.status === "PREPARING" || b.status === "GENERATING";
  const alive = inProgress ? await workerAlive() : true;

  return (
    <>
      <AutoRefresh active={inProgress} intervalMs={alive ? 1500 : 5000} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href={`/events/${eventId}/batches`} className="text-sm text-blue-700 hover:underline">← Lots</Link>
        <h2 className="text-xl font-bold">Lot {b.category.name} {formatNumber(b.firstNumber)} → {formatNumber(b.lastNumber)}</h2>
        <BatchStatusBadge status={b.status} />
      </div>

      {inProgress && (
        <Card>
          <p className="mb-2 text-sm">
            {!alive
              ? "Le service de génération ne répond pas : le lot est en attente. Démarrez-le (npm run worker) ; il reprendra ce lot avec les billets déjà créés, sans en ajouter."
              : b.status === "PREPARING"
                ? "Billets enregistrés ; lot en file d'attente du service de génération."
                : `Génération du PDF en cours : ${b.progressPages} / ${totalPages} pages.`}
          </p>
          <div className="h-2 overflow-hidden rounded bg-slate-200">
            <div className="h-2 bg-blue-600 transition-all" style={{ width: `${Math.round((b.progressPages / totalPages) * 100)}%` }} />
          </div>
        </Card>
      )}
      {b.status === "FAILED" && (
        <Card>
          <p className="text-sm text-red-700">Échec de la génération : {b.error}</p>
          <p className="mt-1 text-sm text-slate-600">Aucun PDF partiel n&apos;est disponible. La relance reprend exactement les mêmes billets.</p>
        </Card>
      )}
      {isAdmin && b.status === "FAILED" && (
        <form action={retryBatch.bind(null, eventId, b.id)} className="mb-6">
          <button className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">Relancer la génération</button>
        </form>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Billets" value={b.quantity.toLocaleString("fr-FR")} sub={`${formatNumber(b.firstNumber)} à ${formatNumber(b.lastNumber)}`} />
        <Stat label="Pages A4" value={totalPages} sub={`${b.ticketsPerPage} tickets par page · ${b.layout === "STACKS" ? "découpe en piles" : "ordre séquentiel"}`} />
        <Stat label="En stock central" value={count("IN_STOCK").toLocaleString("fr-FR")} />
        <Stat label="Retirés" value={blocked.length} sub="annulés, perdus, détruits" />
      </div>

      <Card title="Manifeste">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row k="Événement" v={b.event.name} />
          <Row k="Catégorie" v={`${b.category.name} · ${formatGnf(b.category.priceGnf)}`} />
          <Row k="Quantité" v={`${b.quantity} = ${formatNumber(b.lastNumber)} − ${formatNumber(b.firstNumber)} + 1`} />
          <Row k="Bornes" v={`${formatNumber(b.firstNumber)} → ${formatNumber(b.lastNumber)}`} />
          <Row k="Modèle" v={`${b.template.name} version ${b.template.version}`} />
          <Row k="Profil d'impression" v={b.printProfile.name} />
          <Row k="Empreinte du PDF (SHA-256)" v={<span className="break-all font-mono text-xs">{b.pdfSha256 ?? "—"}</span>} />
          <Row k="Créé" v={`${formatDateTime(b.createdAt, tz)} par ${creator?.name ?? "—"}`} />
          <Row k="Prêt le" v={formatDateTime(b.readyAt, tz)} />
          {b.pdfDestroyedAt && <Row k="PDF supprimé le" v={formatDateTime(b.pdfDestroyedAt, tz)} />}
        </dl>
        {blocked.length > 0 && (
          <p className="mt-3 text-sm">
            Billets retirés : {blocked.map((t) => `${formatNumber(t.number)} (${t.blockState.toLowerCase()})`).join(", ")}
          </p>
        )}
        <a href={`/api/batches/${b.id}/manifest`} className="mt-4 inline-block text-sm text-blue-700 hover:underline">Télécharger le manifeste (JSON)</a>
      </Card>

      {access.can("stock.assign") && b.status === "READY" && (
        <Card title="Activation du lot">
          <p className="mb-3 text-sm text-slate-600">
            {activated === 0 ? "Aucun billet activé." : `${activated} billet(s) sur ${b.quantity} activé(s).`} Un billet activé passe au contrôle
            même sans vente déclarée (ventes trop rapides pour être saisies) ; « activé » reste distinct de « vendu » dans les rapports.
          </p>
          {activated < b.quantity - blocked.length && (
            <ActionForm action={activationAction} submitLabel={`Activer les billets ${formatNumber(b.firstNumber)} à ${formatNumber(b.lastNumber)}`} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="mode" value="activate" />
              <input type="hidden" name="scope" value="batch" />
              <input type="hidden" name="categoryId" value={b.categoryId} />
              <input type="hidden" name="numbers" value={`${b.firstNumber}-${b.lastNumber}`} />
              <Field label="Motif"><input name="reason" placeholder="Vente rapide au guichet" className="!w-72" /></Field>
            </ActionForm>
          )}
          {activated > 0 && activated === b.quantity - blocked.length && <p className="text-sm text-green-700">Tout le lot est activé.</p>}
          <p className="mt-2 text-xs text-slate-500">Pour une partie du lot ou une désactivation : onglet Stock.</p>
        </Card>
      )}

      {isAdmin && b.status === "READY" && (
        <>
          <Card title="Impression">
            {b.pdfPath ? (
              <>
                <a href={`/api/batches/${b.id}/pdf`} className="inline-block rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
                  Télécharger le PDF ({totalPages} pages)
                </a>
                <p className="mt-2 text-xs text-slate-500">
                  Imprimez en A4 portrait, taille réelle 100 %, sans « ajuster à la page ». Chaque téléchargement est journalisé.
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600">Le PDF a été supprimé du stockage. Utilisez la réimpression pour le régénérer à l&apos;identique.</p>
            )}
          </Card>

          <Card title="Réimpression">
            <p className="mb-3 text-sm text-slate-600">
              Reproduit exactement les mêmes billets (mêmes numéros, mêmes QR) : aucun billet ni droit d&apos;entrée n&apos;est créé.
              Pour le lot complet, le fichier est vérifié identique à l&apos;original. Motif obligatoire, opération journalisée.
            </p>
            <form action={`/api/batches/${b.id}/reprint`} method="post" target="_blank" className="space-y-3">
              <Field label="Motif"><input name="reason" minLength={5} required placeholder="Bourrage imprimante pages 12 à 14…" /></Field>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="De la page (facultatif)"><input name="fromPage" type="number" min={1} max={totalPages} className="!w-28" /></Field>
                <Field label="à la page"><input name="toPage" type="number" min={1} max={totalPages} className="!w-28" /></Field>
                <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100">Réimprimer</button>
              </div>
            </form>
          </Card>

          {b.pdfPath && (
            <Card title="Fin de production">
              <ActionForm action={destroyPdfAction} submitLabel="Supprimer le PDF du stockage">
                <input type="hidden" name="batchId" value={b.id} />
                <p className="text-sm text-slate-600">
                  Le PDF contient les valeurs QR en clair : supprimez-le une fois l&apos;impression vérifiée. Les billets restent valables.
                </p>
                <Field label="Motif"><input name="reason" placeholder="Impression terminée et contrôlée" /></Field>
                <label className="flex items-center gap-2 font-normal"><input type="checkbox" name="confirm" /> Les {b.quantity} billets ont été imprimés et comptés</label>
              </ActionForm>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-48 shrink-0 text-slate-500">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
