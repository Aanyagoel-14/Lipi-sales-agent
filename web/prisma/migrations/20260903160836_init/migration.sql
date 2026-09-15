-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('whatsapp', 'instagram', 'telegram', 'email', 'webchat');

-- CreateEnum
CREATE TYPE "Segment" AS ENUM ('Retail', 'Wholesale', 'Corporate');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('Low', 'Medium', 'High');

-- CreateEnum
CREATE TYPE "OrderStage" AS ENUM ('Quoted', 'Paid', 'Packed', 'Shipped', 'Delivered', 'Returned');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('done', 'needs_approval', 'scheduled', 'failed');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('routine', 'attention', 'policy');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('quickbooks', 'zoho', 'manual');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('bank_transfer', 'card', 'upi', 'cash');

-- CreateEnum
CREATE TYPE "Vertical" AS ENUM ('apparel', 'auto_parts', 'marine', 'wholesale');

-- CreateEnum
CREATE TYPE "ApprovalPolicy" AS ENUM ('everything', 'money_only', 'nothing');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "Formality" AS ENUM ('formal', 'neutral', 'friendly');

-- CreateEnum
CREATE TYPE "Length" AS ENUM ('terse', 'balanced', 'detailed');

-- CreateEnum
CREATE TYPE "KnowledgeKind" AS ENUM ('policy', 'faq', 'sizing', 'shipping', 'warranty', 'pricing');

-- CreateTable
CREATE TABLE "customers" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "segment" "Segment" NOT NULL,
    "lifetimeValue" INTEGER NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "avgOrderValue" INTEGER NOT NULL,
    "returnRatePct" DOUBLE PRECISION NOT NULL,
    "priceSensitivity" "Sensitivity" NOT NULL,
    "negotiationStyle" TEXT NOT NULL,
    "sizeProfile" TEXT[],
    "predictedNext" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "onTimePct" INTEGER NOT NULL,
    "avgLeadDays" INTEGER NOT NULL,
    "defectRatePct" DOUBLE PRECISION NOT NULL,
    "moq" INTEGER NOT NULL,
    "responseHours" INTEGER NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "axes" TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price" INTEGER NOT NULL,
    "marginPct" INTEGER NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "crossSell" TEXT[],
    "supplierId" TEXT NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "stock" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "stage" "OrderStage" NOT NULL,
    "channel" "Channel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "blocked" TEXT,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT NOT NULL,
    "unread" BOOLEAN NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "intent" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "quote" JSONB,
    "conversationId" TEXT NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL,
    "severity" "Severity" NOT NULL,
    "runId" TEXT NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twin_events" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "twin" TEXT NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "twin_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "workspaceId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "source" "InvoiceSource" NOT NULL,
    "issuedOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "payments" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "loggedBy" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'owner',
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vertical" "Vertical" NOT NULL,
    "channels" "Channel"[],
    "approvalPolicy" "ApprovalPolicy" NOT NULL DEFAULT 'money_only',
    "catalogueSeeded" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twin_voice" (
    "id" TEXT NOT NULL,
    "formality" "Formality" NOT NULL DEFAULT 'friendly',
    "length" "Length" NOT NULL DEFAULT 'balanced',
    "useEmoji" BOOLEAN NOT NULL DEFAULT false,
    "signOff" TEXT,
    "languages" TEXT[] DEFAULT ARRAY['English']::TEXT[],
    "greeting" TEXT,
    "neverSay" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alwaysSay" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "twin_voice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "kind" "KnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_examples" (
    "id" TEXT NOT NULL,
    "customerSays" TEXT NOT NULL,
    "twinReplies" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "voice_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_segment_idx" ON "customers"("segment");

-- CreateIndex
CREATE INDEX "customers_workspaceId_idx" ON "customers"("workspaceId");

-- CreateIndex
CREATE INDEX "suppliers_workspaceId_idx" ON "suppliers"("workspaceId");

-- CreateIndex
CREATE INDEX "products_supplierId_idx" ON "products"("supplierId");

-- CreateIndex
CREATE INDEX "products_workspaceId_idx" ON "products"("workspaceId");

-- CreateIndex
CREATE INDEX "variants_stock_idx" ON "variants"("stock");

-- CreateIndex
CREATE UNIQUE INDEX "variants_productId_optionA_optionB_key" ON "variants"("productId", "optionA", "optionB");

-- CreateIndex
CREATE INDEX "orders_stage_idx" ON "orders"("stage");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_workspaceId_idx" ON "orders"("workspaceId");

-- CreateIndex
CREATE INDEX "conversations_lastAt_idx" ON "conversations"("lastAt");

-- CreateIndex
CREATE INDEX "conversations_workspaceId_idx" ON "conversations"("workspaceId");

-- CreateIndex
CREATE INDEX "messages_conversationId_sentAt_idx" ON "messages"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_runs_ranAt_idx" ON "agent_runs"("ranAt");

-- CreateIndex
CREATE INDEX "agent_runs_workspaceId_idx" ON "agent_runs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_runId_key" ON "approvals"("runId");

-- CreateIndex
CREATE INDEX "approvals_workspaceId_idx" ON "approvals"("workspaceId");

-- CreateIndex
CREATE INDEX "twin_events_occurredAt_idx" ON "twin_events"("occurredAt");

-- CreateIndex
CREATE INDEX "twin_events_twin_idx" ON "twin_events"("twin");

-- CreateIndex
CREATE INDEX "twin_events_workspaceId_idx" ON "twin_events"("workspaceId");

-- CreateIndex
CREATE INDEX "invoices_dueOn_idx" ON "invoices"("dueOn");

-- CreateIndex
CREATE INDEX "invoices_workspaceId_idx" ON "invoices"("workspaceId");

-- CreateIndex
CREATE INDEX "payments_invoiceNumber_receivedAt_idx" ON "payments"("invoiceNumber", "receivedAt");

-- CreateIndex
CREATE INDEX "payments_workspaceId_idx" ON "payments"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_email_key" ON "waitlist_entries"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_workspaceId_idx" ON "memberships"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_workspaceId_key" ON "memberships"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "twin_voice_workspaceId_key" ON "twin_voice"("workspaceId");

-- CreateIndex
CREATE INDEX "knowledge_entries_workspaceId_kind_idx" ON "knowledge_entries"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "voice_examples_workspaceId_idx" ON "voice_examples"("workspaceId");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twin_events" ADD CONSTRAINT "twin_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceNumber_fkey" FOREIGN KEY ("invoiceNumber") REFERENCES "invoices"("number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twin_voice" ADD CONSTRAINT "twin_voice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_examples" ADD CONSTRAINT "voice_examples_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
