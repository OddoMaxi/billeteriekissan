import { Building2, CalendarDays, ChevronLeft, MapPin, ScanLine, UserRound } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui";
import { requireEventPermission, type Permission } from "@/lib/authz";
import { db } from "@/lib/db";
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS, ROLE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import { EventTabs } from "./tabs";

const TABS: { href: string; label: string; permission: Permission }[] = [
  { href: "", label: "Tableau de bord", permission: "event.view" },
  { href: "/settings", label: "Paramètres", permission: "event.view" },
  { href: "/team", label: "Équipe", permission: "team.manage" },
  { href: "/templates", label: "Modèles", permission: "templates.manage" },
  { href: "/batches", label: "Lots", permission: "tickets.view" },
  { href: "/stock", label: "Stock", permission: "tickets.view" },
  { href: "/sales", label: "Ventes", permission: "finance.view" },
  { href: "/tickets", label: "Recherche", permission: "tickets.view" },
  { href: "/gates", label: "Contrôle", permission: "gates.view" },
  { href: "/my", label: "Ma caisse", permission: "stock.own" },
];

export default async function EventLayout({ children, params }: LayoutProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "event.view");
  const event = await db.event.findUnique({ where: { id: eventId }, include: { organization: true } });
  if (!event) notFound();

  return (
    <>
      <div className="mb-6">
        <Link href="/events" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ChevronLeft className="h-4 w-4" />
          Événements
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-slate-900 sm:text-[32px]">{event.name}</h1>
              <Badge color={EVENT_STATUS_COLORS[event.status]}>{EVENT_STATUS_LABELS[event.status]}</Badge>
            </div>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-slate-500">
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Date</dt>
                <CalendarDays className="h-4 w-4 text-slate-400" strokeWidth={1.75} />
                <dd>{formatDateTime(event.startsAt, event.timezone)}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Lieu</dt>
                <MapPin className="h-4 w-4 text-slate-400" strokeWidth={1.75} />
                <dd>{event.venue}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="sr-only">Organisme</dt>
                <Building2 className="h-4 w-4 text-slate-400" strokeWidth={1.75} />
                <dd>{event.organization.name}</dd>
              </div>
              {!access.user.isAdmin && (
                <div className="flex items-center gap-1.5">
                  <dt className="sr-only">Mon rôle</dt>
                  <UserRound className="h-4 w-4 text-slate-400" strokeWidth={1.75} />
                  <dd>{[...access.roles].map((r) => ROLE_LABELS[r]).join(", ")}</dd>
                </div>
              )}
            </dl>
          </div>
          {access.can("scan.perform") && (
            <Link href={`/control/${eventId}`} className="btn btn-accent btn-lg">
              <ScanLine className="h-[18px] w-[18px]" />
              Contrôle d&apos;entrée
            </Link>
          )}
        </div>
      </div>
      <EventTabs
        base={`/events/${eventId}`}
        tabs={TABS.filter((t) =>
          // « Ma caisse » : seulement pour qui détient réellement des billets (pas l'administrateur seul).
          t.href === "/my" ? ["SELLER", "TICKET_MANAGER", "ORGANIZER"].some((r) => access.roles.has(r as never)) : access.can(t.permission),
        ).map(({ href, label }) => ({ href, label }))}
      />
      {children}
    </>
  );
}
