"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formAction, formToObject, UserError } from "@/lib/action";
import { requireEventPermission } from "@/lib/authz";
import { resolveIncident, ScanError } from "@/lib/scan";

export const resolveIncidentAction = formAction(async (form) => {
  const raw = formToObject(form);
  const eventId = z.string().uuid().parse(raw.eventId);
  const access = await requireEventPermission(eventId, "gates.view");
  try {
    await resolveIncident({ incidentId: z.string().uuid().parse(raw.incidentId), actor: access.actor, resolution: String(raw.resolution ?? "") });
  } catch (e) {
    if (e instanceof ScanError) throw new UserError(e.message);
    throw e;
  }
  revalidatePath(`/events/${eventId}/gates`);
  return "Incident traité.";
});
