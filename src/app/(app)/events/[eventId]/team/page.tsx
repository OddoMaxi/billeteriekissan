import { ActionForm } from "@/components/action-form";
import { Card, Field, Table, Td } from "@/components/ui";
import { requireEventPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import { addMember, revokeMember } from "../../actions";

export default async function TeamPage({ params }: PageProps<"/events/[eventId]/team">) {
  const { eventId } = await params;
  const access = await requireEventPermission(eventId, "team.manage");
  const [event, members, gates] = await Promise.all([
    db.event.findUniqueOrThrow({ where: { id: eventId } }),
    db.eventMembership.findMany({
      where: { eventId, revokedAt: null },
      include: { user: true },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
    db.gate.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
  ]);
  const gateName = new Map(gates.map((g) => [g.id, g.name]));
  const roles = Object.entries(ROLE_LABELS).filter(([r]) => r !== "ORGANIZER" || access.user.isAdmin);

  return (
    <>
      <Card title="Équipe de l'événement">
        <Table head={["Nom", "E-mail", "Rôle", "Portes", "Depuis", ""]} empty={members.length === 0}>
          {members.map((m) => (
            <tr key={m.id}>
              <Td className="font-medium">
                {m.user.name}
                {m.user.status !== "ACTIVE" && <span className="ml-2 text-xs text-red-700">(compte désactivé)</span>}
              </Td>
              <Td>{m.user.email}</Td>
              <Td>{ROLE_LABELS[m.role]}</Td>
              <Td className="text-xs">
                {m.role === "CONTROLLER" ? (m.gateIds.length ? m.gateIds.map((id) => gateName.get(id)).join(", ") : "Toutes") : ""}
              </Td>
              <Td className="text-xs">{formatDateTime(m.createdAt, event.timezone)}</Td>
              <Td className="text-right">
                {(m.role !== "ORGANIZER" || access.user.isAdmin) && (
                  <form action={revokeMember.bind(null, eventId, m.id)}>
                    <button className="text-red-700 hover:underline">Retirer</button>
                  </form>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Ajouter un membre">
        <ActionForm action={addMember} submitLabel="Ajouter">
          <input type="hidden" name="eventId" value={eventId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-mail du compte"><input name="email" type="email" required /></Field>
            <Field label="Rôle">
              <select name="role" required>
                {roles.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
              </select>
            </Field>
            <Field label="Portes (contrôleurs uniquement)" hint="Aucune sélection = toutes les portes.">
              <select name="gateIds" multiple>
                {gates.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
          </div>
          <fieldset className="rounded-md border border-dashed border-slate-300 p-4">
            <legend className="px-1 text-sm text-slate-600">Si le compte n&apos;existe pas encore</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom complet"><input name="name" /></Field>
              <Field label="Mot de passe initial" hint="10 caractères minimum.">
                <input name="password" type="password" autoComplete="new-password" />
              </Field>
            </div>
          </fieldset>
        </ActionForm>
      </Card>
    </>
  );
}
