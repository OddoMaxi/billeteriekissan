import { Card, PageTitle, Table, Td } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/time";

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin();
  const { action } = await searchParams;
  const logs = await db.auditLog.findMany({
    where: typeof action === "string" && action ? { action: { startsWith: action } } : {},
    orderBy: { id: "desc" },
    take: 200,
  });
  const actorIds = [...new Set(logs.map((l) => l.actorId).filter((x): x is string => !!x))];
  const actors = new Map(
    (await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return (
    <>
      <PageTitle>Journal d&apos;audit</PageTitle>
      <form className="mb-4 flex max-w-md gap-2">
        <input name="action" defaultValue={typeof action === "string" ? action : ""} placeholder="Filtrer par action (ex. user., batch.)" />
        <button className="mt-1 rounded-md border border-slate-300 bg-white px-3 text-sm">Filtrer</button>
      </form>
      <Card>
        <p className="mb-3 text-xs text-slate-500">200 entrées les plus récentes. Le journal n&apos;est pas modifiable depuis l&apos;interface.</p>
        <Table head={["Date", "Acteur", "Action", "Objet", "Détail"]} empty={logs.length === 0}>
          {logs.map((l) => (
            <tr key={String(l.id)}>
              <Td className="whitespace-nowrap">{formatDateTime(l.createdAt, "Africa/Conakry")}</Td>
              <Td>{l.actorId ? (actors.get(l.actorId) ?? l.actorId.slice(0, 8)) : "système"}</Td>
              <Td className="font-mono text-xs">{l.action}</Td>
              <Td className="font-mono text-xs">{l.objectType} {l.objectId?.slice(0, 8)}</Td>
              <Td>
                {(l.before || l.after || l.context) && (
                  <details>
                    <summary className="cursor-pointer text-blue-700">voir</summary>
                    <pre className="mt-1 max-w-xl overflow-x-auto text-xs">{JSON.stringify({ avant: l.before, après: l.after, contexte: l.context }, null, 2)}</pre>
                  </details>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
