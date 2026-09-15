import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { sell } from "@/server/services/selling";

const sellSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  handle: z.string().trim().min(1).max(120),
  name: z.string().trim().max(120).optional(),
  channel: z.enum(["whatsapp", "instagram", "telegram", "email", "webchat"]).default("webchat"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }))
    .max(20)
    .default([]),
});

/**
 * The customer's side of the twin: the storefront.
 *
 * Unlike `/twin/chat`, this one WRITES. It is the real ingest loop, so a
 * customer buying here reserves real stock, creates a real order and raises a
 * real invoice, and every one of them shows up on the operator's dashboard.
 * A sandbox that reserved nothing would prove nothing about whether the twin
 * can actually sell.
 */
export const POST = route(async (req) => {
  const data = await body(req, sellSchema, "Invalid message");
  const workspaceId = await resolveWorkspaceId();
  return json(await sell({ ...data, workspaceId }), 201);
});
