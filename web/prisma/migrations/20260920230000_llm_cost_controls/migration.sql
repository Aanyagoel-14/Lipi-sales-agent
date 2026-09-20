-- CreateEnum
CREATE TYPE "ModelPurpose" AS ENUM ('extract', 'sell', 'twin_chat');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "customerModelCalls" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "dailyModelCalls" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "dailyModelTokens" INTEGER NOT NULL DEFAULT 1000000;

-- CreateTable
CREATE TABLE "model_calls" (
    "id" TEXT NOT NULL,
    "purpose" "ModelPurpose" NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT,

    CONSTRAINT "model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_calls_workspaceId_occurredAt_idx" ON "model_calls"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "model_calls_customerId_occurredAt_idx" ON "model_calls"("customerId", "occurredAt");

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

