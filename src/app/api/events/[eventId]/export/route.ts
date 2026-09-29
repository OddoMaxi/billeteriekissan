import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth";
import { getEventAccess } from "@/lib/authz";
import { db } from "@/lib/db";
import { buildTable, closingPdf, toCsv, toXlsx, type ExportMeta, type TableKey } from "@/lib/exports";
import { namesFor } from "@/lib/people";
import { parsePeriod } from "@/lib/period";
import { eventReport } from "@/lib/reports";

const TABLE_KEYS: TableKey[] = ["tickets", "sales", "payments", "scans", "movements"];

/**
 * Exports d'un événement (section 8) : CSV d'une table, classeur XLSX complet ou PDF de clôture.
 * Réservé à l'organisateur, à l'auditeur et à l'administrateur ; chaque export est journalisé.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/events/[eventId]/export">) {
  const { eventId } = await ctx.params;
  const user = await getCurrentUser();
  const access = user ? await getEventAccess(user, eventId) : null;
  if (!user || !access?.can("report.export")) return new Response("Introuvable", { status: 404 });

  const q = new URL(req.url).searchParams;
  const format = q.get("format") ?? "csv";
  const table = (q.get("table") ?? "sales") as TableKey;
  if (!["csv", "xlsx", "pdf"].includes(format) || (format === "csv" && !TABLE_KEYS.includes(table))) {
    return new Response("Paramètres invalides", { status: 400 });
  }
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const tz = event.timezone;
  const period = parsePeriod(q.get("from"), q.get("to"), tz);
  const meta: ExportMeta = { eventName: event.name, author: user.name, generatedAt: new Date(), period, timezone: tz };
  const base = `${event.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}-${meta.generatedAt.toISOString().slice(0, 10)}`;

  let body: Uint8Array | string;
  let type: string;
  let filename: string;
  if (format === "csv") {
    body = toCsv(await buildTable(table, eventId, tz, period), meta);
    type = "text/csv; charset=utf-8";
    filename = `${base}-${table}.csv`;
  } else {
    const report = await eventReport(eventId, period);
    const name = await namesFor([...report.money.map((m) => m.sellerId), ...report.holders.map((h) => h.holderId)]);
    if (format === "xlsx") {
      const tables = await Promise.all(TABLE_KEYS.map((k) => buildTable(k, eventId, tz, period)));
      body = await toXlsx(report, tables, meta, name);
      type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      filename = `${base}.xlsx`;
    } else {
      const gates = new Map((await db.gate.findMany({ where: { eventId } })).map((g) => [g.id, g.name]));
      body = await closingPdf(report, meta, name, (id) => gates.get(id) ?? "?");
      type = "application/pdf";
      filename = `${base}-cloture.pdf`;
    }
  }

  await audit(db, {
    actorId: user.id,
    eventId,
    action: "report.export",
    objectType: "Event",
    objectId: eventId,
    context: { format, table: format === "csv" ? table : "tout", from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null },
  });
  return new Response(typeof body === "string" ? body : Buffer.from(body), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
