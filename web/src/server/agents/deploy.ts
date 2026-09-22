import { z } from "zod";
import type { Channel } from "@/generated/prisma/client";
import { recordEvent } from "../lib/events";
import { HttpError } from "../lib/http";
import { prisma } from "../lib/prisma";
import { parseGuardrails } from "./guardrails";
import { unknownSkills } from "./registry";
import { templateFor } from "./templates";

/**
 * Deploying an agent: the third step of the no-code builder (PRD §2 Step 03).
 *
 * The PRD prints the request body verbatim in §8.1, so that is the body this
 * accepts — `agent_name`, `skills`, `knowledge_base_ids`, `channels`,
 * `guardrails`, in snake_case, with channels named in the PRD's own
 * upper-case vocabulary (`WHATSAPP`, `WEB_SDK`). Nothing about the repository's
 * camelCase internals leaks into it, and nothing about the PRD's spelling
 * leaks past this module.
 *
 * Deploy is an **upsert on (workspaceId, name)**. Publishing twice is the
 * normal way an operator changes an agent, and growing a second agent with the
 * same name and half the traffic is the failure that makes telemetry lie.
 *
 * Everything is checked before anything is written:
 *
 *   - every skill exists in the registry
 *   - every channel is one this deployment knows
 *   - every channel the agent publishes to is actually connected
 *   - every knowledge entry named belongs to this workspace
 *   - the guardrails parse
 *
 * A half-deployed agent — published to a channel it cannot answer on, holding
 * a skill that does not exist — is an agent that fails in front of a customer
 * rather than in front of the operator who deployed it.
 */

/**
 * The PRD's channel vocabulary, mapped onto the `Channel` enum.
 *
 * `WEB_SDK` is the PRD's name for the embedded widget, which this codebase has
 * always called `webchat`. Two names for one thing is worth a lookup table
 * and not worth a migration.
 */
const CHANNEL_ALIASES: Record<string, Channel> = {
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
  INSTAGRAM: "instagram",
  FACEBOOK: "facebook",
  MESSENGER: "facebook",
  X: "x",
  TWITTER: "x",
  EMAIL: "email",
  WEB_SDK: "webchat",
  WEBCHAT: "webchat",
  WEBSITE_CHAT: "webchat",
};

export const deployableChannels = Object.keys(CHANNEL_ALIASES);

/** Back the other way, for responses that speak the PRD's vocabulary. */
const CHANNEL_OUT: Partial<Record<Channel, string>> = {
  whatsapp: "WHATSAPP", telegram: "TELEGRAM", instagram: "INSTAGRAM",
  facebook: "FACEBOOK", x: "X", email: "EMAIL", webchat: "WEB_SDK",
};

export const channelOut = (channel: Channel) => CHANNEL_OUT[channel] ?? channel.toUpperCase();

/** The PRD's body (§8.1), as a schema. */
export const deployRequestSchema = z
  .object({
    agent_name: z.string().min(1).max(120),
    /**
     * Optional only because a template supplies them. An agent with no skills
     * at all is refused below, by the rule that says where they may come
     * from — which is a clearer error than "expected >=1 items" when the
     * caller did name a template.
     */
    skills: z.array(z.string().min(1)).max(50).optional(),
    knowledge_base_ids: z.array(z.string().min(1)).max(200).optional(),
    channels: z.array(z.string().min(1)).min(1).max(20),
    guardrails: z.unknown().optional(),
    /** Not in the PRD's example, but the builder's first step needs it. */
    template: z.enum(["customer_support", "sdr", "calendar_pa", "inbound_reception", "custom"]).optional(),
    description: z.string().max(500).optional(),
  })
  .refine((value) => value.skills?.length || (value.template && value.template !== "custom"), {
    message: "Give a skills list, or a template to take one from",
    path: ["skills"],
  });

export type DeployRequest = z.infer<typeof deployRequestSchema>;

