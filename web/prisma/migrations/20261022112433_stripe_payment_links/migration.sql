-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('stripe');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'wallet';
ALTER TYPE "PaymentMethod" ADD VALUE 'other';

-- CreateTable
CREATE TABLE "payment_connections" (
    "id" TEXT NOT NULL,
    "provider" "PaymentGateway" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "mode" TEXT,
    "accountId" TEXT,
    "displayName" TEXT,
    "composioAccountId" TEXT,
    "composioAuthConfigId" TEXT,
    "composioTriggerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "payment_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "provider" "PaymentGateway" NOT NULL,
    "reference" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedAs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceNumber" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_connections_composioAccountId_key" ON "payment_connections"("composioAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_connections_workspaceId_provider_key" ON "payment_connections"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_invoiceNumber_key" ON "payment_links"("invoiceNumber");

-- CreateIndex
CREATE INDEX "payment_links_workspaceId_idx" ON "payment_links"("workspaceId");

-- AddForeignKey
ALTER TABLE "payment_connections" ADD CONSTRAINT "payment_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_invoiceNumber_fkey" FOREIGN KEY ("invoiceNumber") REFERENCES "invoices"("number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
