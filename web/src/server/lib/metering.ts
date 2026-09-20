import type { ModelPurpose } from "@/generated/prisma/client";
import { prisma } from "./prisma";

/**
 * What the language models cost this workspace, and what it is allowed to spend.
 *
 * `lib/rate-limit.ts` bounds *requests per IP* in one process's memory. That
 * is the wrong unit for a model call twice over: it does not know what a call
 * costs, and it is per-process, so it says nothing about one workspace being
 * ground through its budget by a caller rotating addresses. This counts the
 * thing that is actually billed — calls and tokens — in Postgres, per tenant.
 *
 * Two halves, and they are deliberately not the same code path:
 *
 *   recordModelCall  is called by `lib/openrouter.ts` on the way out of every
 *                    call, successful or not. It is a fact about what was spent.
 *   checkModelBudget is called by each model-backed service before it spends.
 *                    Its answer is advice: nothing here throws, and a workspace
 *                    over its ceiling gets the deterministic path, not a 500.
 *
 * Both are scoped by `workspaceId` (invariant 5). Nothing here stores money:
 * see the note on `ModelCall` in the schema.
 */

/** Who is spending, on what. Threaded from the service down into the transport. */
export type ModelMeter = {
  workspaceId: string;
  purpose: ModelPurpose;
  /**
   * The customer twin whose thread is spending, when there is one. Null for
   * the operator's own twin chat, and for a customer's very first message,
   * where the row does not exist yet.
   */
  customerId?: string | null;
};

/** Tokens as the response reported them. Absent when there was no response. */
export type ModelUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type BudgetVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * The ceilings reset at UTC midnight rather than at the workspace's own
 * midnight: there is no timezone on `Workspace` to read, and a budget that
 * moves with a guess about where the operator lives is worse than one that is
 * simply stated. Documented in `docs/api.md` next to the endpoint.
 */
export function startOfDayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Long provider errors are evidence, not prose: enough to recognise, not to store. */
const ERROR_MAX = 300;

/**
 * Appends the row. Never throws.
 *
 * A meter that can fail the call it is measuring would turn a Postgres blip
 * into a workspace-wide degradation, and the spend has already happened by
 * the time this runs — there is nothing to protect by failing loudly. The
 * warning is the signal that a budget is undercounting.
 */
export async function recordModelCall(call: ModelMeter & {
  model: string;
  latencyMs: number;
  ok: boolean;
  usage?: ModelUsage | null;
  error?: string;
}): Promise<void> {
  try {
    await prisma.modelCall.create({
      data: {
        workspaceId: call.workspaceId,
        customerId: call.customerId ?? null,
        purpose: call.purpose,
        model: call.model,
        promptTokens: call.usage?.promptTokens ?? null,
        completionTokens: call.usage?.completionTokens ?? null,
        totalTokens: call.usage?.totalTokens ?? null,
        latencyMs: call.latencyMs,
        ok: call.ok,
        error: call.error ? call.error.slice(0, ERROR_MAX) : null,
      },
    });
  } catch (error) {
    console.warn(`[metering] could not record a ${call.purpose} call: ${(error as Error).message}`);
  }
}

/**
 * Whether this workspace — and this customer's thread within it — may spend
 * another call.
 *
 * Checked before the call rather than after, so the ceiling is a ceiling
 * rather than a high-water mark. A workspace at its limit is told why, and
 * the reason travels to the operator on `SellResult.degraded`.
 */
export async function checkModelBudget(meter: ModelMeter, now = new Date()): Promise<BudgetVerdict> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: meter.workspaceId },
    select: { dailyModelCalls: true, dailyModelTokens: true, customerModelCalls: true },
  });
  // No workspace means no budget to spend. The caller's own lookup will raise
  // a better error than this one could.
  if (!workspace) return { allowed: false, reason: "Unknown workspace" };

  const since = startOfDayUtc(now);
  const day = await prisma.modelCall.aggregate({
    where: { workspaceId: meter.workspaceId, occurredAt: { gte: since } },
    _count: { _all: true },
    _sum: { totalTokens: true },
  });

  const calls = day._count._all;
  if (calls >= workspace.dailyModelCalls) {
    return { allowed: false, reason: `Daily model call budget spent (${calls}/${workspace.dailyModelCalls})` };
  }

  const tokens = day._sum.totalTokens ?? 0;
  if (tokens >= workspace.dailyModelTokens) {
    return { allowed: false, reason: `Daily model token budget spent (${tokens}/${workspace.dailyModelTokens})` };
  }

  if (!meter.customerId) return { allowed: true };

  // Scoped by workspace as well as by customer: a customer id belongs to one
  // tenant, but a query that only trusted the id would be the one place here
  // that took a caller's word for the tenant.
  const forCustomer = await prisma.modelCall.count({
    where: { workspaceId: meter.workspaceId, customerId: meter.customerId, occurredAt: { gte: since } },
  });
  if (forCustomer >= workspace.customerModelCalls) {
    return {
      allowed: false,
      reason: `This conversation's daily model call budget is spent (${forCustomer}/${workspace.customerModelCalls})`,
    };
  }

  return { allowed: true };
}

export type ModelSpend = {
  /** The UTC day these figures cover, as the ceilings are counted. */
  day: string;
  ceilings: { dailyCalls: number; dailyTokens: number; conversationCalls: number };
  today: { calls: number; failed: number; tokens: number };
  byPurpose: { purpose: ModelPurpose; calls: number; failed: number; tokens: number }[];
  /** True when the next model-backed turn would fall back to its plain path. */
  exhausted: boolean;
};

/** What the dashboard reads. One tenant, today, broken down by what spent it. */
export async function modelSpend(workspaceId: string, now = new Date()): Promise<ModelSpend> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { dailyModelCalls: true, dailyModelTokens: true, customerModelCalls: true },
  });

  const since = startOfDayUtc(now);
  const where = { workspaceId, occurredAt: { gte: since } };

  const [groups, failures] = await Promise.all([
    prisma.modelCall.groupBy({
      by: ["purpose"],
      where,
      _count: { _all: true },
      _sum: { totalTokens: true },
    }),
    prisma.modelCall.groupBy({ by: ["purpose"], where: { ...where, ok: false }, _count: { _all: true } }),
  ]);

  const failedBy = new Map(failures.map((row) => [row.purpose, row._count._all]));
  const byPurpose = groups
    .map((row) => ({
      purpose: row.purpose,
      calls: row._count._all,
      failed: failedBy.get(row.purpose) ?? 0,
      tokens: row._sum.totalTokens ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.purpose.localeCompare(b.purpose));

  const total = (pick: (row: (typeof byPurpose)[number]) => number) =>
    byPurpose.reduce((sum, row) => sum + pick(row), 0);
  const calls = total((row) => row.calls);
  const tokens = total((row) => row.tokens);

  return {
    day: since.toISOString().slice(0, 10),
    ceilings: {
      dailyCalls: workspace.dailyModelCalls,
      dailyTokens: workspace.dailyModelTokens,
      conversationCalls: workspace.customerModelCalls,
    },
    today: { calls, failed: total((row) => row.failed), tokens },
    byPurpose,
    exhausted: calls >= workspace.dailyModelCalls || tokens >= workspace.dailyModelTokens,
  };
}
