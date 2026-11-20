import { offlineSnapshot } from "@/lib/scan";
import { controllerFor, json, scanErrorResponse } from "@/lib/scan-http";

/**
 * Copie de l'événement pour le contrôle hors connexion d'une porte (empreintes des QR uniquement).
 * Le poste la redemande régulièrement ; `If-None-Match` évite de la renvoyer si rien n'a changé.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const eventId = url.searchParams.get("eventId") ?? "";
  const gateId = url.searchParams.get("gateId") ?? "";
  const controller = await controllerFor(eventId);
  if (controller instanceof Response) return controller;
  try {
    const snap = await offlineSnapshot({ eventId, gateId, controller });
    if (!snap.disabled) {
      const etag = `"${snap.version}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
      }
      return Response.json(snap, { headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    return json(snap);
  } catch (e) {
    return scanErrorResponse(e);
  }
}
