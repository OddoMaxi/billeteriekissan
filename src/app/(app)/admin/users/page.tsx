import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageTitle, Table, Td } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/labels";
import { createUser, resetPassword, setUserStatus } from "../actions";

export default async function UsersPage() {
  const me = await requireAdmin();
  const users = await db.user.findMany({
    orderBy: { name: "asc" },
    include: { memberships: { where: { revokedAt: null }, include: { event: { select: { id: true, name: true } } } } },
  });
  return (
    <>
      <PageTitle>Comptes</PageTitle>
      <Card title="Nouveau compte">
        <ActionForm action={createUser} submitLabel="Créer le compte">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom complet"><input name="name" required /></Field>
            <Field label="E-mail"><input name="email" type="email" required /></Field>
            <Field label="Téléphone"><input name="phone" /></Field>
            <Field label="Mot de passe initial" hint="10 caractères minimum ; à transmettre de façon sûre.">
              <input name="password" type="password" minLength={10} required autoComplete="new-password" />
            </Field>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="isAdmin" /> Administrateur central
          </label>
          <p className="text-xs text-slate-500">
            Les rôles par événement (organisateur, vendeur, contrôleur…) s&apos;attribuent depuis la page Équipe de chaque événement.
          </p>
        </ActionForm>
      </Card>
      <Card>
        <Table head={["Nom", "E-mail", "Rôles", "État", "Actions"]} empty={users.length === 0}>
          {users.map((u) => (
            <tr key={u.id}>
              <Td className="font-medium">
                {u.name} {u.isAdmin && <Badge color="blue">Admin</Badge>}
              </Td>
              <Td>{u.email}</Td>
              <Td>
                {u.memberships.length === 0
                  ? "—"
                  : u.memberships.map((m) => (
                      <div key={m.id}>
                        <Link href={`/events/${m.event.id}/team`} className="hover:underline">{m.event.name}</Link> : {ROLE_LABELS[m.role]}
                      </div>
                    ))}
              </Td>
              <Td>{u.status === "ACTIVE" ? <Badge color="green">Actif</Badge> : <Badge color="red">Désactivé</Badge>}</Td>
              <Td className="space-y-2">
                {u.id !== me.id && (
                  <form action={setUserStatus.bind(null, u.id, u.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}>
                    <button className="text-blue-700 hover:underline">{u.status === "ACTIVE" ? "Désactiver" : "Réactiver"}</button>
                  </form>
                )}
                <details>
                  <summary className="cursor-pointer text-blue-700">Nouveau mot de passe</summary>
                  <ActionForm action={resetPassword} submitLabel="Réinitialiser" className="mt-2 space-y-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <input name="password" type="password" minLength={10} required autoComplete="new-password" />
                  </ActionForm>
                </details>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
