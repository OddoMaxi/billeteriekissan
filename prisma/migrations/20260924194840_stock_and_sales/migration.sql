-- CreateEnum
CREATE TYPE "MovementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REFUSED');

-- CreateEnum
CREATE TYPE "SaleKind" AS ENUM ('SALE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ReversalType" AS ENUM ('ENTRY_ERROR', 'CANCELLATION');

-- AlterEnum
BEGIN;
CREATE TYPE "MovementKind_new" AS ENUM ('ASSIGN', 'RETURN', 'LOSS', 'DAMAGE', 'CANCEL', 'REPLACE', 'ACTIVATE', 'DEACTIVATE');
ALTER TABLE "StockMovement" ALTER COLUMN "kind" TYPE "MovementKind_new" USING ("kind"::text::"MovementKind_new");
ALTER TYPE "MovementKind" RENAME TO "MovementKind_old";
ALTER TYPE "MovementKind_new" RENAME TO "MovementKind";
DROP TYPE "public"."MovementKind_old";
COMMIT;

-- DropIndex
DROP INDEX "Sale_reversalOfId_key";

-- DropIndex
DROP INDEX "StockMovement_eventId_idx";

-- DropIndex
DROP INDEX "Ticket_holderId_idx";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "maxDiscountGnf" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" DROP COLUMN "unitPriceGnf",
ADD COLUMN     "faceValueGnf" INTEGER NOT NULL,
ADD COLUMN     "kind" "SaleKind" NOT NULL DEFAULT 'SALE',
ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "reversalType" "ReversalType";

-- AlterTable
ALTER TABLE "SaleTicket" ADD COLUMN     "priceGnf" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "StockMovement" DROP COLUMN "confirmedAt",
ADD COLUMN     "quantity" INTEGER NOT NULL,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" UUID,
ADD COLUMN     "status" "MovementStatus" NOT NULL DEFAULT 'CONFIRMED';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "activatedById" UUID,
ADD COLUMN     "pendingMovementId" UUID,
ADD COLUMN     "sellerId" UUID;

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "amountGnf" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "declaredById" UUID NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedById" UUID,
    "validatedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "holderId" UUID,
    "expected" INTEGER NOT NULL,
    "counted" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_eventId_sellerId_idx" ON "Payment"("eventId", "sellerId");

-- CreateIndex
CREATE INDEX "StockCount_eventId_createdAt_idx" ON "StockCount"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "Sale_eventId_soldAt_idx" ON "Sale"("eventId", "soldAt");

-- CreateIndex
CREATE INDEX "StockMovement_eventId_createdAt_idx" ON "StockMovement"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_eventId_toUserId_status_idx" ON "StockMovement"("eventId", "toUserId", "status");

-- CreateIndex
CREATE INDEX "Ticket_eventId_holderId_idx" ON "Ticket"("eventId", "holderId");

-- CreateIndex
CREATE INDEX "Ticket_eventId_sellerId_idx" ON "Ticket"("eventId", "sellerId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Écritures financières et journal d'audit en ajout seul (sections 6 et 11) :
-- aucune modification ni suppression, même en cas d'erreur applicative. Une correction est une contre-écriture.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % en ajout seul : % interdit (passez une contre-écriture)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sale_append_only BEFORE UPDATE OR DELETE ON "Sale"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER sale_ticket_append_only BEFORE UPDATE OR DELETE ON "SaleTicket"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
