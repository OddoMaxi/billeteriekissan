import "server-only";
import { db } from "./db";

/** Noms des utilisateurs, pour l'affichage (null = stock central). */
export async function namesFor(ids: (string | null | undefined)[]): Promise<(id: string | null | undefined) => string> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const users = unique.length ? await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
  const map = new Map(users.map((u) => [u.id, u.name]));
  return (id) => (id ? (map.get(id) ?? "—") : "Stock central");
}

/** Membres pouvant détenir des billets (vendeurs, gestionnaires, organisateurs). */
export async function holdersOf(eventId: string) {
  const ms = await db.eventMembership.findMany({
    where: { eventId, revokedAt: null, role: { in: ["SELLER", "TICKET_MANAGER", "ORGANIZER"] }, user: { status: "ACTIVE" } },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  const seen = new Map<string, { id: string; name: string; roles: string[] }>();
  for (const m of ms) {
    const e = seen.get(m.userId) ?? { id: m.user.id, name: m.user.name, roles: [] };
    e.roles.push(m.role);
    seen.set(m.userId, e);
  }
  return [...seen.values()];
}
