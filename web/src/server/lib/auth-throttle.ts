import { HttpError } from "./http";
import { checkRateLimit, clientIp } from "./rate-limit";

/**
 * A budget on the password endpoints.
 *
 * `/v1/auth/login` and `/v1/auth/signup` were the only unauthenticated
 * write endpoints in the API with no ceiling at all, which made them the
 * cheapest place to guess a password or enumerate which addresses have
 * accounts. Every other public endpoint already had one (`lib/cors.ts` for the
 * widget, `lib/api-key.ts` per key); these two simply predated the habit.
 *
 * Two keys, deliberately:
 *
 *   per address   bounds one machine working through a password list
 *   per email     bounds a distributed attempt on one account, which the
 *                 address budget alone cannot see
 *
 * Both are needed. An attacker with a thousand addresses defeats the first;
 * an attacker with one address and a thousand emails defeats the second.
 *
 * The same caveat as `lib/rate-limit.ts`: this is per process and in memory,
 * so a horizontally scaled deployment enforces it per instance. That is worth
 * saying out loud rather than implying a guarantee — see
 * `docs/impl/SECURITY_REVIEW.md` F-3. It still turns an unbounded loop into a
 * bounded one, which is the difference that matters here.
 */

/** Attempts per address per window. Generous for a person, tight for a script. */
export const AUTH_IP_LIMIT = 20;
/** Attempts against one account per window, from anywhere. */
export const AUTH_EMAIL_LIMIT = 10;
export const AUTH_WINDOW_MS = 15 * 60_000;

/**
 * Throws 429 with `Retry-After` when either budget is spent.
 *
 * Called *before* the password is verified, so a refused attempt costs a map
 * lookup rather than an Argon2 hash — otherwise the throttle itself becomes
 * the denial of service.
 */
export function throttleAuth(req: Request, email: string) {
  const address = clientIp(req);

  // `clientIp` answers "unknown" when no proxy header is set, and "unknown" is
  // not an address — it is the absence of one. Bucketing every such caller
  // together would be both useless and dangerous: useless because an attacker
  // sets the header themselves, and dangerous because one shared bucket means
  // the first twenty failed logins lock out every remaining user of a
  // deployment that is not behind a proxy. The per-email ceiling below still
  // bounds an attack on any single account, which is the part that protects a
  // password.
  if (address !== "unknown") {
    const byAddress = checkRateLimit(`auth:ip:${address}`, AUTH_IP_LIMIT, AUTH_WINDOW_MS);
    if (!byAddress.allowed) {
      throw new HttpError(429, "Too many attempts. Try again shortly.", undefined, {
        "Retry-After": String(byAddress.retryAfterSeconds),
      });
    }
  }

  const byEmail = checkRateLimit(`auth:email:${email.toLowerCase()}`, AUTH_EMAIL_LIMIT, AUTH_WINDOW_MS);
  if (!byEmail.allowed) {
    // Deliberately the same message and status as the address ceiling. A
    // distinct one would tell a caller that *this* address has an account
    // worth protecting, which is the enumeration the login route's own
    // "same message either way" comment already guards against.
    throw new HttpError(429, "Too many attempts. Try again shortly.", undefined, {
      "Retry-After": String(byEmail.retryAfterSeconds),
    });
  }
}
