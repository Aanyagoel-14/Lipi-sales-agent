import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma";
import type { ExceptionKind, InventoryConnector } from "@/generated/prisma/client";

/**
 * The inventory connector.
 *
 * A CSV import is a snapshot: right when it is taken, wrong as soon as
 * anything sells. Everything the twin promises — "4 left in XL cobalt", a
 * reservation, a lead time — is only as true as this number, so it needs a
 * feed rather than a file.
 *
 * The source pushes batches here; it is not polled. An ERP or POS knows when
 * its stock moved and we do not, and polling every workspace's system on a
 * timer is a fleet of credentials and rate limits for data that is stale
 * between ticks anyway.
 *
 * Three properties make it safe to point a real system at:
 *
 *   Idempotency. A batch carries a key. Networks time out mid-write, so the
 *   source must be able to retry, and a retry must not apply the same
 *   correction twice. Replaying a key returns the first outcome verbatim.
 *
 *   A cursor. The source's own position in its change feed, stored and handed
 *   back, so a resumed sync continues rather than restarting.
 *
 *   An exception queue. A row we cannot apply becomes visible work instead of
 *   a silent drop. A connector reporting success while quietly discarding
 *   unmapped SKUs is worse than one that reports failure.
 */

/** Corrections go through the same event type as a manual one, deliberately. */
const CORRECTION_EVENT = "inventory_twin.corrected";

