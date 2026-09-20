/*
  Warnings:

  - You are about to drop the column `secretCipher` on the `channel_connections` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('not_applicable', 'pending', 'sent', 'failed', 'held');

-- AlterTable
ALTER TABLE "channel_connections" DROP COLUMN "secretCipher";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "deliveryError" TEXT,
ADD COLUMN     "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'not_applicable';
