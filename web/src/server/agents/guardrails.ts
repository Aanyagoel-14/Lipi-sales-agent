import { z } from "zod";

/**
 * What an agent is not allowed to do, per agent.
 *
 * The PRD states guardrails in two places and in two shapes — the deploy
 * contract's `{ max_autonomous_discount_pct, human_escalation_triggers }`
 * (§8.1) and the SDK's `{ maxSingleQuoteValue, escalateIfMaterialUnknown }`
 * (§4.1). They are one object here, because an agent deployed through the
 * builder and an agent registered through the SDK are the same kind of thing
 * and are executed by the same code. The wire format keeps the PRD's
 * snake_case; this is the parsed shape.
 *
 * Everything is optional and everything has a default, and the defaults are
 * the *cautious* reading rather than the permissive one: an agent whose
 * operator said nothing about discounts may not give one away, and an agent
 * whose operator said nothing about ceilings inherits a ceiling rather than
 * none. A guardrail object that fails to parse is refused at deploy; it is
 * never stored and then quietly ignored at execution time, which is the
 * failure mode that makes a guardrail worse than no guardrail.
 */
export const guardrailsSchema = z.object({
  /**
   * The most an agent may take off a price without a human. `0` — the default
   * — means it may not discount at all, which is what `services/voice.ts` has
   * always enforced for the built-in twin.
   */
  maxAutonomousDiscountPct: z.number().min(0).max(1).default(0),

  /**
   * The price floor, as a fraction of list. An agent may not quote below
   * this even when its discount allowance would otherwise permit it: the two
   * are different questions ("how much may you move" vs "how low may the
   * number go"), and a volume discount stacked onto a promotional price is
   * exactly how a floor gets crossed by accident.
   */
  minPriceFloorPct: z.number().min(0).max(1).default(0),

  /**
   * PRD §5, Customer Twin: "Authorizes custom quotes if margin > 18%". The
   * default is that figure. Expressed in whole percent to match
   * `Product.marginPct`, which is what it is compared against.
   */
  minMarginPct: z.number().min(0).max(100).default(18),

  /**
   * The largest single quote the agent may issue unattended, in integer minor
   * units (paise). PRD §4.1 writes `maxSingleQuoteValue: 25000`; the SDK
   * surface takes that figure in whole currency units and converts, so the
   * number an operator types is the number they meant.
   *
   * Null means no ceiling of its own — the workspace's approval policy is
   * then the only thing standing between a quote and a customer, which is
   * what the product did before agents existed.
   */
  maxSingleQuoteValue: z.number().int().nonnegative().nullable().default(null),

  /**
   * Words and codes that always fetch a human, whatever else the policy says.
   * The PRD's own examples are `DISPUTE` and `REFUND_OVER_500`. Matched
   * case-insensitively against the message and against the skill's own
   * declared triggers — see `escalationFor()`.
   */
  humanEscalationTriggers: z.array(z.string().min(1)).max(50).default([]),

  /**
   * PRD §4.1. A bespoke pricing skill handed a material it has no density for
   * must escalate rather than guess, and guessing is the default behaviour of
   * any formula with a fallback constant in it.
   */
  escalateIfMaterialUnknown: z.boolean().default(true),

  /**
   * A customer with money outstanding is a credit decision, not a sales one.
   * PRD §5: "flags credit risk if past-due invoices > 0".
   */
  escalateOnPastDueInvoices: z.boolean().default(true),
});

export type Guardrails = z.infer<typeof guardrailsSchema>;

/** Everything at its default: what an agent with no guardrails object gets. */
export const DEFAULT_GUARDRAILS: Guardrails = guardrailsSchema.parse({});

/**
 * The PRD's wire spelling, accepted alongside the parsed one.
 *
 * `POST /v1/agents/builder/deploy` takes the body the PRD prints verbatim
 * (§8.1), which is snake_case and carries only two of the fields. Rather than
 * two schemas that drift, the snake_case keys are renamed onto the canonical
 * ones here and the canonical schema does the validating.
 */
const WIRE_ALIASES: Record<string, keyof Guardrails> = {
  max_autonomous_discount_pct: "maxAutonomousDiscountPct",
  min_price_floor_pct: "minPriceFloorPct",
  min_margin_pct: "minMarginPct",
  max_single_quote_value: "maxSingleQuoteValue",
  human_escalation_triggers: "humanEscalationTriggers",
  escalate_if_material_unknown: "escalateIfMaterialUnknown",
  escalate_on_past_due_invoices: "escalateOnPastDueInvoices",
};

/**
 * Parses a guardrail object that may be written either way, or be absent.
 *
 * Throws `ZodError` on anything that is neither, which the deploy route turns
 * into a 422 naming the field. Silently defaulting a malformed guardrail would
 * hand the operator a ceiling they did not ask for and believe they had set.
 */
export function parseGuardrails(raw: unknown): Guardrails {
  if (raw === undefined || raw === null) return DEFAULT_GUARDRAILS;

  const input = raw as Record<string, unknown>;
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    renamed[WIRE_ALIASES[key] ?? key] = value;
  }
  return guardrailsSchema.parse(renamed);
}

/** Stored as JSON, read back as a `Guardrails`, defaulting anything absent. */
export const readGuardrails = (stored: unknown): Guardrails => {
  const parsed = guardrailsSchema.safeParse(stored ?? {});
  // A row that predates a field, or one written by an older release, is worth
  // more than a crash: fall back to the cautious defaults rather than refuse
  // to run the agent at all.
  return parsed.success ? parsed.data : DEFAULT_GUARDRAILS;
};

/**
 * Whether anything in `text` trips one of the agent's escalation triggers.
 *
 * Substring, case-insensitive, on word-ish boundaries: an operator writing
 * `REFUND_OVER_500` means the phrase, and a customer writing "refund over
 * 500" means the same thing. Returns the trigger that matched, so the
 * approval it raises can say which rule fetched the human.
 */
export function trippedTrigger(text: string, guardrails: Guardrails): string | null {
  const haystack = text.toLowerCase().replace(/[_\-]+/g, " ");
  for (const trigger of guardrails.humanEscalationTriggers) {
    const needle = trigger.toLowerCase().replace(/[_\-]+/g, " ").trim();
    if (needle && haystack.includes(needle)) return trigger;
  }
  return null;
}
