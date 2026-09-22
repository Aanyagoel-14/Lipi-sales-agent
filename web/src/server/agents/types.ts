import type { z } from "zod";
import type { Tx } from "../lib/prisma";
import type { TwinEffect } from "../lib/events";
import type { Guardrails } from "./guardrails";

/**
 * What a skill is, and what it is given to run with.
 *
 * Modelled on `server/channels/registry.ts`, which is the same idea one layer
 * out: a declarative spec plus a pure function, collected in one array, so a
 * new one is a file rather than a branch. The channel registry is why adding
 * X took a spec and no changes to the inbound or outbound funnels, and it is
 * the shape the PRD asks for here — "a registry/plugin pattern, not a switch
 * statement in an agent class".
 */

/**
 * The living twin, as a skill is allowed to touch it.
 *
 * Deliberately narrow. A skill does not get `prisma`; it gets the handful of
 * operations the PRD's own SDK example performs (§4.1 calls exactly one,
 * `ctx.twinStore.updateOrderDraft`) plus the reads a pricing or availability
 * decision needs. Handing a third-party skill the client would make every
 * invariant in this codebase — tenant scoping, integer money, append-only
 * events — a matter of that skill's good manners.
 *
 * Every method is already scoped to the executing workspace. None of them
 * takes a `workspaceId`, because a skill that could name one could name
 * somebody else's.
 */
export type TwinStore = {
  /**
   * The customer twin this execution is for, or null when the skill was
   * invoked outside a conversation (a dashboard test, a cron tick).
   */
  customer(): Promise<TwinCustomer | null>;

  /** A product and its variants by name or SKU, for pricing and availability. */
  findProduct(query: string): Promise<TwinProduct | null>;

  /** Live availability for one variant: what a customer could actually buy. */
  availability(variantId: string): Promise<{ stock: number; reserved: number; available: number } | null>;

  /**
   * Create or update the draft order this conversation is negotiating.
   *
   * The PRD's SDK example calls this with arbitrary `custom_specs` and a
   * `calculated_unit_price`, which is the whole point of a bespoke skill: the
   * *formula* is the customer's, the *storage* is ours. Amounts are integer
   * minor units, and a non-integer is refused rather than rounded — invariant
   * 4 is not negotiable by a plugin.
   */
  updateOrderDraft(draft: OrderDraftInput): Promise<{ id: string; unitPrice: number; leadDays: number }>;

  /** Unpaid invoices past their due date. The credit-risk signal in PRD §5. */
  pastDueInvoices(): Promise<{ count: number; totalPaise: number }>;
};

export type TwinCustomer = {
  id: string;
  name: string;
  handle: string;
  segment: string;
  lifetimeValue: number;
  riskScore: number;
  priceSensitivity: string;
  leadScore: number;
  leadStage: string;
};

export type TwinProduct = {
  id: string;
  name: string;
  category: string;
  /** Integer minor units. */
  price: number;
  marginPct: number;
  leadTimeDays: number;
  axes: string[];
  variants: { id: string; sku: string; optionA: string; optionB: string; stock: number; reserved: number }[];
};

export type OrderDraftInput = {
  /** Whatever the bespoke skill wants remembered about the spec. */
  customSpecs?: Record<string, unknown>;
  /** Integer minor units. */
  calculatedUnitPrice: number;
  quantity?: number;
  estimatedLeadDays?: number;
  /** Narrows the draft to a real catalogue row when the skill matched one. */
  productId?: string;
  variantId?: string;
};

/**
 * Everything a skill may reach. Nothing else is in scope inside `run()`.
 *
 * `tx` is the transaction the execution opened. A skill that writes uses it,
 * so its writes commit or roll back with the audit trail they produced —
 * the same all-or-nothing rule `ingest()` has always kept (invariant 1).
 */
export type ToolContext = {
  workspaceId: string;
  /** The configured agent, or null when a skill is executed directly. */
  agentId: string | null;
  agentName: string;
  customerId: string | null;
  conversationId: string | null;
  /** Fixed for the whole execution, so the audit trail agrees with itself. */
  now: Date;
  guardrails: Guardrails;
  twinStore: TwinStore;
  /** This skill's own stored configuration, as set on the agent. */
  config: Record<string, unknown>;
  tx: Tx;
  /**
   * Append to the event batch this execution will commit. A skill never
   * writes `TwinEvent` itself: events are evidence, they are append-only, and
   * collecting them here is what keeps a skill from writing one for something
   * that then rolls back (invariant 6).
   */
  record(type: string, twin: string, payload: string): void;
};

/**
 * What a skill hands back.
 *
 * `escalate` is the skill's own judgement that a human should see this —
 * separate from the guardrail checks around it, because a skill knows things
 * a ceiling cannot express ("I have no density for this material"). The
 * executor treats either as sufficient.
 */
export type SkillResult = {
  /** Shown to the operator in the run log. One line, no numbers the model chose. */
  summary: string;
  /** Structured output, returned to the caller and to the SDK. */
  data?: Record<string, unknown>;
  escalate?: { reason: string };
  /**
   * The largest amount this execution committed or offered, in integer minor
   * units, for `maxSingleQuoteValue` to be checked against. Absent means the
   * skill moved no money.
   */
  quotedValue?: number;
};

export type SkillCategory = "commerce" | "inventory" | "finance" | "scheduling" | "crm" | "custom";

export type SkillSpec<A = unknown> = {
  /** The PRD's own spelling, e.g. `Inventory_Lookup`. Stable; it is stored. */
  slug: string;
  label: string;
  description: string;
  category: SkillCategory;
  /**
   * The argument schema. This is the contract a model's tool call is checked
   * against before anything runs, and it is what the builder renders a form
   * from. A skill with no arguments declares an empty object, never `any`.
   */
  parameters: z.ZodType<A>;
  /**
   * Whether an execution moves money or commits stock. Decides whether the
   * workspace's `money_only` approval policy holds the result.
   */
  touchesMoney: boolean;
  /**
   * Phrases that always escalate for this skill regardless of the agent's own
   * trigger list — a skill knows its own dangerous edges better than an
   * operator writing a config does.
   */
  alwaysEscalateOn?: string[];
  run(args: A, ctx: ToolContext): Promise<SkillResult>;
};

/** What the executor returns, whichever way the execution went. */
export type SkillOutcome =
  | {
      status: "done" | "needs_approval";
      skill: string;
      runId: string;
      summary: string;
      data: Record<string, unknown>;
      events: TwinEffect[];
      /** Set when the outcome is `needs_approval`. */
      escalationReason?: string;
    }
  | {
      status: "refused";
      skill: string;
      /** Which rule refused, in a form safe to show a caller. */
      reason: string;
      /** Field-level detail for a schema failure. Never a stack trace. */
      details?: unknown;
    };
