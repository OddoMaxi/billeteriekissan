-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "entryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "exitedAt" TIMESTAMP(3);
