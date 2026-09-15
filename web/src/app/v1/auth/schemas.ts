import { z } from "zod";

export const credentials = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export const signupSchema = credentials.extend({
  name: z.string().trim().min(2).max(80),
});
