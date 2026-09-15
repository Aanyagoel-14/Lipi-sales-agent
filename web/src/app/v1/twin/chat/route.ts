import { z } from "zod";
import { body, json, route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { chatWithTwin } from "@/server/services/twin-chat";

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(40),
});

/**
 * The operator asking their own twin about the business.
 *
 * Stateless on purpose: the client sends the thread back each turn. A twin
 * conversation is a working session over live state, not a customer record,
 * and persisting it would put internal questions into the same tables the
 * dashboard reports customer activity from.
 */
export const POST = route(async (req) => {
  const data = await body(req, chatSchema, "Invalid chat request");
  const workspaceId = await resolveWorkspaceId();
  return json(await chatWithTwin(workspaceId, data.messages));
});
