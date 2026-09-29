-- AlterEnum
ALTER TYPE "ScanReason" ADD VALUE 'AMBIGUOUS_NUMBER';

-- DropIndex
DROP INDEX "Ticket_eventId_number_key";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "nextNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "nextNumber";

-- CreateIndex
CREATE INDEX "Ticket_eventId_number_idx" ON "Ticket"("eventId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_categoryId_number_key" ON "Ticket"("categoryId", "number");


-- Reprise : chaque catégorie poursuit après son plus grand numéro existant (les billets déjà imprimés
-- ne changent pas) ; une catégorie sans billet commence à 001.
UPDATE "Category" c SET "nextNumber" = COALESCE((SELECT max(t."number") + 1 FROM "Ticket" t WHERE t."categoryId" = c.id), 1);
