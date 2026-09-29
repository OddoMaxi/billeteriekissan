import "server-only";
import type { TicketTemplate } from "@prisma/client";
import { getCurrentUser } from "./auth";
import { db } from "./db";

export { toRenderTemplate } from "./render-template";

/** Modèle accessible à l'administrateur uniquement ; null sinon (la route répond 404). */
export async function adminTemplate(templateId: string): Promise<{ template: TicketTemplate; actorId: string } | null> {
  const user = await getCurrentUser();
  if (!user?.isAdmin || !/^[0-9a-f-]{36}$/i.test(templateId)) return null;
  const template = await db.ticketTemplate.findUnique({ where: { id: templateId } });
  return template ? { template, actorId: user.id } : null;
}

export function pdfResponse(bytes: Uint8Array, filename: string, inline = true): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
