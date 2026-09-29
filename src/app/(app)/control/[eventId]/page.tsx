import Link from "next/link";
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
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">Contrôle · {event.name}</h1>
        {gate && gates.length > 1 && (
          <Link href={`/control/${eventId}`} className="text-sm text-blue-700 hover:underline">Changer de porte</Link>
        )}
      </div>
      {event.status !== "OPEN" && (
        <p className="mb-4 rounded-md bg-orange-100 p-3 text-sm text-orange-900">
          L&apos;événement n&apos;est pas ouvert : toutes les lectures seront refusées.
        </p>
      )}
      {gate ? (
        <Scanner eventId={eventId} gate={{ id: gate.id, name: gate.name }} canOverride={access.can("scan.override")} tz={event.timezone} />
      ) : gates.length === 0 ? (
        <p className="rounded-md bg-red-50 p-4 text-red-800">Aucune porte ouverte ne vous est affectée. Contactez l&apos;organisateur.</p>
      ) : (
        <div>
          <p className="mb-3 text-slate-600">Choisissez votre porte :</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {gates.map((g) => (
              <Link key={g.id} href={`/control/${eventId}?gate=${g.id}`} className="rounded-xl border-2 border-slate-300 bg-white p-6 text-center text-xl font-bold hover:border-blue-600">
                {g.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
