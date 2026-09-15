/**
 * Fixed-window rate limiting for unauthenticated public endpoints.
 *
 * Everything under `/v1/webchat/*` and `/webhooks/*` has no session and no
 * API key to throttle by tenant — the webchat endpoints are keyed only by a
 * client-chosen `visitorId` inside a public `workspaceId`, and the webhook
 * endpoints are keyed by whatever the provider's payload happens to carry.
 * The only value guaranteed to be attached to every request at the transport
 * layer, regardless of what a caller sends, is its source IP. That is the
 * dimension throttled here — not workspace, not visitorId — because either
 * of those is trivially spammable by an attacker who just changes the value
 * on every request, whereas rotating source IPs is a materially higher bar.
 *
 * H-1/H-2-adjacent hardening (L-1 audit family, "no rate limiting on public
 * endpoints"): before this, a single caller could POST
 * `/v1/webchat/:workspaceId/message` in a tight loop and each request ran a
 * full `ingest()` transaction — an LLM extraction call, several writes, a
 * lead-score recompute — for free, against a workspaceId that is meant to be
 * public. That is both a cost-abuse vector and a way to manufacture fake
 * "engaged" leads in a real operator's funnel.
 *
 * Deliberately in-memory, not Redis/Upstash: this app already runs as a
 * single long-lived Node process (the whole point of "not Cloudflare Pages"
 * for this project — see DEPLOYMENT.md), so a process-local map is correct
 * for one instance. The one thing it is honestly NOT correct for is a
 * multi-instance horizontal deployment behind a load balancer, where each
 * instance would enforce the limit independently rather than in aggregate —
 * documented here and in DEPLOYMENT.md rather than silently assumed away.
 * If this app is ever run with more than one instance, replace the Map below
 * with a shared store (Redis INCR+EXPIRE is the standard shape) without
 * changing the call sites, which only see `checkRateLimit()`.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Cheap, bounded cleanup: sweep expired buckets whenever the map has grown
// past a point where an attacker cycling IPs could otherwise grow it
// unboundedly. This is not a background timer (nothing runs when no
// requests are arriving), just an amortised cost paid by traffic itself.
const SWEEP_THRESHOLD = 5000;
function sweep(now: number) {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * `key` should already include whatever scope makes sense for the caller
 * (e.g. `webchat:message:<ip>`) — this function does no scoping of its own.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (existing.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { allowed: true };
}

/** Best-effort source IP from the headers a reverse proxy (or Next itself) sets. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Only exported for tests: lets a suite reset state between cases without a process restart. */
export function _resetRateLimitsForTests() {
  buckets.clear();
}
