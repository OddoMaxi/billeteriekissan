import { z } from "zod";
import { db } from "@/lib/db";
import { overrideAdmission } from "@/lib/scan";
import { controllerFor, json, sameOrigin, scanErrorResponse } from "@/lib/scan-http";

const body = z.object({
  scanId: z.string().uuid(),
  reason: z.string().max(500),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

/** Admission par dérogation d'un superviseur, à partir d'une lecture « à vérifier ». */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Origine refusée." }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide." }, 400);
  const scan = await db.scan.findUnique({ where: { id: parsed.data.scanId }, select: { eventId: true } });
  if (!scan) return json({ error: "Lecture inconnue." }, 404);
  const actor = await controllerFor(scan.eventId);
  if (actor instanceof Response) return actor;
  try {
    return json(await overrideAdmission({ ...parsed.data, actor }));
  } catch (e) {
    return scanErrorResponse(e);
  }
}
