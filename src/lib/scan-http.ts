import "server-only";
import { z } from "zod";
import { getCurrentUser } from "./auth";
import { getEventAccess } from "./authz";
import { ScanError, type ScanController } from "./scan";

/** Réponse JSON sans cache. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Requête venant bien de l'application (en plus du cookie SameSite). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || new URL(origin).host === req.headers.get("host");
}

// Limitation des lectures anormales (section 11) : fenêtre glissante par utilisateur, dans le processus.
const g = globalThis as unknown as { __scanRate?: Map<string, number[]> };
const hits = (g.__scanRate ??= new Map<string, number[]>());
const WINDOW_MS = 2_000;
const MAX_PER_WINDOW = 12;

export function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  return recent.length > MAX_PER_WINDOW;
}

/** Contrôleur authentifié pour l'événement ; réponse d'erreur sinon. */
export async function controllerFor(eventId: string): Promise<ScanController | Response> {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Session fermée : reconnectez-vous.", code: "SESSION" }, 401);
  if (!z.string().uuid().safeParse(eventId).success) return json({ error: "Événement inconnu." }, 404);
  const access = await getEventAccess(user, eventId);
  if (!access) return json({ error: "Accès à cet événement retiré." , code: "ACCESS" }, 403);
  return { ...access.actor, controllerGateIds: access.controllerGateIds };
}

export function scanErrorResponse(e: unknown): Response {
  if (e instanceof ScanError) return json({ error: e.message }, e.status);
  throw e;
}
