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
  { href: "/templates", label: "Modèles de billets", permission: "templates.manage" },
  { href: "/batches", label: "Lots", permission: "tickets.view" },
  { href: "/stock", label: "Stock", permission: "tickets.view" },
  { href: "/sales", label: "Ventes et caisse", permission: "finance.view" },
  { href: "/tickets", label: "Rechercher un billet", permission: "tickets.view" },
  { href: "/gates", label: "Portes et contrôle", permission: "gates.view" },
  { href: "/my", label: "Ma caisse", permission: "stock.own" },
];

export default async function EventLayout({ children, params }: LayoutProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "event.view");
  const event = await db.event.findUnique({ where: { id: eventId }, include: { organization: true } });
  if (!event) notFound();

  return (
    <>
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{event.name}</h1>
          <Badge color={EVENT_STATUS_COLORS[event.status]}>{EVENT_STATUS_LABELS[event.status]}</Badge>
          {access.can("scan.perform") && (
            <Link href={`/control/${eventId}`} className="ml-auto rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800">
              Ouvrir le contrôle d&apos;entrée
            </Link>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {event.organization.name} · {event.venue} · {formatDateTime(event.startsAt, event.timezone)}
          {!access.user.isAdmin && ` · ${[...access.roles].map((r) => ROLE_LABELS[r]).join(", ")}`}
        </p>
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
