-- CreateEnum
CREATE TYPE "ScanMode" AS ENUM ('ENTRY', 'EXIT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScanReason" ADD VALUE 'REENTRY';
ALTER TYPE "ScanReason" ADD VALUE 'EXIT';
ALTER TYPE "ScanReason" ADD VALUE 'OVERRIDE';
ALTER TYPE "ScanReason" ADD VALUE 'NOT_INSIDE';
ALTER TYPE "ScanReason" ADD VALUE 'NO_REENTRY';
ALTER TYPE "ScanReason" ADD VALUE 'MANUAL_ENTRY';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "exception" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exceptionReason" TEXT,
ADD COLUMN     "mode" "ScanMode" NOT NULL DEFAULT 'ENTRY',
ADD COLUMN     "overridesScanId" UUID;

-- CreateTable
CREATE TABLE "GateIncident" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "gateId" UUID NOT NULL,
    "controllerId" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,

    CONSTRAINT "GateIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GateIncident_eventId_resolvedAt_idx" ON "GateIncident"("eventId", "resolvedAt");

-- CreateIndex
CREATE INDEX "Scan_eventId_gateId_serverTime_idx" ON "Scan"("eventId", "gateId", "serverTime");

-- AddForeignKey
ALTER TABLE "GateIncident" ADD CONSTRAINT "GateIncident_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
