/*
  Warnings:

  - You are about to drop the column `metaAppSecretCipher` on the `channel_connections` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'facebook';

-- AlterTable
ALTER TABLE "channel_connections" DROP COLUMN "metaAppSecretCipher";
