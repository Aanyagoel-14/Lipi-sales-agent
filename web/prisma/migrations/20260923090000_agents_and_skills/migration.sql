-- Agents and skills: the unit the no-code builder creates and the SDK
-- registers.
--
-- Until now a workspace had exactly one implicit agent and "which agent
-- acted" was a string literal chosen by a branch inside ingest(). That is
-- enough for a fixed product and impossible for a builder: there is nothing
-- to configure, nothing to deploy, and nothing for a guardrail to attach to.
--
-- `agent_skills.skill` is a registry slug rather than a foreign key on
-- purpose. Skills are code and ship with a release; a table of them would let
-- a tenant name one that has no implementation. The deploy endpoint refuses a
-- slug the registry does not know.

CREATE TYPE "AgentTemplate" AS ENUM (
  'customer_support', 'sdr', 'calendar_pa', 'inbound_reception', 'custom'
);

CREATE TYPE "AgentStatus" AS ENUM ('draft', 'deployed', 'paused');

CREATE TABLE "agents" (
  "id"                TEXT NOT NULL,
  "workspaceId"       TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "template"          "AgentTemplate" NOT NULL DEFAULT 'custom',
  "status"            "AgentStatus"   NOT NULL DEFAULT 'draft',
  "description"       TEXT,
  "channels"          "Channel"[],
  "guardrails"        JSONB NOT NULL DEFAULT '{}',
  "knowledgeEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  "deployedAt"        TIMESTAMP(3),

  CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- One agent per name per tenant: deploy is an upsert on this, so re-deploying
-- updates the agent rather than growing a second one with the same name and
-- half the traffic.
CREATE UNIQUE INDEX "agents_workspaceId_name_key" ON "agents"("workspaceId", "name");
CREATE INDEX "agents_workspaceId_status_idx" ON "agents"("workspaceId", "status");

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_skills" (
  "id"      TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "skill"   TEXT NOT NULL,
  "config"  JSONB   NOT NULL DEFAULT '{}',
  "enabled" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_skills_agentId_skill_key" ON "agent_skills"("agentId", "skill");

ALTER TABLE "agent_skills"
  ADD CONSTRAINT "agent_skills_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which configured agent and which skill produced a run. Both nullable: the
-- built-in commerce loop inside ingest() raises runs under its four role
-- names and belongs to no configured agent, and backfilling it to one would
-- be inventing a row that never existed.
--
-- ON DELETE SET NULL rather than CASCADE: a run is evidence. Deleting an
-- agent must not delete the record of what it did.
ALTER TABLE "agent_runs"
  ADD COLUMN "agentId" TEXT,
  ADD COLUMN "skill"   TEXT;

CREATE INDEX "agent_runs_agentId_ranAt_idx" ON "agent_runs"("agentId", "ranAt");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The Personal PA Twin (PRD §5), and the calendar it reasons over.
--
-- Constraints live on a row rather than in a prompt for the same reason every
-- other number in this codebase does: a model asked to "keep a reasonable
-- buffer" will eventually keep none, and the owner finds out by walking into
-- a meeting they were already late for.
--
-- Instants are stored UTC. `timezone` is what "avoid mornings" is resolved
-- against, and reading it from the row rather than from the server clock is
-- the difference between a 9am meeting and a 3am one.

CREATE TYPE "CalendarSource" AS ENUM ('google', 'manual', 'negotiated', 'focus');
CREATE TYPE "NegotiationState" AS ENUM ('proposed', 'countered', 'confirmed', 'abandoned');

CREATE TABLE "pa_profiles" (
  "id"                     TEXT NOT NULL,
  "workspaceId"            TEXT NOT NULL,
  "ownerName"              TEXT NOT NULL,
  "timezone"               TEXT NOT NULL DEFAULT 'UTC',
  "workdayStartMinute"     INTEGER NOT NULL DEFAULT 540,
  "workdayEndMinute"       INTEGER NOT NULL DEFAULT 1080,
  "bufferMinutes"          INTEGER NOT NULL DEFAULT 15,
  "maxDailyMeetingMinutes" INTEGER NOT NULL DEFAULT 300,
  "focusBlocks"            JSONB   NOT NULL DEFAULT '[]',
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pa_profiles_pkey" PRIMARY KEY ("id")
);

-- One profile per named owner per tenant: a business has several people whose
-- calendars mean different things, and merging them makes "is this slot free"
-- unanswerable.
CREATE UNIQUE INDEX "pa_profiles_workspaceId_ownerName_key" ON "pa_profiles"("workspaceId", "ownerName");
CREATE INDEX "pa_profiles_workspaceId_idx" ON "pa_profiles"("workspaceId");

ALTER TABLE "pa_profiles"
  ADD CONSTRAINT "pa_profiles_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calendar_events" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "profileId"   TEXT NOT NULL,
  "externalId"  TEXT,
  "title"       TEXT NOT NULL,
  "startsAt"    TIMESTAMP(3) NOT NULL,
  "endsAt"      TIMESTAMP(3) NOT NULL,
  "source"      "CalendarSource" NOT NULL DEFAULT 'manual',
  "busy"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- A re-sync updates rather than duplicates: the same idempotency rule the
-- channel adapters keep on provider message ids.
CREATE UNIQUE INDEX "calendar_events_profileId_externalId_key" ON "calendar_events"("profileId", "externalId");
CREATE INDEX "calendar_events_profileId_startsAt_idx" ON "calendar_events"("profileId", "startsAt");
CREATE INDEX "calendar_events_workspaceId_idx" ON "calendar_events"("workspaceId");

ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "pa_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "scheduling_negotiations" (
  "id"                TEXT NOT NULL,
  "workspaceId"       TEXT NOT NULL,
  "profileId"         TEXT NOT NULL,
  "counterpartName"   TEXT NOT NULL,
  "counterpartHandle" TEXT,
  "durationMinutes"   INTEGER NOT NULL,
  "purpose"           TEXT NOT NULL,
  "constraints"       JSONB NOT NULL DEFAULT '{}',
  "state"             "NegotiationState" NOT NULL DEFAULT 'proposed',
  "proposedSlots"     JSONB NOT NULL DEFAULT '[]',
  "agreedStart"       TIMESTAMP(3),
  "agreedEnd"         TIMESTAMP(3),
  "eventId"           TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scheduling_negotiations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduling_negotiations_eventId_key" ON "scheduling_negotiations"("eventId");
CREATE INDEX "scheduling_negotiations_workspaceId_state_idx" ON "scheduling_negotiations"("workspaceId", "state");
CREATE INDEX "scheduling_negotiations_profileId_state_idx" ON "scheduling_negotiations"("profileId", "state");

ALTER TABLE "scheduling_negotiations"
  ADD CONSTRAINT "scheduling_negotiations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scheduling_negotiations"
  ADD CONSTRAINT "scheduling_negotiations_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "pa_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: a negotiation is a record of what was agreed. If the
-- calendar entry it produced is later deleted, the agreement still happened.
ALTER TABLE "scheduling_negotiations"
  ADD CONSTRAINT "scheduling_negotiations_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "calendar_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
