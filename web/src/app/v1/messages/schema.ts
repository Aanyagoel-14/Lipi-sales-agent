import { z } from "zod";

export const inboundSchema = z.object({
  channel: z.enum(["whatsapp", "instagram", "telegram", "email", "webchat"]),
  handle: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(2000),
  name: z.string().trim().max(120).optional(),
});
