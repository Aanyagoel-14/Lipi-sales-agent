import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

const exampleSchema = z.object({
  customerSays: z.string().trim().min(2).max(400),
  twinReplies: z.string().trim().min(2).max(800),
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, exampleSchema, "Invalid example");
  return json({ example: await prisma.voiceExample.create({ data: { workspaceId, ...data } }) }, 201);
});
