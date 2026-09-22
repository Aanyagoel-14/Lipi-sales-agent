-- Generated sites (PRD §3).
--
-- The three phases map onto three columns rather than three tables:
-- `structure` is Phase 1's output, the bindings inside it are Phase 2, and
-- `deployment` is Phase 3's.
--
-- The structure holds no business data. A catalogue block names the catalogue;
-- it does not carry products. A quote block holds the formula's source; it
-- does not carry prices. Everything is resolved against live rows when a page
-- is rendered, so a generated site cannot show a price that was true at
-- generation and is not true now.

CREATE TYPE "SiteStatus" AS ENUM ('generated', 'deployed', 'failed');

CREATE TABLE "generated_sites" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "slug"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "profile"      JSONB NOT NULL,
  "features"     JSONB NOT NULL,
  "deployment"   JSONB NOT NULL,
  "structure"    JSONB NOT NULL,
  "quoteFormula" TEXT,
  "status"       "SiteStatus" NOT NULL DEFAULT 'generated',
  "liveUrl"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "generated_sites_pkey" PRIMARY KEY ("id")
);

-- Globally unique, not per workspace: the slug is a public URL segment under
-- `/s/`, so two tenants cannot both own `apex-detailing`.
CREATE UNIQUE INDEX "generated_sites_slug_key" ON "generated_sites"("slug");
CREATE INDEX "generated_sites_workspaceId_createdAt_idx" ON "generated_sites"("workspaceId", "createdAt");

ALTER TABLE "generated_sites"
  ADD CONSTRAINT "generated_sites_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
