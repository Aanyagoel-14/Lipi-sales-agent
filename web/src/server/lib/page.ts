import { z } from "zod";
import { HttpError } from "./http";

/**
 * Keyset pagination for the list endpoints.
 *
 * Every list here runs over a table that grows forever, so offsets are the
 * wrong tool: rows arriving mid-scroll shift the window and a page boundary
 * either repeats a row or skips one. Most lists are newest-first over a
 * timestamp (`after`); the catalogue is A-to-Z over a name (`afterText`).
 *
 * Prisma's own `cursor` option is also wrong here, and subtly so. It resolves
 * the anchor row by id *outside* the query's `where`, so a cursor naming
 * another tenant's row still positions the window — the tenant filter keeps
 * the rows themselves private, but `skip: 1` then drops a row that legitimately
 * belonged on the page. A caller could hide rows with a stale cursor.
 *
 * So the cursor carries the sort key itself and becomes a predicate. It can
 * only ever narrow a query already scoped to the workspace, needs no second
 * lookup, and drops exactly the rows that precede it.
 */
const schema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(200).optional(),
});

/** The last row of the previous page: its sort key, then its id as tiebreak. */
export type Anchor = { key: string; id: string };

export type Page = {
  limit: number;
  /** One more than the limit: the extra row is how we know a next page exists. */
  take: number;
  anchor: Anchor | null;
};

/** `<sortKey>.<id>`, base64url'd so it reads as opaque and survives a URL. */
export function encodeCursor(sortKey: Date | string, id: string): string {
  const key = sortKey instanceof Date ? String(sortKey.getTime()) : sortKey;
  return Buffer.from(`${key}.${id}`, "utf8").toString("base64url");
}

const invalidCursor = () => new HttpError(422, "That page cursor is not valid");

function decodeCursor(raw: string): Anchor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  // The *last* dot, not the first: a sort key can be text and contain one —
  // a product named "3.5mm cable" — while an id never does.
  const split = decoded.lastIndexOf(".");

  if (split < 1 || !decoded.slice(split + 1)) throw invalidCursor();

  return { key: decoded.slice(0, split), id: decoded.slice(split + 1) };
}

export function pageOf(req: Request): Page {
  const query = new URL(req.url).searchParams;
  const parsed = schema.safeParse({
    limit: query.get("limit") ?? undefined,
    cursor: query.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    throw new HttpError(422, "Invalid page", z.flattenError(parsed.error).fieldErrors);
  }

  const { limit, cursor } = parsed.data;
  return { limit, take: limit + 1, anchor: cursor ? decodeCursor(cursor) : null };
}

/**
 * The `where` fragment that resumes after the anchor, for a list ordered by
 * `[{ [field]: "desc" }, { id: "desc" }]`. The id tiebreak is what makes the
 * order total, so two rows sharing a timestamp cannot straddle a page.
 */
export function after(field: string, page: Page) {
  if (!page.anchor) return {};
  const { key, id } = page.anchor;
  const at = new Date(Number(key));
  if (!Number.isFinite(at.getTime())) throw invalidCursor();
  return {
    OR: [
      { [field]: { lt: at } },
      { [field]: at, id: { lt: id } },
    ],
  };
}

/**
 * The same fragment for a list ordered `[{ [field]: "asc" }, { id: "asc" }]`
 * over a text column. A catalogue reads A-to-Z, not newest-first, and forcing
 * it onto a timestamp would either need a column products do not have or hand
 * an integrator a page order no human would recognise.
 */
export function afterText(field: string, page: Page) {
  if (!page.anchor) return {};
  const { key, id } = page.anchor;
  return {
    OR: [
      { [field]: { gt: key } },
      { [field]: key, id: { gt: id } },
    ],
  };
}

/** Drops the sentinel row and mints the cursor for the next request. */
export function paged<T extends { id: string }>(
  rows: T[],
  page: Page,
  sortValue: (row: T) => Date | string,
) {
  if (rows.length <= page.limit) return { rows, nextCursor: null as string | null };
  const trimmed = rows.slice(0, page.limit);
  const last = trimmed[trimmed.length - 1]!;
  return { rows: trimmed, nextCursor: encodeCursor(sortValue(last), last.id) };
}
