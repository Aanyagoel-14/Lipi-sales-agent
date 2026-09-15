-- CreateEnum
CREATE TYPE "InventorySource" AS ENUM ('shopify', 'woocommerce', 'zoho', 'erp', 'pos', 'custom');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('applied', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('unmapped_sku', 'ambiguous_sku', 'unknown_variant', 'invalid_quantity', 'below_reserved');

-- CreateTable
CREATE TABLE "inventory_connectors" (
    "id" TEXT NOT NULL,
    "source" "InventorySource" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "secretHash" TEXT NOT NULL,
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "inventory_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_mappings" (
    "id" TEXT NOT NULL,
    "externalSku" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectorId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,

    CONSTRAINT "inventory_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_sync_runs" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "received" INTEGER NOT NULL,
    "applied" INTEGER NOT NULL,
    "rejected" INTEGER NOT NULL,
    "cursor" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "connectorId" TEXT NOT NULL,

    CONSTRAINT "inventory_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_exceptions" (
    "id" TEXT NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "externalSku" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "detail" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "connectorId" TEXT NOT NULL,

    CONSTRAINT "inventory_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_connectors_workspaceId_idx" ON "inventory_connectors"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_connectors_workspaceId_source_key" ON "inventory_connectors"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "inventory_mappings_variantId_idx" ON "inventory_mappings"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_mappings_connectorId_externalSku_key" ON "inventory_mappings"("connectorId", "externalSku");

-- CreateIndex
CREATE INDEX "inventory_sync_runs_connectorId_startedAt_idx" ON "inventory_sync_runs"("connectorId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_sync_runs_connectorId_idempotencyKey_key" ON "inventory_sync_runs"("connectorId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "inventory_exceptions_connectorId_resolvedAt_idx" ON "inventory_exceptions"("connectorId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "inventory_connectors" ADD CONSTRAINT "inventory_connectors_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_mappings" ADD CONSTRAINT "inventory_mappings_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "inventory_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_mappings" ADD CONSTRAINT "inventory_mappings_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_sync_runs" ADD CONSTRAINT "inventory_sync_runs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "inventory_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "inventory_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
