-- The Digital Twin rules PRD §5 states that nothing read.
--
--   * `Inquiry` and `Confirmed`, so the Order & Supply Twin's state machine is
--     the one the PRD writes: Inquiry -> Quote -> Confirmed -> Paid -> Packed
--     -> Shipped. `Quoted` is this codebase's spelling of "Quote" and stays.
--
--   * `orders.reservedUntil`, so a reservation can lapse. "Locks reserved
--     stock for 4 hours upon checkout link generation" — before this an
--     abandoned quote held stock for ever and the twin reported the business
--     as having less to sell than it had.
--
--   * `orders.creditHold`, so "flags credit risk if past-due invoices > 0" is
--     a column a human can act on rather than a sentence in a log.
--
--   * `purchase_orders`, so "auto-dispatches POs when reserved inventory drops
--     below threshold" raises something countable instead of an AgentRun whose
--     `action` reads "Draft restock of ...".

-- Neither value is used later in this migration, which is what Postgres
-- requires of an enum value added inside a transaction block.
ALTER TYPE "OrderStage" ADD VALUE IF NOT EXISTS 'Inquiry' BEFORE 'Quoted';
ALTER TYPE "OrderStage" ADD VALUE IF NOT EXISTS 'Confirmed' AFTER 'Quoted';

ALTER TABLE "orders"
  ADD COLUMN "reservedUntil" TIMESTAMP(3),
  ADD COLUMN "creditHold"    BOOLEAN NOT NULL DEFAULT false;

-- The sweep reads exactly this: holds that have lapsed.
CREATE INDEX "orders_reservedUntil_idx" ON "orders"("reservedUntil");

-- Every order that already exists was reserved under the old rule, which had
-- no expiry. Backfilling them to a four-hour window would release stock a live
-- quote is legitimately holding, so they keep the old behaviour: a NULL
-- `reservedUntil` is a hold that does not lapse, and only orders raised from
-- here on carry one. Idempotent by construction -- it writes nothing.

CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'sent', 'received', 'cancelled');

CREATE TABLE "purchase_orders" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "qty"         INTEGER NOT NULL,
  "supplierId"  TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "variantId"   TEXT NOT NULL,
  "status"      "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
  "reason"      TEXT NOT NULL,
  "expectedOn"  TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_orders_workspaceId_status_idx" ON "purchase_orders"("workspaceId", "status");
CREATE INDEX "purchase_orders_variantId_status_idx" ON "purchase_orders"("variantId", "status");

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
