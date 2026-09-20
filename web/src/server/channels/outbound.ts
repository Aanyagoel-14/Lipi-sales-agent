import type { Channel } from "@/generated/prisma/client";
import { composio, type ComposioClient } from "@/server/lib/composio";
import { recordEvent } from "@/server/lib/events";
import { HttpError } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { short } from "./connect";
import { specFor, type ChannelSpec, type Json, type SendRequest } from "./registry";

/**
 * The one way an agent message leaves the building.
 *
 * Three routes used to do this by hand — the webhook after ingest, the manual
 * reply box, the approval queue — each decrypting a stored provider token and
 * calling an adapter's own `fetch`. They disagreed about what a failure meant:
 * one flipped the whole connection to `error`, one swallowed it, one wrote an
 * event. In all three the message was already in the inbox looking sent.
 *
 * Here there is one attempt, one classification of what went wrong, and one
 * place where a message earns the word "sent". Two rules hold it together:
 *
 *   - A message is `sent` only when the provider accepted it. Anything else is
 *     `failed` with the provider's own reason attached, so the inbox can say
 *     what happened rather than implying it worked.
 *   - Only an authentication failure changes the connection, and only after a
 *     second call, carrying no message of its own, confirms the credential
 *     really is dead. A provider 401 is just as often a bad argument, and
 *     taking a working channel offline for every workspace conversation
 *     because one send was malformed is worse than the failure it reports.
 */

/** Longest a single failure reason is kept; `deliveryError` is shown in the inbox. */
const REASON_LIMIT = 300;

/** One retry, once, for the whole call — the budget `after()` can afford. */
const RETRY_DELAY_MS = 500;

export type SendOutcome = { delivered: boolean; reason?: string };

/**
 * What a provider refusal means for us.
 *
 * `policy` is the provider saying no to this message (the 24-hour window has
 * closed, the customer blocked the bot); nothing about the connection is
 * wrong and retrying would fail identically. `transient` is worth one retry.
 * `auth` is the credential, and is the only kind that touches the connection.
 */
type Failure = "auth" | "policy" | "transient";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whole numbers in a provider's error, as codes. Matching maximal digit runs
 * rather than substrings matters: `131026` must not read as the Meta auth
 * code `10`, which a naive `includes` would find inside it.
 */
const codesIn = (error: string): Set<number> =>
  new Set((error.match(/\d{2,7}/g) ?? []).map(Number));

/**
 * Provider error → what to do about it. Codes are from each provider's own
 * error reference; anything unlisted is treated as transient, retried once
 * and then recorded as a failure, because guessing "permanent" wrongly loses
 * a customer's reply and guessing "auth" wrongly disconnects a live channel.
 */
