-- CreateTable
CREATE TABLE "ServiceHeartbeat" (
    "name" TEXT NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,
    "info" JSONB,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("name")
);
