-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "generationStartedAt" TIMESTAMP(3),
ADD COLUMN     "pdfDestroyedAt" TIMESTAMP(3),
ADD COLUMN     "progressPages" INTEGER NOT NULL DEFAULT 0;