export function classify(channel: Channel, error: string): Failure {
  const text = error.toLowerCase();
  const codes = codesIn(error);
  const code = (...list: number[]) => list.some((value) => codes.has(value));

  switch (channel) {
    case "whatsapp":
      if (code(190) || /oauthexception|access token/.test(text)) return "auth";
      // 131047 re-engagement window closed, 131026 undeliverable,
      // 131051 unsupported message type.
      if (code(131047, 131026, 131051)) return "policy";
      // 131056 pair rate limit, 130429 throughput.
      if (code(131056, 130429) || /rate limit/.test(text)) return "transient";
      return "transient";

    case "instagram":
      if (code(190) || /oauthexception/.test(text)) return "auth";
      // Error 10 / subcode 2534022: outside the messaging window.
      if (code(2534022) || /outside.{0,20}window/.test(text)) return "policy";
      return "transient";

    case "telegram":
      if (code(401) || /unauthorized/.test(text)) return "auth";
      if (/blocked by the user|chat not found|user is deactivated|bot can't initiate/.test(text)) return "policy";
      if (code(429) || /too many requests/.test(text)) return "transient";
      return "transient";

    case "email":
      if (code(401, 403) || /invalid_grant|insufficient permission/.test(text)) return "auth";
      if (/invalid to header|recipient address rejected|mailbox unavailable|address not found/.test(text)) return "policy";
      return "transient";

    default:
      return "transient";
  }
}

/**
 * A long reply, cut into messages the provider will accept.
 *
 * Cutting at a sentence boundary is the difference between two messages that
 * read as two messages and two that read as a truncation. A single sentence
 * longer than the whole limit — a pasted URL, a list with no full stops —
 * falls back to the last space before the limit, and only cuts mid-word when
 * there is no space to use.
 */
export function splitText(text: string, limit: number | null): string[] {
  if (!limit || text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > limit) {
      flush();
      let rest = sentence;
      while (rest.length > limit) {
        const space = rest.slice(0, limit).lastIndexOf(" ");
        // A space in the last fifth of the window is a break; one near the
        // start would leave an almost-empty message, so cut at the limit.
        const at = space > limit * 0.8 ? space : limit;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
      continue;
    }

    const joined = current ? `${current} ${sentence}` : sentence;
    if (joined.length > limit) {
      flush();
      current = sentence;
    } else {
      current = joined;
    }
  }

  flush();
  return chunks.length ? chunks : [text.slice(0, limit)];
}

/**
 * Keys a provider's JSON envelope puts its human sentence under, in the order
 * worth trying. `error` is last because it is as often an object or a slug as
 * a sentence, and the keys above it are never anything else.
 */
const MESSAGE_KEYS = ["description", "message", "error_description", "error_user_msg", "detail", "title", "error"];
const CODE_KEYS = ["error_code", "code", "status_code", "status"];

/** The sentence and the number inside one level of a provider's error object. */
function unwrap(value: unknown, depth = 0): { message?: string; code?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return {};
  const record = value as Record<string, unknown>;
  const found: { message?: string; code?: string } = {};

  for (const key of CODE_KEYS) {
    const code = record[key];
    if (typeof code === "number" || (typeof code === "string" && /^\d+$/.test(code))) {
      found.code = String(code);
      break;
    }
  }

  for (const key of MESSAGE_KEYS) {
    const held = record[key];
    if (typeof held === "string" && held.trim()) {
      found.message = held.trim();
      break;
    }
    const nested = unwrap(held, depth + 1);
    if (nested.message) {
      found.message = nested.message;
      found.code ??= nested.code;
      break;
    }
  }

  return found;
}

/**
 * A provider refusal, as an operator should read it.
 *
 * Meta answers in prose — `(#131047) Message failed to send because more than
 * 24 hours have passed` — and that is already the best version of itself.
 * Telegram answers `{"ok":false,"error_code":401,"description":"Unauthorized"}`,
 * and the inbox showed exactly that, braces and all, under a message the
 * operator was trying to send. The envelope is unwrapped to the sentence
 * inside it, keeping the code in front, because the code is what makes one
 * failure searchable against a provider's error reference.
 *
 * Only for display. Classification always runs on the provider's original
 * string: the codes it turns on can live in fields this never reaches.
 */
export function readable(error: string): string {
  const start = error.indexOf("{");
  const end = error.lastIndexOf("}");
  if (start === -1 || end <= start) return error;

  let parsed: unknown;
  try {
    parsed = JSON.parse(error.slice(start, end + 1));
  } catch {
    // Not JSON after all, or a fragment of it. The original said more.
    return error;
  }

  const { message, code } = unwrap(parsed);
  if (!message) return error;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

const markFailed = (messageId: string, reason: string) =>
  prisma.message.update({
    where: { id: messageId },
    data: { deliveryStatus: "failed", deliveryError: reason.slice(0, REASON_LIMIT) },
  });

/**
 * Is the credential itself finished, or was this one bad send?
 *
 * Two questions, asked in that order, because they are not the same question.
 * Composio's account status answers "has the grant been withdrawn" — it turns
 * non-ACTIVE when an OAuth refresh fails, which is authoritative and costs no
 * provider round-trip. But Composio only knows what it can observe, and for
 * an API-key toolkit there is nothing to observe: a Telegram token revoked in
 * @BotFather leaves the account ACTIVE forever, so a channel whose every send
 * now 401s would keep reading "Live" if the status were the only evidence.
 *
 * So a still-ACTIVE account is asked the second question directly — the
 * spec's own identity call, the same cheap read the Test button makes. An
 * auth failure on a read that carries no message arguments cannot be blamed
 * on the message, which is what makes it evidence about the credential.
 *
 * Either way an unreachable Composio means "assume not": the send failure is
 * already recorded on the message, and taking a probably-fine channel offline
 * for every conversation in the workspace is the worse mistake.
 */
async function credentialIsDead(
  client: ComposioClient,
  spec: ChannelSpec,
  workspaceId: string,
  connectedAccountId: string,
): Promise<boolean> {
  try {
    if ((await client.getAccount(connectedAccountId)).status !== "ACTIVE") return true;
  } catch {
    return false;
  }

  try {
    const probe = await client.execute(spec.identity.slug, {
      userId: workspaceId,
      connectedAccountId,
      arguments: spec.identity.arguments ?? {},
    });
    return !probe.successful && classify(spec.channel, probe.error ?? "") === "auth";
  } catch {
    return false;
  }
}

export async function sendReply(args: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  /** Who pressed the button, when a human did; goes into the event trail. */
  by?: string;
}): Promise<SendOutcome> {
  const message = await prisma.message.findFirst({
    // Scoped through the conversation rather than by id alone: a message id
    // from another tenant must not resolve here even if it is guessed right.
    where: {
      id: args.messageId,
      conversationId: args.conversationId,
      conversation: { workspaceId: args.workspaceId },
    },
    include: { conversation: { include: { customer: true } } },
  });
  if (!message) throw new HttpError(404, "Message not found");

  const conversation = message.conversation;
  const channel = conversation.channel;
  const spec = specFor(channel);

  const connection = await prisma.channelConnection.findUnique({
    where: { workspaceId_channel: { workspaceId: args.workspaceId, channel } },
  });

  // Nothing to retry and nothing wrong with the channel: the workspace simply
  // has not connected it. The message stays in the thread, marked for what it
  // is, and no event is written — this is not an incident.
  if (!spec) {
    const reason = `${channel} cannot send messages`;
    await markFailed(message.id, reason);
    return { delivered: false, reason };
  }
  if (!connection || connection.status !== "connected" || !connection.composioAccountId) {
    const reason = "Channel not connected";
    await markFailed(message.id, reason);
    return { delivered: false, reason };
  }
  const connectedAccountId = connection.composioAccountId;

  // The builder throws when the connection is missing something the tool
  // needs — a WhatsApp account with several numbers and none chosen yet. That
  // is the operator's next action, so it is reported as the reason verbatim.
  let sends: SendRequest[];
  try {
    sends = splitText(message.text, spec.textLimit).map((part) =>
      spec.send({
        to: conversation.customer.handle,
        text: part,
        config: (connection.config ?? {}) as Json,
        subject: conversation.subject,
      }),
    );
  } catch (error) {
    const reason = short(error);
    await markFailed(message.id, reason);
    return { delivered: false, reason };
  }

  await prisma.message.update({
    where: { id: message.id },
    data: { deliveryStatus: "pending", deliveryError: null },
  });

  const client = composio();
  const attempt = async (send: SendRequest): Promise<string | null> => {
    try {
      const result = await client.execute(send.slug, {
        userId: args.workspaceId,
        connectedAccountId,
        arguments: send.arguments,
      });
      // A provider refusal comes back as `successful: false`; only Composio
      // itself being unreachable throws.
      return result.successful ? null : (result.error ?? `${spec.label} refused the message`);
    } catch (error) {
      return short(error);
    }
  };

  let failure: { kind: Failure; error: string } | null = null;
  let retried = false;

  for (const send of sends) {
    let error = await attempt(send);
    if (error && !retried && classify(channel, error) === "transient") {
      // One retry for the whole reply, not one per part: a split message must
      // not turn a slow provider into seconds of latency inside `after()`.
      retried = true;
      await sleep(RETRY_DELAY_MS);
      error = await attempt(send);
      // A retried transient failure has had its chance; treat it as final
      // unless the second answer says the credential is the problem.
      if (error) {
        failure = { kind: classify(channel, error) === "auth" ? "auth" : "policy", error: readable(error) };
        break;
      }
    } else if (error) {
      failure = { kind: classify(channel, error), error: readable(error) };
      break;
    }
  }

  if (!failure) {
    await prisma.message.update({
      where: { id: message.id },
      data: { deliveryStatus: "sent", deliveryError: null },
    });
    await recordEvent(args.workspaceId, "reply.sent", "conversation",
      `${conversation.id} via ${channel}${args.by ? ` by ${args.by}` : ""}`);
    return { delivered: true };
  }

  if (failure.kind === "auth" && await credentialIsDead(client, spec, args.workspaceId, connectedAccountId)) {
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { status: "needs_reconnect", lastError: failure.error.slice(0, REASON_LIMIT) },
    });
    await markFailed(message.id, failure.error);
    await recordEvent(args.workspaceId, "channel.expired", "conversation",
      `${channel}: ${failure.error.slice(0, 160)}`);
    return { delivered: false, reason: failure.error };
  }

  await markFailed(message.id, failure.error);
  await recordEvent(args.workspaceId, "reply.failed", "conversation",
    `${conversation.id} via ${channel}: ${failure.error.slice(0, 160)}`);
  return { delivered: false, reason: failure.error };
}
