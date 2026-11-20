import type { ScanReason } from "@prisma/client";
import { z } from "zod";
import { processScan, ScanError } from "@/lib/scan";
import { controllerFor, json, sameOrigin } from "@/lib/scan-http";

const REASONS = [
  "OK", "OVERRIDE", "UNKNOWN", "OTHER_EVENT", "FORBIDDEN_GATE", "NOT_ACTIVATED", "CANCELLED", "LOST", "DESTROYED",
  "ALREADY_USED", "OUT_OF_SLOT", "MANUAL_ENTRY", "AMBIGUOUS_NUMBER", "EVENT_CLOSED",
] as const satisfies readonly ScanReason[];

const body = z.object({
  eventId: z.string().uuid(),
  deviceId: z.string().max(64).optional(),
  items: z
    .array(
      z.object({
        operationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        gateId: z.string().uuid(),
        value: z.string().min(1).max(500),
        deviceTime: z.string().datetime(),
        verdict: z.enum(["VALID", "REFUSED", "CHECK"]),
        reason: z.enum(REASONS),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * Envoi des lectures faites hors connexion, dans l'ordre où elles ont eu lieu.
 * Chaque lecture garde son identifiant d'opération : un renvoi ne compte jamais deux fois.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Origine refusée." }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide." }, 400);
  const d = parsed.data;
  const controller = await controllerFor(d.eventId);
  if (controller instanceof Response) return controller;

  const results = [];
  for (const item of d.items) {
    try {
      const r = await processScan({
        eventId: d.eventId,
        gateId: item.gateId,
        controller,
        value: item.value,
        operationId: item.operationId,
        deviceId: d.deviceId,
        offline: { deviceTime: new Date(item.deviceTime), verdict: item.verdict, reason: item.reason },
      });
      results.push({ operationId: item.operationId, ok: true, verdict: r.verdict, conflict: item.verdict === "VALID" && r.verdict !== "VALID" });
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      // Erreur définitive (droits retirés, porte supprimée…) : la lecture ne pourra jamais être enregistrée.
      results.push({ operationId: item.operationId, ok: false, error: e.message });
    }
  }
  return json({ results });
}
