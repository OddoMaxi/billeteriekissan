import { ArrowLeftRight, ChevronLeft, ChevronRight, DoorOpen } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/ui";
import { redirect } from "next/navigation";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { Scanner } from "./scanner";

/** Écran de contrôle d'entrée : choix de la porte autorisée, puis lecture des billets. */
export default async function ControlPage({ params, searchParams }: PageProps<"/control/[eventId]">) {
  const { eventId } = await params;
  const { gate: gateParam } = await searchParams;
  const access = await requireEventPermission(eventId, "scan.perform");
  const [event, gates] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.gate.findMany({
      where: { eventId, active: true, ...(access.controllerGateIds ? { id: { in: access.controllerGateIds } } : {}) },
      orderBy: { name: "asc" },
    }),
  ]);
  const gate = gates.find((g) => g.id === gateParam);
  if (!gate && gates.length === 1) redirect(`/control/${eventId}?gate=${gates[0].id}`);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/events/${eventId}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ChevronLeft className="h-4 w-4" />
            {event.name}
          </Link>
          <h1 className="font-display mt-1 text-[26px] leading-tight font-semibold tracking-tight text-slate-900">Contrôle d&apos;entrée</h1>
        </div>
        {gate && gates.length > 1 && (
          <Link href={`/control/${eventId}`} className="btn btn-secondary">
            <ArrowLeftRight className="h-4 w-4" />
            Changer de porte
          </Link>
        )}
      </div>
      {event.status !== "OPEN" && (
        <div className="mb-4">
          <Notice level="warning">L&apos;événement n&apos;est pas ouvert : toutes les lectures seront refusées.</Notice>
        </div>
      )}
      {gate ? (
        <Scanner eventId={eventId} gate={{ id: gate.id, name: gate.name }} canOverride={access.can("scan.override")} tz={event.timezone} />
      ) : gates.length === 0 ? (
        <Notice level="error">Aucune porte ouverte ne vous est affectée. Contactez l&apos;organisateur.</Notice>
      ) : (
        <div>
          <p className="mb-4 text-sm text-slate-600">Choisissez la porte que vous contrôlez :</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {gates.map((g) => (
              <Link
                key={g.id}
                href={`/control/${eventId}?gate=${g.id}`}
                className="group flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-5 transition-colors hover:border-blue-600"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                    <DoorOpen className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <span className="text-lg font-semibold text-slate-900">{g.name}</span>
                </span>
                <ChevronRight className="h-5 w-5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
