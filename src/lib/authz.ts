import "server-only";
import type { EventRole } from "@prisma/client";
import { notFound } from "next/navigation";
import { requireUser, type CurrentUser } from "./auth";
import { db } from "./db";
import { can as canDo, type Actor, type Permission } from "./permissions";

export { PERMISSIONS, type Permission } from "./permissions";

export type EventAccess = {
  user: CurrentUser;
  eventId: string;
  roles: Set<EventRole>;
  /** Portes autorisées pour le contrôle ; null = toutes. */
  controllerGateIds: string[] | null;
  can: (p: Permission) => boolean;
  actor: Actor;
};

export async function getEventAccess(user: CurrentUser, eventId: string): Promise<EventAccess | null> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const memberships = await db.eventMembership.findMany({
    where: { userId: user.id, eventId, revokedAt: null, event: { organization: { status: "ACTIVE" } } },
  });
  if (!user.isAdmin && memberships.length === 0) return null;

  const roles = new Set(memberships.map((m) => m.role));
  const controller = memberships.find((m) => m.role === "CONTROLLER");
  const controllerGateIds = user.isAdmin || !controller || controller.gateIds.length === 0 ? null : controller.gateIds;

  return {
    user,
    eventId,
    roles,
    controllerGateIds,
    can: (p) => canDo({ id: user.id, isAdmin: user.isAdmin, roles }, p),
    actor: { id: user.id, isAdmin: user.isAdmin, roles },
  };
}

/**
 * À appeler en tête de chaque page ou action liée à un événement.
 * Un événement non autorisé répond 404, pour ne pas révéler son existence (R01).
 */
export async function requireEventPermission(eventId: string, permission: Permission): Promise<EventAccess> {
  const user = await requireUser();
  const access = await getEventAccess(user, eventId);
  if (!access || !access.can(permission)) notFound();
  return access;
}

/** Événements visibles par l'utilisateur. */
export async function listAccessibleEvents(user: CurrentUser) {
  return db.event.findMany({
    where: user.isAdmin
      ? {}
      : { memberships: { some: { userId: user.id, revokedAt: null } }, organization: { status: "ACTIVE" } },
    include: { organization: true },
    orderBy: { startsAt: "desc" },
  });
}
