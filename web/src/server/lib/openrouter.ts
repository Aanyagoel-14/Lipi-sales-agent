import { env } from "../env";

/**
 * One place that talks to OpenRouter.
 *
 * Three callers were building the same request by hand, which is how a fix
 * like `reasoning.exclude` ends up applied to two of them and forgotten on the
 * third.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Reasoning models put their scratchpad in the reply.
 *
 * Some return it in a separate `reasoning` field and *also* prefix it onto
 * `content`; others wrap it in tags inline. `reasoning.exclude` asks the
 * provider not to send it at all, which handles the first kind. The tag strip
 * below handles the second, because which kind you get depends on a model id
 * in an env var that can change without touching this code.
 */
const THINK_TAGS = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;

/** An unclosed tag means the reply was cut off mid-thought: nothing usable follows. */
const UNCLOSED_THINK = /<(think|thinking|reasoning)>[\s\S]*$/i;

export function stripReasoning(text: string): string {
  return text.replace(THINK_TAGS, "").replace(UNCLOSED_THINK, "").trim();
}

/**
 * Asks for the reply inside a JSON field, and returns that field.
 *
 * `reasoning.exclude` is not enough on its own. Given a long, rule-heavy
 * system prompt, a reasoning model will happily deliberate in `content`
 * itself -- "We need to follow instructions. The user asks..." -- and a
 * customer then reads the model working out what to say to them. Deliberation
 * cannot leak into a string field it was told to fill.
 *
 * Falls back to the raw content when the model returns something that is not
 * the requested shape, so a model without structured-output support still
 * works rather than failing closed.
 */
/**
 * Puts a run-together list back onto separate lines.
 *
 * Models asked for JSON often write "Here you go:  - **A** - **B**" with
 * spaces where the newlines should be, because a newline inside a JSON string
 * has to be escaped and they skip it. Markdown needs the line breaks, so
 * without this the customer reads one long paragraph with stray dashes.
 *
 * Only fires on two or more bullet markers in a line that has no breaks of its
 * own, so an ordinary sentence with a dash in it is left alone.
 */
export function tidyMarkdownLists(text: string): string {
  if (text.includes("\n")) return text;

  const bullets = text.match(/\s+[-*]\s+(?=\S)/g);
  if (!bullets || bullets.length < 2) return text;

  return text.replace(/\s+[-*]\s+(?=\S)/g, "\n- ").trim();
}

/**
 * Splits a sentence that has run onto the end of a list item.
 *
 * Models finish a list and then keep typing on the same line — "- **Chino**
 * — INR 1,890  Which size would you like?" — and markdown renders the
 * question as part of the last bullet. Only a run of spaces before a capital
 * letter counts, and only on a line that is already a bullet, so a two-space
 * gap inside ordinary prose is untouched.
 */
export function unglueTrailingSentence(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*[-*]\s/.test(line) ? line.replace(/\s{2,}(?=[A-Z][a-z])/, "\n\n") : line))
    .join("\n");
}

/** Both formatting repairs, in the order they have to run. */
const tidy = (text: string) => unglueTrailingSentence(tidyMarkdownLists(text));

export async function chatForReply(options: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const content = await chatCompletion({
    ...options,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "reply",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reply"],
          properties: {
            reply: { type: "string", description: "The message to send. Nothing else." },
          },
        },
      },
    },
  });

  try {
    const parsed = JSON.parse(content) as { reply?: unknown };
    if (typeof parsed.reply === "string" && parsed.reply.trim()) return tidy(parsed.reply.trim());
  } catch {
    // Not JSON. A model that ignores the schema still answers in prose, and
    // that prose is usable -- but only because `chatCompletion` has already
    // rejected a truncated reply. Without that check this is exactly where a
    // half-finished train of thought would be handed to a customer.
  }

  return tidy(content);
}

export async function chatCompletion(options: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: unknown;
  timeoutMs?: number;
}): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.PUBLIC_URL,
      "X-Title": "Lipi AI",
    },
    body: JSON.stringify({
      model: options.model ?? env.OPENROUTER_CHAT_MODEL,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens,
      // Ignored by models that do not reason; harmless on those that do not.
      reasoning: { exclude: true },
      messages: options.messages,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    error?: { message?: string };
  };

  const choice = body.choices?.[0];
  const content = stripReasoning(choice?.message?.content ?? "");
  if (!content) throw new Error(body.error?.message ?? "OpenRouter returned no content");

  // A reply cut off at the token limit is not a shorter reply, it is a
  // fragment -- and for a reasoning model the fragment is usually its own
  // deliberation. Better to fail and let the caller send something correct.
  if (choice?.finish_reason === "length") throw new Error("OpenRouter reply hit the token limit");

  return content;
}
