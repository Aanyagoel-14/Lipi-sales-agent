import { json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { dispatch } from "@/server/services/webhooks";

/**
 * Runs one pass of the outbound queue: read the log forward, then post what
 * is due.
 *
 * Lipi has no scheduler of its own, so the cadence is whoever calls this — a
 * cron, a platform timer, or the operator pressing the button. It takes a
 * session or an API key like the rest of `/v1`, which is what makes an
 * unattended cadence possible at all.
 *
 * It is a POST because it sends, and it is safe to call twice: a delivery
 * already owed cannot be owed again, and one that is not yet due is left
 * alone. It is deliberately *not* called from `ingest()` — a message mutates
 * all twins or none (invariant 1), and a customer's server being slow is not
 * a reason for that transaction to be open any longer.
 */
export const POST = route(async () => json(await dispatch(await resolveWorkspaceId())));

export const OPTIONS = route(preflight);
