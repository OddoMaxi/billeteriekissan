import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageTitle, Table, Td } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listAccessibleEvents } from "@/lib/authz";
import { db } from "@/lib/db";
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import { createEvent } from "./actions";

export default async function EventsPage() {
  const user = await requireUser();
  const events = await listAccessibleEvents(user);
  const orgs = user.isAdmin ? await db.organization.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }) : [];

  return (
    <>
      <PageTitle>Événements</PageTitle>
      <Card>
        <Table head={["Événement", "Organisme", "Lieu", "Début", "État"]} empty={events.length === 0}>
          {events.map((e) => (
            <tr key={e.id}>
              <Td>
                <Link href={`/events/${e.id}`} className="font-medium text-blue-700 hover:underline">{e.name}</Link>
              </Td>
              <Td>{e.organization.name}</Td>
              <Td>{e.venue}</Td>
              <Td>{formatDateTime(e.startsAt, e.timezone)}</Td>
              <Td><Badge color={EVENT_STATUS_COLORS[e.status]}>{EVENT_STATUS_LABELS[e.status]}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>

      {user.isAdmin && (
        <Card title="Nouvel événement">
          {orgs.length === 0 ? (
            <p className="text-sm text-slate-600">
              Créez d&apos;abord un <Link href="/admin/organizations" className="text-blue-700 underline">organisme</Link>.
            </p>
          ) : (
            <ActionForm action={createEvent} submitLabel="Créer l'événement">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Organisme">
                  <select name="organizationId" required>
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </Field>
                <Field label="Nom"><input name="name" required /></Field>
                <Field label="Lieu"><input name="venue" required /></Field>
                <Field label="Adresse"><input name="address" /></Field>
                <Field label="Fuseau horaire"><input name="timezone" defaultValue="Africa/Conakry" required /></Field>
                <Field label="Ouverture des portes"><input name="doorsOpenAt" type="datetime-local" required /></Field>
                <Field label="Début"><input name="startsAt" type="datetime-local" required /></Field>
                <Field label="Fin"><input name="endsAt" type="datetime-local" required /></Field>
              </div>
              <Field label="Description"><textarea name="description" rows={3} /></Field>
            </ActionForm>
          )}
        </Card>
      )}
    </>
  );
}
