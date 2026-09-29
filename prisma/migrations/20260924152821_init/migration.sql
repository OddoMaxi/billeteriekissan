-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "EventRole" AS ENUM ('ORGANIZER', 'TICKET_MANAGER', 'SELLER', 'CONTROLLER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PREPARING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "BatchLayout" AS ENUM ('SEQUENTIAL', 'STACKS');

-- CreateEnum
CREATE TYPE "CommercialState" AS ENUM ('IN_STOCK', 'ASSIGNED', 'SOLD');

-- CreateEnum
CREATE TYPE "BlockState" AS ENUM ('NONE', 'CANCELLED', 'LOST', 'DESTROYED');

-- CreateEnum
CREATE TYPE "EntryState" AS ENUM ('NOT_USED', 'USED');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('ASSIGN', 'TRANSFER', 'RETURN', 'LOSS', 'DAMAGE', 'CANCEL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "ScanVerdict" AS ENUM ('VALID', 'REFUSED', 'CHECK');

-- CreateEnum
CREATE TYPE "ScanReason" AS ENUM ('OK', 'UNKNOWN', 'OTHER_EVENT', 'FORBIDDEN_GATE', 'NOT_ACTIVATED', 'CANCELLED', 'LOST', 'DESTROYED', 'ALREADY_USED', 'OUT_OF_SLOT', 'EVENT_CLOSED');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMembership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "role" "EventRole" NOT NULL,
    "gateIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "EventMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "venue" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Conakry',
    "doorsOpenAt" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gate" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceGnf" INTEGER NOT NULL,
    "quota" INTEGER NOT NULL,
    "accessConditions" TEXT,
    "slotStart" TIMESTAMP(3),
    "slotEnd" TIMESTAMP(3),
    "gateIds" UUID[],
    "reentryAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTemplate" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "backgroundPath" TEXT NOT NULL,
    "backgroundMime" TEXT NOT NULL,
    "backgroundSha256" TEXT NOT NULL,
    "widthMm" DOUBLE PRECISION NOT NULL DEFAULT 210,
    "heightMm" DOUBLE PRECISION NOT NULL DEFAULT 74.25,
    "layout" JSONB NOT NULL,
    "batApprovedAt" TIMESTAMP(3),
    "batApprovedById" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintProfile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "marginTopMm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "marginBottomMm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "marginLeftMm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "marginRightMm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "gapMm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cropMarks" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "printProfileId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "firstNumber" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "layout" "BatchLayout" NOT NULL DEFAULT 'SEQUENTIAL',
    "status" "BatchStatus" NOT NULL DEFAULT 'PREPARING',
    "pageCount" INTEGER,
    "pdfPath" TEXT,
    "pdfSha256" TEXT,
    "error" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedById" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "qrHash" TEXT NOT NULL,
    "qrSecretEnc" TEXT NOT NULL,
    "commercialState" "CommercialState" NOT NULL DEFAULT 'IN_STOCK',
    "blockState" "BlockState" NOT NULL DEFAULT 'NONE',
    "entryState" "EntryState" NOT NULL DEFAULT 'NOT_USED',
    "holderId" UUID,
    "activatedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "usedGateId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "fromUserId" UUID,
    "toUserId" UUID,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "incident" TEXT,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovementTicket" (
    "movementId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,

    CONSTRAINT "StockMovementTicket_pkey" PRIMARY KEY ("movementId","ticketId")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "unitPriceGnf" INTEGER NOT NULL,
    "discountGnf" INTEGER NOT NULL DEFAULT 0,
    "totalGnf" INTEGER NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL,
    "reversalOfId" UUID,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleTicket" (
    "saleId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,

    CONSTRAINT "SaleTicket_pkey" PRIMARY KEY ("saleId","ticketId")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "gateId" UUID NOT NULL,
    "controllerId" UUID NOT NULL,
    "deviceId" TEXT,
    "ticketId" UUID,
    "maskedValue" TEXT NOT NULL,
    "verdict" "ScanVerdict" NOT NULL,
    "reason" "ScanReason" NOT NULL,
    "serverTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" UUID,
    "eventId" UUID,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "EventMembership_eventId_idx" ON "EventMembership"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventMembership_userId_eventId_role_key" ON "EventMembership"("userId", "eventId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Gate_eventId_name_key" ON "Gate"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_eventId_name_key" ON "Category"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTemplate_eventId_name_version_key" ON "TicketTemplate"("eventId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PrintProfile_name_key" ON "PrintProfile"("name");

-- CreateIndex
CREATE INDEX "Batch_eventId_idx" ON "Batch"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_qrHash_key" ON "Ticket"("qrHash");

-- CreateIndex
CREATE INDEX "Ticket_batchId_idx" ON "Ticket"("batchId");

-- CreateIndex
CREATE INDEX "Ticket_holderId_idx" ON "Ticket"("holderId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_eventId_number_key" ON "Ticket"("eventId", "number");

-- CreateIndex
CREATE INDEX "StockMovement_eventId_idx" ON "StockMovement"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_reversalOfId_key" ON "Sale"("reversalOfId");

-- CreateIndex
CREATE INDEX "Sale_eventId_sellerId_idx" ON "Sale"("eventId", "sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "Scan_operationId_key" ON "Scan"("operationId");

-- CreateIndex
CREATE INDEX "Scan_eventId_serverTime_idx" ON "Scan"("eventId", "serverTime");

-- CreateIndex
CREATE INDEX "Scan_ticketId_idx" ON "Scan"("ticketId");

-- CreateIndex
CREATE INDEX "AuditLog_eventId_createdAt_idx" ON "AuditLog"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_objectType_objectId_idx" ON "AuditLog"("objectType", "objectId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMembership" ADD CONSTRAINT "EventMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMembership" ADD CONSTRAINT "EventMembership_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gate" ADD CONSTRAINT "Gate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTemplate" ADD CONSTRAINT "TicketTemplate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TicketTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_printProfileId_fkey" FOREIGN KEY ("printProfileId") REFERENCES "PrintProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementTicket" ADD CONSTRAINT "StockMovementTicket_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovementTicket" ADD CONSTRAINT "StockMovementTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleTicket" ADD CONSTRAINT "SaleTicket_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleTicket" ADD CONSTRAINT "SaleTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "Gate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
