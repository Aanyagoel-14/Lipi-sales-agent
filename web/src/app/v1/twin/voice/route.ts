import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { eventId } from "../../events";

const voiceSchema = z.object({
  formality: z.enum(["formal", "neutral", "friendly"]),
  length: z.enum(["terse", "balanced", "detailed"]),
  useEmoji: z.boolean(),
  signOff: z.string().trim().max(80).nullable(),
  greeting: z.string().trim().max(80).nullable(),
  languages: z.array(z.string().trim().min(1).max(40)).max(8),
  neverSay: z.array(z.string().trim().min(1).max(60)).max(20),
  alwaysSay: z.array(z.string().trim().min(1).max(120)).max(20),
});

export const PUT = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, voiceSchema, "Invalid voice");

  const voice = await prisma.twinVoice.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });

  await prisma.twinEvent.create({
    data: {
      id: eventId(), workspaceId, occurredAt: new Date(),
      type: "voice.updated", twin: "knowledge",
      payload: `formality=${voice.formality} length=${voice.length} emoji=${voice.useEmoji}`,
    },
  });

  return json({ voice });
});
