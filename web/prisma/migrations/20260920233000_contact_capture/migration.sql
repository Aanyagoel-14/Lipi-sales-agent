-- Progressive contact capture: how to reach a customer twin outside the
-- thread they arrived in.
--
-- Nullable throughout and with no unique constraint on `email`. Two twins in
-- one workspace holding the same address is a flag for the operator, not a
-- merge (see services/contacts.ts) — a unique index here would turn that into
-- a write failure on the visitor's own message.

CREATE TYPE "ContactSource" AS ENUM ('volunteered', 'form');

ALTER TABLE "customers"
  ADD COLUMN "email"       TEXT,
  ADD COLUMN "emailSource" "ContactSource",
  ADD COLUMN "emailAt"     TIMESTAMP(3),
  ADD COLUMN "phone"       TEXT,
  ADD COLUMN "phoneSource" "ContactSource",
  ADD COLUMN "phoneAt"     TIMESTAMP(3);

-- The duplicate check reads (workspaceId, email) on every captured address,
-- inside the ingest transaction, so it is not a sequential scan.
CREATE INDEX "customers_workspaceId_email_idx" ON "customers"("workspaceId", "email");
