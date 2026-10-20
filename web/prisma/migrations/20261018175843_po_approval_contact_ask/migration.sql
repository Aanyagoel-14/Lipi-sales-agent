-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "orderId" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "contactAskedAt" TIMESTAMP(3);
