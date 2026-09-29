import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

export type AuditEntry = {
  actorId: string | null;
  eventId?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
};

const toJson = (v: unknown) =>
  v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);

/**
 * Journal d'audit en ajout seul. À appeler dans la même transaction que l'action
 * journalisée, pour qu'une action ne puisse pas exister sans sa trace.
 */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: e.actorId,
      eventId: e.eventId ?? null,
      action: e.action,
      objectType: e.objectType,
      objectId: e.objectId ?? null,
      before: toJson(e.before),
      after: toJson(e.after),
      context: toJson(e.context),
    },
  });
}
