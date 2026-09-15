-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('visitor', 'engaged', 'qualified', 'customer');

-- AlterTable: attribution + lead scoring on the customer twin
ALTER TABLE "customers"
  ADD COLUMN     "utmSource" TEXT,
  ADD COLUMN     "utmMedium" TEXT,
  ADD COLUMN     "utmCampaign" TEXT,
  ADD COLUMN     "utmTerm" TEXT,
  ADD COLUMN     "utmContent" TEXT,
  ADD COLUMN     "adClickId" TEXT,
  ADD COLUMN     "landingPage" TEXT,
  ADD COLUMN     "referrer" TEXT,
  ADD COLUMN     "firstTouchAt" TIMESTAMP(3),
  ADD COLUMN     "leadScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "leadStage" "LeadStage" NOT NULL DEFAULT 'visitor';

-- AlterTable: stable, stored SKU (L-1d fix)
-- Added nullable first so the 55+ existing rows in a live database do not
-- block the migration, backfilled from the same string-mangling formula the
-- code used to run on every read, then made required. Every row past this
-- migration gets its SKU written once at creation (see src/server/lib/sku.ts)
-- and never recomputed from a name that might since have changed.
ALTER TABLE "variants" ADD COLUMN "sku" TEXT;

UPDATE "variants" v
SET "sku" = UPPER(REGEXP_REPLACE(p."name", '\s+', '-', 'g'))
         || '-' || UPPER(REGEXP_REPLACE(v."optionA", '\s+', '-', 'g'))
         || '-' || UPPER(REGEXP_REPLACE(v."optionB", '\s+', '-', 'g'))
FROM "products" p
WHERE p."id" = v."productId" AND v."sku" IS NULL;

ALTER TABLE "variants" ALTER COLUMN "sku" SET NOT NULL;

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "adClickId" TEXT,
    "landingPage" TEXT,
    "referrer" TEXT,
    "customerId" TEXT,
    "engagedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_suggestions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "draftReply" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "actedAt" TIMESTAMP(3),

    CONSTRAINT "growth_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_workspaceId_leadStage_idx" ON "customers"("workspaceId", "leadStage");

-- CreateIndex
CREATE INDEX "customers_workspaceId_utmCampaign_idx" ON "customers"("workspaceId", "utmCampaign");

-- CreateIndex
CREATE UNIQUE INDEX "variants_productId_sku_key" ON "variants"("productId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_workspaceId_visitorId_key" ON "visitor_sessions"("workspaceId", "visitorId");

-- CreateIndex
CREATE INDEX "visitor_sessions_workspaceId_createdAt_idx" ON "visitor_sessions"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "visitor_sessions_workspaceId_customerId_idx" ON "visitor_sessions"("workspaceId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "growth_suggestions_workspaceId_customerId_kind_key" ON "growth_suggestions"("workspaceId", "customerId", "kind");

-- CreateIndex
CREATE INDEX "growth_suggestions_workspaceId_dismissedAt_actedAt_idx" ON "growth_suggestions"("workspaceId", "dismissedAt", "actedAt");

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_suggestions" ADD CONSTRAINT "growth_suggestions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_suggestions" ADD CONSTRAINT "growth_suggestions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
