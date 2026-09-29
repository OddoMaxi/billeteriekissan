import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { layoutSchema } from "@/lib/template-layout";
import { formatDateTime } from "@/lib/time";
import { approveBat, saveLayout, uploadNewVersion } from "../../../template-actions";
import { BatDownload } from "./bat-download";
import { LayoutEditor } from "./layout-editor";

export default async function TemplatePage({ params, searchParams }: PageProps<"/events/[eventId]/templates/[templateId]">) {
  const { eventId, templateId } = await params;
  const { created } = await searchParams;
  await requireEventPermission(eventId, "templates.manage");
  const t = await db.ticketTemplate.findFirst({ where: { id: templateId, eventId } });
  if (!t) notFound();
  const [event, versions, profiles, approver] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.ticketTemplate.findMany({ where: { eventId, name: t.name }, orderBy: { version: "desc" } }),
    db.printProfile.findMany({ orderBy: { createdAt: "asc" } }),
    t.batApprovedById ? db.user.findUnique({ where: { id: t.batApprovedById } }) : null,
  ]);
  const layout = layoutSchema.parse(t.layout);
  const nextVersion = versions[0].version + 1;
  const tz = event.timezone;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href={`/events/${eventId}/templates`} className="text-sm text-blue-700 hover:underline">← Modèles</Link>
        <h2 className="text-xl font-bold">{t.name} · version {t.version}</h2>
        {t.batApprovedAt ? <Badge color="green">BAT validé</Badge> : <Badge color="orange">BAT à valider</Badge>}
      </div>
      {created && <p className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-800">Version {t.version} créée. Elle doit passer un nouveau BAT avant la production.</p>}

      <Card title="Design">
        <dl className="grid gap-2 text-sm sm:grid-cols-4">
          <div><dt className="text-slate-500">Format</dt><dd>{t.widthMm} × {t.heightMm} mm</dd></div>
          <div><dt className="text-slate-500">Fichier</dt><dd>{t.backgroundMime}</dd></div>
          <div><dt className="text-slate-500">Empreinte SHA-256</dt><dd className="font-mono text-xs">{t.backgroundSha256.slice(0, 16)}…</dd></div>
          <div><dt className="text-slate-500">Importé le</dt><dd>{formatDateTime(t.createdAt, tz)}</dd></div>
        </dl>
        {t.designWarnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-orange-700">
            {t.designWarnings.map((w) => <li key={w}>⚠ {w}</li>)}
          </ul>
        )}
      </Card>

      <Card title="Emplacement du numéro et du QR code">
        <LayoutEditor
          templateId={t.id}
          backgroundUrl={`/api/templates/${t.id}/background`}
          mime={t.backgroundMime}
          widthMm={t.widthMm}
          heightMm={t.heightMm}
          initialLayout={layout}
          locked={!!t.batApprovedAt}
          nextVersion={nextVersion}
          saveAction={saveLayout}
        />
      </Card>

      <Card title="Bon à tirer (BAT)">
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Téléchargez le BAT avec le profil de l&apos;imprimante qui servira à la production.</li>
          <li>Imprimez-le en taille réelle (100 %, sans « ajuster à la page »), sur le papier retenu.</li>
          <li>Découpez les cinq tickets et lisez chaque QR (corps et talon) avec le flasheur réel. Les spécimens répondent « inexistant » : c&apos;est normal, seule la lecture compte.</li>
          <li>Vérifiez qu&apos;aucun numéro ni QR n&apos;est coupé ; le 5e ticket porte « 10000 » pour contrôler un numéro à 5 chiffres.</li>
        </ol>
        <BatDownload templateId={t.id} profiles={profiles.map((p) => ({ id: p.id, name: p.name }))} />

        <div className="mt-6 border-t border-slate-200 pt-4">
          {t.batApprovedAt ? (
            <p className="text-sm text-green-800">
              BAT validé le {formatDateTime(t.batApprovedAt, tz)} par {approver?.name ?? "—"}. Cette version est figée et utilisable pour la production.
            </p>
          ) : (
            <ActionForm action={approveBat} submitLabel="Valider le BAT">
              <input type="hidden" name="templateId" value={t.id} />
              <Field label="Profil utilisé pour le BAT">
                <select name="printProfileId" required>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <div className="space-y-1">
                <label className="flex items-center gap-2 font-normal"><input type="checkbox" name="printed" /> BAT imprimé à 100 % sur le papier et l&apos;imprimante de production</label>
                <label className="flex items-center gap-2 font-normal"><input type="checkbox" name="scanned" /> Les 10 QR (corps et talons) ont été lus avec le flasheur réel</label>
                <label className="flex items-center gap-2 font-normal"><input type="checkbox" name="cut" /> Après découpe, aucun numéro, QR ni élément utile du design n&apos;est coupé</label>
              </div>
              <Field label="Remarques (papier, imprimante, flasheur…)"><textarea name="notes" rows={2} /></Field>
            </ActionForm>
          )}
        </div>
      </Card>

      <Card title="Nouvelle version du design">
        <p className="mb-3 text-sm text-slate-600">
          Remplacer le fichier crée la version {nextVersion} ; la disposition actuelle est reprise et un nouveau BAT est nécessaire.
          Le fichier doit garder le format {t.widthMm} × {t.heightMm} mm.
        </p>
        <ActionForm action={uploadNewVersion} submitLabel={`Importer comme version ${nextVersion}`}>
          <input type="hidden" name="templateId" value={t.id} />
          <input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required className="block text-sm" />
        </ActionForm>
      </Card>

      {versions.length > 1 && (
        <Card title="Versions">
          <ul className="space-y-1 text-sm">
            {versions.map((v) => (
              <li key={v.id}>
                <Link href={`/events/${eventId}/templates/${v.id}`} className={v.id === t.id ? "font-semibold" : "text-blue-700 hover:underline"}>
                  Version {v.version}
                </Link>{" "}
                · {formatDateTime(v.createdAt, tz)} · {v.batApprovedAt ? "BAT validé" : "BAT à valider"}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
