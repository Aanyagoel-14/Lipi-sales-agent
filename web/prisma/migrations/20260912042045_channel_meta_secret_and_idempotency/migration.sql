-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "metaAppSecretCipher" TEXT;

-- CreateTable
CREATE TABLE "processed_messages" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_messages_connectionId_receivedAt_idx" ON "processed_messages"("connectionId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "processed_messages_connectionId_externalId_key" ON "processed_messages"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
