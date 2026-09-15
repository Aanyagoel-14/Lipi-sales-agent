/*
  Warnings:

  - Added the required column `variantId` to the `orders` table without a default value. This is not possible if the table is not empty.

  Backfill strategy: `orders.variant` has always been the display string
  `${optionA} / ${optionB}` at the product the order references, so an
  existing row's variant can be recovered deterministically by matching that
  string against the product's own variants. A handful of legacy/demo rows
  may predate a variant rename or a deleted variant; those fall back to the
  first variant on the product rather than failing the migration outright,
  because the alternative is refusing to deploy over real production data.
*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "variantId" TEXT;

-- Backfill: exact match on "optionA / optionB" for the order's own product.
UPDATE "orders" o
SET "variantId" = v.id
FROM "variants" v
WHERE v."productId" = o."productId"
  AND (v."optionA" || ' / ' || v."optionB") = o."variant"
  AND o."variantId" IS NULL;

-- Backfill fallback: anything still unmatched (renamed/removed variant) gets
-- the product's first variant by id, so history keeps a valid reference
-- rather than blocking the deploy. Order history already carries the
-- original label in `orders.variant`, so nothing is lost.
UPDATE "orders" o
SET "variantId" = (
  SELECT v.id FROM "variants" v WHERE v."productId" = o."productId" ORDER BY v.id LIMIT 1
)
WHERE o."variantId" IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "orders" ALTER COLUMN "variantId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "orders_variantId_idx" ON "orders"("variantId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
