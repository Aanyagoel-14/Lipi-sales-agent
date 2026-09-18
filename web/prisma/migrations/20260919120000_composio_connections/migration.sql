-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConnectionStatus" ADD VALUE 'pending';
ALTER TYPE "ConnectionStatus" ADD VALUE 'needs_reconnect';

-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "composioAccountId" TEXT,
ADD COLUMN     "composioAuthConfigId" TEXT,
ADD COLUMN     "composioTriggerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "connectedAt" TIMESTAMP(3),
ALTER COLUMN "webhookSecret" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_composioAccountId_key" ON "channel_connections"("composioAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_channel_externalId_key" ON "channel_connections"("channel", "externalId");

