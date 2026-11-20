import { CalendarDays, Clock, MapPin } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listAccessibleEvents } from "@/lib/authz";
import { db } from "@/lib/db";
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from "@/lib/labels";
import { createEvent } from "./actions";

export default async function EventsPage() {
  const user = await requireUser();
  const events = await listAccessibleEvents(user);
  const orgs = user.isAdmin ? await db.organization.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }) : [];

  return (
    <>
      <PageTitle description="Les événements auxquels vous avez accès.">Événements</PageTitle>
      {events.length === 0 ? (
        <div className="mb-6 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <CalendarDays className="mx-auto h-8 w-8 text-slate-300" strokeWidth={1.5} />
          <p className="mt-3 font-medium text-slate-900">Aucun événement pour l&apos;instant</p>
          <p className="mt-1 text-sm text-slate-500">
            {user.isAdmin ? "Créez le premier événement ci-dessous." : "Vous verrez ici les événements auxquels un organisateur vous a ajouté."}
          </p>
        </div>
      ) : (
        <ul className="mb-10 grid gap-4 md:grid-cols-2">
          {events.map((e) => {
            const parts = Object.fromEntries(
              new Intl.DateTimeFormat("fr-FR", { timeZone: e.timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                .formatToParts(e.startsAt)
                .map((p) => [p.type, p.value]),
            );
            return (
              <li key={e.id} className="min-w-0">
                <Link
                  href={`/events/${e.id}`}
                  className="group flex h-full gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 sm:p-5"
                >
                  <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-slate-50 py-2.5 ring-1 ring-slate-200 ring-inset">
                    <span className="text-[11px] font-semibold tracking-wide text-brand-600 uppercase">{parts.month?.replace(".", "")}</span>
                    <span className="font-display text-[26px] leading-none font-semibold text-slate-900">{parts.day}</span>
                    <span className="mt-1 text-[11px] text-slate-500 tabular-nums">{parts.year}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="truncate text-base font-semibold text-slate-900 group-hover:text-blue-800">{e.name}</h2>
                      <Badge color={EVENT_STATUS_COLORS[e.status]}>{EVENT_STATUS_LABELS[e.status]}</Badge>
                    </div>
                    <div className="mt-2 space-y-1 text-sm text-slate-500">
                      <div className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate">{e.venue}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>{parts.hour}:{parts.minute}</span>
                        <span className="text-slate-300">·</span>
                        <span className="truncate">{e.organization.name}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {user.isAdmin && (
        <Card title="Nouvel événement" description="Une porte « Entrée principale » est créée automatiquement.">
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
