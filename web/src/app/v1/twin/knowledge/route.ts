import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

const knowledgeSchema = z.object({
  kind: z.enum(["policy", "faq", "sizing", "shipping", "warranty", "pricing"]),
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(4).max(2000),
});

export const GET = route(async () => {
  const workspaceId = await resolveWorkspaceId();
  const [knowledge, examples] = await Promise.all([
    prisma.knowledgeEntry.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    prisma.voiceExample.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
  ]);
  return json({ knowledge, examples });
});

export const POST = route(async (req) => {
  const workspaceId = await resolveWorkspaceId();
  const data = await body(req, knowledgeSchema, "Invalid entry");
  return json({ entry: await prisma.knowledgeEntry.create({ data: { workspaceId, ...data } }) }, 201);
});
