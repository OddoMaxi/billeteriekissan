import { z } from "zod";
import { processScan } from "@/lib/scan";
import { controllerFor, json, rateLimited, sameOrigin, scanErrorResponse } from "@/lib/scan-http";

const body = z.object({
  eventId: z.string().uuid(),
  gateId: z.string().uuid(),
  value: z.string().min(1).max(500),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  deviceId: z.string().max(64).optional(),
});

/** Lecture d'un billet au contrôle : verdict décidé et enregistré par le serveur. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Origine refusée." }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide." }, 400);
  const d = parsed.data;
  const controller = await controllerFor(d.eventId);
  if (controller instanceof Response) return controller;
  if (rateLimited(controller.id)) return json({ error: "Trop de lectures en rafale : patientez une seconde." }, 429);
  try {
    return json(await processScan({ ...d, controller }));
  } catch (e) {
    return scanErrorResponse(e);
  }
}
