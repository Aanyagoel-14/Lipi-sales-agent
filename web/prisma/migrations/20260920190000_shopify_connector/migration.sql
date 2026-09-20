-- AlterTable
-- A pulled source keeps the store's identity and its encrypted OAuth token on
-- the connector row; every pushed connector leaves these four null.
ALTER TABLE "inventory_connectors" ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "installState" TEXT,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
-- Shopify sells a variant by `variant.id` and stocks it by `inventory_item_id`.
ALTER TABLE "inventory_mappings" ADD COLUMN     "externalRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_connectors_externalId_key" ON "inventory_connectors"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_mappings_connectorId_externalRef_key" ON "inventory_mappings"("connectorId", "externalRef");
