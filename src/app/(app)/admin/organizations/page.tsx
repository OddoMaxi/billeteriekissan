import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, PageTitle, Table, Td } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { createOrganization, setOrganizationStatus } from "../actions";

export default async function OrganizationsPage() {
  await requireAdmin();
  const orgs = await db.organization.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { events: true } } },
  });
  return (
    <>
      <PageTitle>Organismes</PageTitle>
      <Card title="Nouvel organisme">
        <ActionForm action={createOrganization} submitLabel="Créer">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom"><input name="name" required /></Field>
            <Field label="Contact"><input name="contact" placeholder="Téléphone, e-mail…" /></Field>
          </div>
        </ActionForm>
      </Card>
      <Card>
        <Table head={["Nom", "Contact", "Événements", "État", ""]} empty={orgs.length === 0}>
          {orgs.map((o) => (
            <tr key={o.id}>
              <Td className="font-medium">{o.name}</Td>
              <Td>{o.contact ?? "—"}</Td>
              <Td>{o._count.events}</Td>
              <Td>{o.status === "ACTIVE" ? <Badge color="green">Actif</Badge> : <Badge color="red">Désactivé</Badge>}</Td>
              <Td className="text-right">
                <form action={setOrganizationStatus.bind(null, o.id, o.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}>
                  <button className="text-sm text-blue-700 hover:underline">
                    {o.status === "ACTIVE" ? "Désactiver" : "Réactiver"}
                  </button>
                </form>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
