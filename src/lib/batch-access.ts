import "server-only";
import type { Batch } from "@prisma/client";
import { getCurrentUser, type CurrentUser } from "./auth";
import { getEventAccess, type Permission } from "./authz";
import { db } from "./db";

/** Lot accessible avec la permission demandée sur son événement ; null → réponse 404. */
export async function batchWithPermission(batchId: string, permission: Permission): Promise<{ batch: Batch; user: CurrentUser } | null> {
  const user = await getCurrentUser();
  if (!user || !/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  const batch = await db.batch.findUnique({ where: { id: batchId } });
  if (!batch) return null;
  const access = await getEventAccess(user, batch.eventId);
  if (!access?.can(permission)) return null;
  return { batch, user };
}
