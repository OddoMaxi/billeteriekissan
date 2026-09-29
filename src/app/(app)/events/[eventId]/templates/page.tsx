import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/time";
import { createTemplate } from "../../template-actions";

const MIME_LABEL: Record<string, string> = { "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPEG" };

export default async function TemplatesPage({ params }: PageProps<"/events/[eventId]/templates">) {
  const { eventId } = await params;
  await requireEventPermission(eventId, "templates.manage");
  const [event, templates] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.ticketTemplate.findMany({
      where: { eventId },
      orderBy: [{ name: "asc" }, { version: "desc" }],
      include: { _count: { select: { batches: true } } },
    }),
  ]);

  return (
    <>
      <Card title="Importer le design du ticket">
        <div className="mb-4 grid gap-4 rounded-md bg-blue-50 p-4 text-sm text-blue-950 md:grid-cols-2">
          <div>
            <p className="font-semibold">Format attendu : 210 × 59,4 mm, horizontal</p>
            <p className="mt-1">
              Un seul ticket, avec son talon si souhaité ; cinq tickets sont imprimés par feuille A4 portrait.
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              <li>PDF d&apos;une page (recommandé), ou PNG / JPEG de <strong>2 480 × 702 px</strong> (300 dpi)</li>
              <li>Zones du numéro et du QR laissées vierges, sur fond clair</li>
              <li>Aucun texte important à moins de 4 mm des bords et de la ligne du talon</li>
            </ul>
          </div>
          <div>
            <p className="font-semibold">Fichiers de référence</p>
            <ul className="mt-1 space-y-0.5">
              <li><a href="/gabarit/gabarit-zones.pdf" target="_blank" className="underline">Gabarit coté (zones et marges)</a></li>
              <li><a href="/gabarit/billet-demo.pdf" target="_blank" className="underline">Design de démonstration (PDF)</a></li>
              <li><a href="/gabarit/billet-demo.png" target="_blank" className="underline">Design de démonstration (PNG 300 dpi)</a></li>
            </ul>
            <p className="mt-2 text-blue-900">
              Après l&apos;import, vous placez le QR et les numéros sur ce design, vous validez le BAT, puis le modèle sert à générer les lots.
            </p>
          </div>
        </div>
        <ActionForm action={createTemplate} submitLabel="Importer le design">
          <input type="hidden" name="eventId" value={eventId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom du modèle"><input name="name" placeholder="Standard, VIP…" required /></Field>
            <Field label="Fichier du design" hint="PDF d'une page, PNG ou JPEG ; 15 Mo maximum.">
              <input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required className="mt-1 block text-sm" />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">Dimensions du design</legend>
            <label className="flex items-center gap-2 font-normal">
              <input type="radio" name="format" value="nominal" defaultChecked /> 210 × 59,4 mm (format standard, cinq par A4)
            </label>
            <label className="flex flex-wrap items-center gap-2 font-normal">
              <input type="radio" name="format" value="custom" /> Variante aux dimensions utiles de l&apos;imprimante :
              <input name="widthMm" type="number" step="0.01" placeholder="200" className="!mt-0 !w-24" /> ×
              <input name="heightMm" type="number" step="0.01" placeholder="57.4" className="!mt-0 !w-24" /> mm
            </label>
          </fieldset>
        </ActionForm>
      </Card>

      <Card title="Modèles importés">
        <Table head={["Modèle", "Version", "Fond", "Format", "BAT", "Lots", "Créé le"]} empty={templates.length === 0}>
          {templates.map((t) => (
            <tr key={t.id}>
              <Td>
                <Link href={`/events/${eventId}/templates/${t.id}`} className="font-medium text-blue-700 hover:underline">{t.name}</Link>
              </Td>
              <Td>v{t.version}</Td>
              <Td>{MIME_LABEL[t.backgroundMime]}</Td>
              <Td>
                {t.widthMm} × {t.heightMm} mm
                {t.heightMm > 59.4 && <span className="ml-1 text-xs text-orange-700">(ancien format 4 par page)</span>}
              </Td>
              <Td>{t.batApprovedAt ? <Badge color="green">Validé</Badge> : <Badge color="orange">À valider</Badge>}</Td>
              <Td>{t._count.batches}</Td>
              <Td className="text-xs">{formatDateTime(t.createdAt, event.timezone)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

    </>
  );
}