const eventId = () => `evt_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/* --------------------------------- secrets -------------------------------- */

/**
 * The push token is hashed, not encrypted: we only ever need to *check* one,
 * never to read it back, and a stolen database should not yield working
 * credentials for a customer's ERP. Shown once at creation.
 */
export function newConnectorSecret() {
  const secret = `lipi_inv_${randomBytes(24).toString("base64url")}`;
  return { secret, hash: hashSecret(secret) };
}

export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function secretMatches(presented: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(presented), "utf8");
  const b = Buffer.from(hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------------------------- types --------------------------------- */

export type SyncRow = {
  sku: string;
  /** Absolute on-hand count at the source. Not a delta: deltas cannot survive
   *  a dropped batch, and a re-sent absolute value is self-correcting. */
  stock: number;
};

export type SyncBatch = {
  idempotencyKey: string;
  rows: SyncRow[];
  /** The source's position after this batch. Stored verbatim. */
  cursor?: string;
};

export type AppliedChange = {
  sku: string;
  variantId: string;
  product: string;
  variant: string;
  from: number;
  to: number;
};

export type Rejection = {
  sku: string;
  kind: ExceptionKind;
  detail: string;
  payload: SyncRow;
};

export type SyncOutcome = {
  runId: string;
  replayed: boolean;
  status: "applied" | "partial" | "failed";
  received: number;
  applied: number;
  rejected: number;
  cursor: string | null;
  changes: AppliedChange[];
  rejections: Rejection[];
};

/* -------------------------------- the sync -------------------------------- */

export async function applySync(
  connector: InventoryConnector,
  batch: SyncBatch,
): Promise<SyncOutcome> {
  const startedAt = Date.now();

  // Replay first, and outside the transaction: the answer is already recorded
  // and re-deriving it would mean re-applying the batch.
  const existing = await prisma.inventorySyncRun.findUnique({
    where: { connectorId_idempotencyKey: { connectorId: connector.id, idempotencyKey: batch.idempotencyKey } },
  });
  if (existing) {
    return {
      runId: existing.id,
      replayed: true,
      status: existing.status,
      received: existing.received,
      applied: existing.applied,
      rejected: existing.rejected,
      cursor: existing.cursor,
      changes: existing.changes as AppliedChange[],
      rejections: [],
    };
  }

  // One SKU twice in a batch is the source contradicting itself; applying both
  // means the twin ends on whichever arrived last.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of batch.rows) {
    if (seen.has(row.sku)) duplicates.add(row.sku);
    seen.add(row.sku);
  }

  const mappings = await prisma.inventoryMapping.findMany({
    where: { connectorId: connector.id, externalSku: { in: [...seen] } },
    include: { variant: { include: { product: { select: { name: true, workspaceId: true } } } } },
  });
  const bySku = new Map(mappings.map((m) => [m.externalSku, m]));

  const changes: AppliedChange[] = [];
  const rejections: Rejection[] = [];

  const reject = (row: SyncRow, kind: ExceptionKind, detail: string) =>
    rejections.push({ sku: row.sku, kind, detail, payload: row });

  return await prisma.$transaction(
    async (tx): Promise<SyncOutcome> => {
      for (const row of batch.rows) {
        if (duplicates.has(row.sku)) {
          reject(row, "ambiguous_sku", "The batch sends this SKU more than once");
          continue;
        }
        if (!Number.isInteger(row.stock) || row.stock < 0 || row.stock > 1_000_000) {
          reject(row, "invalid_quantity", `${row.stock} is not a stock count we can store`);
          continue;
        }

        const mapping = bySku.get(row.sku);
        if (!mapping) {
          reject(row, "unmapped_sku", "No variant is mapped to this SKU yet");
          continue;
        }
        // A mapping cascades with its variant, so this is belt-and-braces
        // against a connector pointed at another workspace's rows.
        if (mapping.variant.product.workspaceId !== connector.workspaceId) {
          reject(row, "unknown_variant", "That variant does not belong to this workspace");
          continue;
        }

        // Reserved units are already promised to a customer. Accepting a count
        // below them would let the twin quote stock it has committed twice, so
        // the correction is refused and surfaced rather than clamped.
        if (row.stock < mapping.variant.reserved) {
          reject(
            row,
            "below_reserved",
            `Source says ${row.stock} but ${mapping.variant.reserved} are already reserved`,
          );
          continue;
        }

        if (mapping.variant.stock === row.stock) continue;

        await tx.variant.update({ where: { id: mapping.variantId }, data: { stock: row.stock } });
        changes.push({
          sku: row.sku,
          variantId: mapping.variantId,
          product: mapping.variant.product.name,
          variant: `${mapping.variant.optionA} / ${mapping.variant.optionB}`,
          from: mapping.variant.stock,
          to: row.stock,
        });
      }

      if (changes.length) {
        await tx.twinEvent.createMany({
          data: changes.map((c, i) => ({
            id: `${eventId()}${i}`,
            workspaceId: connector.workspaceId,
            occurredAt: new Date(),
            type: CORRECTION_EVENT,
            twin: "inventory",
            payload: `${c.product} ${c.variant} ${c.from}->${c.to} via ${connector.source} sku=${c.sku}`,
          })),
        });
      }

      if (rejections.length) {
        await tx.inventoryException.createMany({
          data: rejections.map((r) => ({
            connectorId: connector.id,
            kind: r.kind,
            externalSku: r.sku,
            payload: r.payload,
            detail: r.detail,
          })),
        });
      }

      const status = rejections.length === 0 ? "applied" : changes.length > 0 ? "partial" : "failed";

      // H-1 fix: the cursor must only advance on a batch that actually made
      // progress (`applied` or `partial`). A `failed` batch — every row
      // rejected, nothing changed — must leave the connector's cursor exactly
      // where it was, so the source resumes from the same position and the
      // rejected rows are re-sent rather than silently skipped forever.
      //
      // The previous code wrote `batch.cursor ?? connector.cursor`
      // unconditionally, which happens to look like "holding the cursor" when
      // the source omits `cursor` on a retry, but a source that DOES send its
      // own advancing cursor on every batch (the documented contract) moved
      // the watermark even on a fully rejected batch — exactly the audit's
      // reproduction: a batch at seq=6 with everything rejected still moved
      // the connector to seq=6.
      const nextCursor = status === "failed" ? connector.cursor : (batch.cursor ?? connector.cursor);

      const run = await tx.inventorySyncRun.create({
        data: {
          connectorId: connector.id,
          idempotencyKey: batch.idempotencyKey,
          status,
          received: batch.rows.length,
          applied: changes.length,
          rejected: rejections.length,
          // The run record still keeps the batch's OWN reported cursor for
          // reconciliation ("why did this batch claim to be at"), separate
          // from the connector's watermark, which is what actually decides
          // where the next batch resumes from.
          cursor: batch.cursor ?? connector.cursor,
          durationMs: Date.now() - startedAt,
          changes,
          error: rejections.length ? `${rejections.length} row(s) could not be applied` : null,
        },
      });

      await tx.inventoryConnector.update({
        where: { id: connector.id },
        data: {
          cursor: nextCursor,
          lastSyncAt: new Date(),
          status: status === "failed" ? "error" : "connected",
          lastError: status === "applied" ? null : `${rejections.length} row(s) need attention`,
          appliedCount: { increment: changes.length },
          failedCount: { increment: rejections.length },
        },
      });

      // Returned from inside the transaction so the run id and status come
      // from the committed row rather than being guessed before the write.
      return {
        runId: run.id,
        replayed: false,
        status,
        received: batch.rows.length,
        applied: changes.length,
        rejected: rejections.length,
        cursor: run.cursor,
        changes,
        rejections,
      };
    },
    { timeout: 30_000 },
  );
}

/* ----------------------------- reconciliation ----------------------------- */

/**
 * Is the inventory twin trustworthy right now?
 *
 * Not "did the last sync return 200". A connector that has not been heard from
 * in a day, or that is sitting on unresolved exceptions, is one whose stock
 * numbers the agents should not be quoting confidently — and the operator is
 * the only one who can fix either.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export async function reconcile(workspaceId: string) {
  const connectors = await prisma.inventoryConnector.findMany({
    where: { workspaceId },
    include: {
      _count: {
        select: {
          mappings: true,
          exceptions: { where: { resolvedAt: null } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const [mappedVariants, totalVariants] = await Promise.all([
    prisma.variant.count({
      where: { product: { workspaceId }, inventoryMappings: { some: {} } },
    }),
    prisma.variant.count({ where: { product: { workspaceId } } }),
  ]);

  const now = Date.now();

  return {
    connectors: connectors.map((c) => {
      const staleFor = c.lastSyncAt ? now - c.lastSyncAt.getTime() : null;
      const stale = c.lastSyncAt === null || (staleFor !== null && staleFor > STALE_AFTER_MS);

      return {
        id: c.id,
        source: c.source,
        name: c.name,
        status: c.status,
        cursor: c.cursor,
        lastSyncIso: c.lastSyncAt?.toISOString() ?? null,
        lastError: c.lastError,
        appliedCount: c.appliedCount,
        failedCount: c.failedCount,
        mappings: c._count.mappings,
        openExceptions: c._count.exceptions,
        // Two different problems, and an operator fixes them differently.
        stale,
        healthy: !stale && c.status === "connected" && c._count.exceptions === 0,
      };
    }),
    coverage: {
      /* Unmapped variants are the silent gap: they never appear in a sync, so
       * they never look broken, they just quietly keep their import-day
       * number. */
      mappedVariants,
      totalVariants,
      unmappedVariants: totalVariants - mappedVariants,
    },
  };
}
