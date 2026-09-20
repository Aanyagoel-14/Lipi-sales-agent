import { HttpError } from "./http";

/**
 * The one place Lipi makes an HTTP request to a customer's own server.
 *
 * It is a seam for the same reason `lib/shopify.ts` is one: the suite must
 * never reach the network, and a delivery test that could would be both slow
 * and a way to post a signed body at whatever host a fixture happened to
 * name. Tests swap the whole poster through `setWebhookPoster`.
 *
 * The transport deliberately knows nothing about subscriptions, retries or
 * signing. All it does is take bytes to a URL and say what came back, so the
 * delivery service can treat "the endpoint said 500" and "the endpoint never
 * answered" as the two different facts they are.
 */

export type WebhookPost = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/** `status` is what the endpoint answered; `error` means it never did. */
export type WebhookPostResult = { status: number | null; error: string | null };

export type WebhookPoster = (post: WebhookPost) => Promise<WebhookPostResult>;

/** A subscriber that has not answered by now is a subscriber that is down. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

const httpPoster: WebhookPoster = async ({ url, headers, body }) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      // A redirect would re-post the signed body to a host the operator never
      // named, which is the one thing a signed delivery must not do.
      redirect: "manual",
    });
    // The body is drained and dropped. A subscriber answers with a status; a
    // megabyte of HTML from a proxy is not a reply we have any use for.
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status, error: null };
  } catch (error) {
    return { status: null, error: reasonOf(error) };
  }
};

/** Why no answer came, in words an operator can act on. */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed";
  if (error.name === "TimeoutError") return `No answer within ${WEBHOOK_TIMEOUT_MS / 1000}s`;
  return error.message;
}

let poster: WebhookPoster = httpPoster;

export const webhookPoster = () => poster;

/** Test seam, matching `setShopifyClient` and `setComposioClient`. */
export const setWebhookPoster = (replacement: WebhookPoster) => {
  poster = replacement;
};

/**
 * Where a subscription is allowed to point.
 *
 * An operator types this URL and we then POST to it from inside the
 * deployment's own network, so an unchecked value turns Lipi into a request
 * forwarder aimed at whatever that network can reach — the same reasoning that
 * validates a `*.myshopify.com` shop name before it is used to build a URL.
 * So: HTTPS, because a delivery is a customer's business leaving the building
 * and it does not leave in the clear, and no private or link-local host,
 * because those are the deployment's own neighbours rather than the
 * integrator's server.
 *
 * The one exception is loopback outside production, which is how a developer
 * points a subscription at the handler they are writing. It is deliberately
 * narrower than "any private address": `http://localhost:4000` is someone's
 * own machine, `http://10.0.0.5` is something else on the cluster.
 *
 * This is a check on what was typed, not on where it resolves — a public name
 * pointed at a private address still gets through. Egress rules belong to the
 * deployment; this is the part the application can hold.
 */
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i;
const PRIVATE_HOST = /^(0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function requireDeliverableUrl(raw: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, "That is not a URL");
  }

  const loopback = LOOPBACK.test(url.hostname);

  // The developer's own handler is the one address allowed over plain http:
  // nothing posted to it leaves the machine.
  if (loopback && allowLoopback) return url;

  if (url.protocol !== "https:") throw new HttpError(422, "A webhook URL must be https");
  if (loopback || PRIVATE_HOST.test(url.hostname)) {
    throw new HttpError(422, "That host is not reachable from the internet");
  }
  return url;
}
