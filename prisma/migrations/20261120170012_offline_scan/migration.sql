-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "offlineScan" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "deviceTime" TIMESTAMP(3),
ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offlineConflict" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offlineVerdict" "ScanVerdict";