export async function deployAgent(workspaceId: string, input: DeployRequest) {
  /* ------------------------------------------------- what it is made of */
  // A template supplies defaults; anything stated explicitly wins, because an
  // operator who typed a skill list meant that list.
  const template = input.template && input.template !== "custom" ? templateFor(input.template) : undefined;
  if (input.template && input.template !== "custom" && !template) {
    throw new HttpError(422, `Unknown template "${input.template}"`);
  }

  const skills = [...new Set(input.skills?.length ? input.skills : (template?.skills ?? []))];
  const missing = unknownSkills(skills);
  if (missing.length) {
    throw new HttpError(422, `Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`, {
      skills: missing,
    });
  }

  /* ------------------------------------------------------- where it runs */
  const channels: Channel[] = [];
  const unknownChannels: string[] = [];
  for (const named of input.channels) {
    const channel = CHANNEL_ALIASES[named.trim().toUpperCase()];
    if (channel) channels.push(channel);
    else unknownChannels.push(named);
  }
  if (unknownChannels.length) {
    throw new HttpError(422, `Unknown channel${unknownChannels.length === 1 ? "" : "s"}: ${unknownChannels.join(", ")}`, {
      channels: unknownChannels,
      supported: deployableChannels,
    });
  }
  const wanted = [...new Set(channels)];

  // Webchat needs no connection — the widget is the transport (see
  // `services/webchat.ts`). Every other channel is a provider account, and
  // publishing to one that is not connected produces an agent that is "live"
  // and silent, which is the failure this whole check exists to prevent.
  const needConnection = wanted.filter((channel) => channel !== "webchat");
  if (needConnection.length) {
    const connected = await prisma.channelConnection.findMany({
      where: { workspaceId, channel: { in: needConnection }, status: "connected" },
      select: { channel: true },
    });
    const live = new Set(connected.map((row) => row.channel));
    const dark = needConnection.filter((channel) => !live.has(channel));
    if (dark.length) {
      throw new HttpError(
        409,
        `Not connected: ${dark.map(channelOut).join(", ")}. Connect the channel before deploying to it.`,
        { channels: dark.map(channelOut) },
      );
    }
  }

  /* ------------------------------------------------- what it may claim */
  const knowledgeEntryIds = [...new Set(input.knowledge_base_ids ?? [])];
  if (knowledgeEntryIds.length) {
    const found = await prisma.knowledgeEntry.findMany({
      where: { workspaceId, id: { in: knowledgeEntryIds } },
      select: { id: true },
    });
    const known = new Set(found.map((row) => row.id));
    const strangers = knowledgeEntryIds.filter((entryId) => !known.has(entryId));
    if (strangers.length) {
      // Scoped, so naming another tenant's entry is indistinguishable from
      // naming one that does not exist (invariant 5).
      throw new HttpError(422, `Unknown knowledge entries: ${strangers.join(", ")}`, { knowledge: strangers });
    }
  }

  /* ---------------------------------------------------- what it may not */
  let guardrails;
  try {
    guardrails = parseGuardrails(
      input.guardrails === undefined && template ? template.guardrails : input.guardrails,
    );
  } catch (error) {
    throw new HttpError(422, "Invalid guardrails", z.flattenError(error as z.ZodError).fieldErrors);
  }

  /* -------------------------------------------------------------- write */
  const now = new Date();
  const { agent, created } = await prisma.$transaction(async (tx) => {
    const existing = await tx.agent.findFirst({ where: { workspaceId, name: input.agent_name } });

    const data = {
      template: (input.template ?? (existing?.template || "custom")) as DeployRequest["template"],
      status: "deployed" as const,
      description: input.description ?? template?.description ?? existing?.description ?? null,
      channels: wanted,
      guardrails: guardrails as object,
      knowledgeEntryIds,
      deployedAt: now,
    };

    const row = existing
      ? await tx.agent.update({ where: { id: existing.id }, data })
      : await tx.agent.create({ data: { workspaceId, name: input.agent_name, ...data } });

    // The skill set is replaced rather than merged: a deploy states what the
    // agent holds, and a skill removed from the list must actually go. The
    // configuration of a skill that survives is kept, so turning one off and
    // back on does not lose how it was set up.
    const before = await tx.agentSkill.findMany({ where: { agentId: row.id } });
    const keep = new Map(before.map((skill) => [skill.skill.toLowerCase(), skill]));

    await tx.agentSkill.deleteMany({
      where: { agentId: row.id, skill: { notIn: skills } },
    });
    for (const skill of skills) {
      const previous = keep.get(skill.toLowerCase());
      if (previous) {
        await tx.agentSkill.update({ where: { id: previous.id }, data: { enabled: true } });
      } else {
        await tx.agentSkill.create({ data: { agentId: row.id, skill } });
      }
    }

    return { agent: row, created: !existing };
  });

  await recordEvent(
    workspaceId,
    created ? "agent.deployed" : "agent.redeployed",
    "agent",
    `${agent.id} name="${agent.name}" skills=[${skills.join(", ")}] channels=[${wanted.map(channelOut).join(", ")}]`,
  );

  return agentView(agent, skills);
}

type AgentRow = {
  id: string; name: string; template: string; status: string; description: string | null;
  channels: Channel[]; guardrails: unknown; knowledgeEntryIds: string[];
  createdAt: Date; deployedAt: Date | null;
};

export function agentView(agent: AgentRow, skills: string[]) {
  return {
    id: agent.id,
    agent_name: agent.name,
    template: agent.template,
    status: agent.status,
    description: agent.description,
    skills,
    channels: agent.channels.map(channelOut),
    knowledge_base_ids: agent.knowledgeEntryIds,
    guardrails: agent.guardrails,
    createdIso: agent.createdAt.toISOString(),
    deployedIso: agent.deployedAt?.toISOString() ?? null,
  };
}
