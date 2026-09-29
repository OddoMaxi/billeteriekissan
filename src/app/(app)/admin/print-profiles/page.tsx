import { ActionForm } from "@/components/action-form";
import { Card, Field, PageTitle, Table, Td } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { fitDesign, usableSlot } from "@/lib/numbering";
import { NOMINAL } from "@/lib/template-layout";
import { createPrintProfile } from "../../events/template-actions";

const f1 = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

export default async function PrintProfilesPage() {
  await requireAdmin();
  const profiles = await db.printProfile.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { batches: true } } } });
  return (
    <>
      <PageTitle>Profils d&apos;impression</PageTitle>
      <p className="-mt-4 mb-6 max-w-3xl text-sm text-slate-600">
        Chaque profil décrit la zone réellement imprimable d&apos;une imprimante. La planche reste toujours en A4 portrait
        (210 × 297 mm), cinq tickets empilés ; le design est réduit proportionnellement pour tenir dans l&apos;emplacement
        utile. Un profil n&apos;est jamais modifié : pour d&apos;autres réglages, créez-en un nouveau.
      </p>
      <Card>
        <Table head={["Nom", "Marges H / B / G / D", "Espacement", "Emplacement utile", "Design imprimé à", "Repères", "Lots"]} empty={profiles.length === 0}>
          {profiles.map((p) => {
            const slot = usableSlot(p);
            const fit = fitDesign(NOMINAL, slot);
            return (
              <tr key={p.id}>
                <Td className="font-medium">{p.name}</Td>
                <Td>{[p.marginTopMm, p.marginBottomMm, p.marginLeftMm, p.marginRightMm].map(f1).join(" / ")} mm</Td>
                <Td>{f1(p.gapMm)} mm</Td>
                <Td>{f1(slot.widthMm)} × {f1(slot.heightMm)} mm</Td>
                <Td>{f1(fit.widthMm)} × {f1(fit.heightMm)} mm ({f1(fit.scale * 100)} %)</Td>
                <Td>{p.cropMarks ? "Oui" : "Non"}</Td>
                <Td>{p._count.batches}</Td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <Card title="Nouveau profil">
        <ActionForm action={createPrintProfile} submitLabel="Créer le profil">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Nom"><input name="name" placeholder="Imprimante bureau, 4 mm" required /></Field>
            <Field label="Marge haute (mm)"><input name="marginTopMm" type="number" step="0.25" min={0} defaultValue={5} required /></Field>
            <Field label="Marge basse (mm)"><input name="marginBottomMm" type="number" step="0.25" min={0} defaultValue={5} required /></Field>
            <Field label="Marge gauche (mm)"><input name="marginLeftMm" type="number" step="0.25" min={0} defaultValue={5} required /></Field>
            <Field label="Marge droite (mm)"><input name="marginRightMm" type="number" step="0.25" min={0} defaultValue={5} required /></Field>
            <Field label="Espacement entre tickets (mm)"><input name="gapMm" type="number" step="0.25" min={0} defaultValue={0} required /></Field>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" name="cropMarks" defaultChecked /> Repères de coupe dans les marges</label>
        </ActionForm>
      </Card>
    </>
  );
}
