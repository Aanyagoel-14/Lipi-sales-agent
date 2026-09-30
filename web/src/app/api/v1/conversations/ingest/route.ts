/**
 * The PRD's path for `/v1/conversations/ingest` (§8.1).
 *
 * The same handler object, not a copy: one implementation, one set of checks,
 * no way for the two prefixes to drift. See `src/app/api/v1/README.md`.
 */
export { POST, OPTIONS } from "@/app/v1/conversations/ingest/route";
