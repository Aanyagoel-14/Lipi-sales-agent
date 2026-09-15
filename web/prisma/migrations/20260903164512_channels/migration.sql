-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('disconnected', 'connected', 'error');

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "externalId" TEXT,
    "displayName" TEXT,
    "secretCipher" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "webhookSecret" TEXT NOT NULL,
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_connections_workspaceId_idx" ON "channel_connections"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_workspaceId_channel_key" ON "channel_connections"("workspaceId", "channel");

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
