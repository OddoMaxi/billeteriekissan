import { z } from "zod";
import { reportIncident } from "@/lib/scan";
import { controllerFor, json, sameOrigin, scanErrorResponse } from "@/lib/scan-http";

const body = z.object({ eventId: z.string().uuid(), gateId: z.string().uuid(), message: z.string().max(1000) });

/** Signalement d'un incident par un contrôleur (appel du superviseur). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Origine refusée." }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide." }, 400);
  const controller = await controllerFor(parsed.data.eventId);
  if (controller instanceof Response) return controller;
  try {
    const i = await reportIncident({ ...parsed.data, controller });
    return json({ id: i.id });
  } catch (e) {
    return scanErrorResponse(e);
  }
}
