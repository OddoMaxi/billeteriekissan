import type { Category, Gate } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { EVENT_STATUS_LABELS } from "@/lib/labels";
import { formatDateTime, formatGnf, toLocalInput } from "@/lib/time";
import { createGate, saveCategory, setEventStatus, toggleGate, updateEvent } from "../../actions";

const NEXT_STATUSES = { DRAFT: ["OPEN"], OPEN: ["CLOSED"], CLOSED: ["OPEN", "ARCHIVED"], ARCHIVED: [] } as const;

export default async function EventSettings({ params }: PageProps<"/events/[eventId]/settings">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "event.view");
  const isAdmin = access.user.isAdmin;
  const canConfigure = access.can("event.configure");
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    include: {
      gates: { orderBy: { name: "asc" } },
      categories: { orderBy: { priceGnf: "desc" }, include: { _count: { select: { tickets: true } } } },
    },
  });
  const tz = event.timezone;
  const locked = event.status === "CLOSED" || event.status === "ARCHIVED";

  return (
    <>
      <Card title="Fiche événement">
        {canConfigure && !locked ? (
          <ActionForm action={updateEvent}>
            <input type="hidden" name="eventId" value={event.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom" hint={isAdmin ? undefined : "Modifiable par l'administrateur."}>
                <input name="name" defaultValue={event.name} disabled={!isAdmin} required />
              </Field>
              <Field label="Fuseau horaire">
                <input name="timezone" defaultValue={tz} disabled={!isAdmin} required />
              </Field>
              <Field label="Lieu"><input name="venue" defaultValue={event.venue} required /></Field>
              <Field label="Adresse"><input name="address" defaultValue={event.address ?? ""} /></Field>
              <Field label="Ouverture des portes">
                <input name="doorsOpenAt" type="datetime-local" defaultValue={toLocalInput(event.doorsOpenAt, tz)} required />
              </Field>
              <Field label="Début"><input name="startsAt" type="datetime-local" defaultValue={toLocalInput(event.startsAt, tz)} required /></Field>
              <Field label="Fin"><input name="endsAt" type="datetime-local" defaultValue={toLocalInput(event.endsAt, tz)} required /></Field>
            </div>
            <Field label="Description"><textarea name="description" rows={3} defaultValue={event.description ?? ""} /></Field>
          </ActionForm>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">Lieu</dt><dd>{event.venue} {event.address && `— ${event.address}`}</dd></div>
            <div><dt className="text-slate-500">Fuseau</dt><dd>{tz}</dd></div>
            <div><dt className="text-slate-500">Portes</dt><dd>{formatDateTime(event.doorsOpenAt, tz)}</dd></div>
            <div><dt className="text-slate-500">Début – fin</dt><dd>{formatDateTime(event.startsAt, tz)} – {formatDateTime(event.endsAt, tz)}</dd></div>
          </dl>
        )}
      </Card>

      {isAdmin && NEXT_STATUSES[event.status].length > 0 && (
        <Card title="État de l'événement">
          <p className="mb-3 text-sm text-slate-600">
            Actuellement : <strong>{EVENT_STATUS_LABELS[event.status]}</strong>. Un événement terminé n&apos;accepte plus
            de génération, de vente ni de validation.
          </p>
          <ActionForm action={setEventStatus} submitLabel="Changer l'état" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="eventId" value={event.id} />
            <Field label="Nouvel état">
              <select name="status">
                {NEXT_STATUSES[event.status].map((s) => <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>)}
              </select>
            </Field>
            <Field label="Motif (obligatoire pour une réouverture)"><input name="reason" /></Field>
          </ActionForm>
        </Card>
      )}

      <Card title="Catégories">
        <Table head={["Nom", "Prix facial", "Quota", "Générés", "Créneau", "Portes", "Réentrée", ""]} empty={event.categories.length === 0}>
          {event.categories.map((c) => (
            <tr key={c.id}>
              <Td className="font-medium">{c.name}</Td>
              <Td>{formatGnf(c.priceGnf)}</Td>
              <Td>{c.quota.toLocaleString("fr-FR")}</Td>
              <Td>{c._count.tickets.toLocaleString("fr-FR")}</Td>
              <Td className="text-xs">{c.slotStart || c.slotEnd ? `${formatDateTime(c.slotStart, tz)} → ${formatDateTime(c.slotEnd, tz)}` : "—"}</Td>
              <Td className="text-xs">{c.gateIds.length === 0 ? "Toutes" : event.gates.filter((g) => c.gateIds.includes(g.id)).map((g) => g.name).join(", ")}</Td>
              <Td>{c.reentryAllowed ? "Oui" : "Non"}</Td>
              <Td>
                {isAdmin && !locked && (
                  <details>
                    <summary className="cursor-pointer text-blue-700">Modifier</summary>
                    <div className="mt-3 min-w-[36rem]">
                      <CategoryForm eventId={event.id} tz={tz} gates={event.gates} category={c} />
                    </div>
                  </details>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        {isAdmin && !locked && (
          <details className="mt-4">
            <summary className="cursor-pointer font-medium text-blue-700">Ajouter une catégorie</summary>
            <div className="mt-3"><CategoryForm eventId={event.id} tz={tz} gates={event.gates} /></div>
          </details>
        )}
      </Card>

      <Card title="Portes et zones de contrôle">
        <ul className="mb-4 divide-y divide-slate-100 text-sm">
          {event.gates.map((g) => (
            <li key={g.id} className="flex items-center justify-between py-2">
              <span>{g.name} {!g.active && <Badge color="red">Inactive</Badge>}</span>
              {canConfigure && (
                <form action={toggleGate.bind(null, event.id, g.id)}>
                  <button className="text-blue-700 hover:underline">{g.active ? "Désactiver" : "Réactiver"}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {canConfigure && !locked && (
          <ActionForm action={createGate} submitLabel="Ajouter" className="flex items-end gap-3">
            <input type="hidden" name="eventId" value={event.id} />
            <Field label="Nouvelle porte"><input name="name" placeholder="Porte B, Tribune VIP…" required /></Field>
          </ActionForm>
        )}
      </Card>
    </>
  );
}

function CategoryForm({ eventId, tz, gates, category }: { eventId: string; tz: string; gates: Gate[]; category?: Category }) {
  return (
    <ActionForm action={saveCategory} submitLabel={category ? "Enregistrer" : "Créer"}>
      <input type="hidden" name="eventId" value={eventId} />
      {category && <input type="hidden" name="categoryId" value={category.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Nom"><input name="name" defaultValue={category?.name} placeholder="VIP, Standard…" required /></Field>
        <Field label="Prix facial (GNF)"><input name="priceGnf" type="number" min={0} step={1} defaultValue={category?.priceGnf} required /></Field>
        <Field label="Quota"><input name="quota" type="number" min={1} defaultValue={category?.quota} required /></Field>
        <Field label="Créneau : début (facultatif)"><input name="slotStart" type="datetime-local" defaultValue={toLocalInput(category?.slotStart, tz)} /></Field>
        <Field label="Créneau : fin (facultatif)"><input name="slotEnd" type="datetime-local" defaultValue={toLocalInput(category?.slotEnd, tz)} /></Field>
        <Field label="Portes autorisées" hint="Aucune sélection = toutes les portes.">
          <select name="gateIds" multiple defaultValue={category?.gateIds ?? []}>
            {gates.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Conditions d'accès"><input name="accessConditions" defaultValue={category?.accessConditions ?? ""} /></Field>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="reentryAllowed" defaultChecked={category?.reentryAllowed} /> Réentrée autorisée
      </label>
    </ActionForm>
  );
}
