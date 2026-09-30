import { z } from "zod";
import { registerSkill, unregisterSkill } from "@/server/agents/registry";
import { deployAgent } from "@/server/agents/deploy";
import { parseGuardrails, type Guardrails } from "@/server/agents/guardrails";
import type { SkillCategory, SkillResult, SkillSpec, ToolContext as InternalToolContext, TwinStore } from "@/server/agents/types";

/**
 * `@lipi-ai/sdk-node` — the bespoke agent SDK (PRD §4).
 *
 * The one design decision worth stating: a `CustomSkill` produces exactly the
 * `SkillSpec` the built-in skills produce, and is executed by exactly the
 * boundary in `server/agents/execute.ts` that a built-in one is. A custom
 * skill therefore gets the allowed-tool check, the argument schema, the
 * guardrails, the tenant scoping, the transaction and the audit trail for
 * free, and — more importantly — cannot *skip* any of them. A second runtime
 * for third-party skills would be a second set of checks to get wrong, on
 * exactly the code path where getting them wrong matters most.
 *
 * What this module actually is, then, is a translation layer: the PRD's
 * vocabulary (JSON-schema-ish parameters, snake_case draft fields, prices in
 * major units) into the runtime's (Zod, camelCase, integer minor units).
 */

/* -------------------------------------------------------------- money --- */

/**
 * Major units in, integer minor units out.
 *
 * The PRD's example computes `unitPrice` as a float and renders it with
 * `toFixed(2)`, which is what a pricing formula naturally produces. Everything
 * below this line stores integer minor units and never rounds again
 * (invariant 4), so the conversion happens exactly once, here, at the
 * boundary — and it rounds half away from zero rather than to even, because a
 * price ending in half a minor unit should be the same number every time
 * whatever the preceding digit is.
 */
export function toMinorUnits(major: number): number {
  if (!Number.isFinite(major)) throw new Error(`Not a usable amount: ${major}`);
  const scaled = major * 100;
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/* --------------------------------------------------------- parameters --- */

/**
 * The PRD writes parameters as a plain object of JSON-schema-ish declarations
 * (§4.1). They are converted to Zod here so the validation is real: an
 * argument that does not match never reaches a handler, and the failure names
 * the field.
 */
export type ParameterDeclaration =
  | { type: "string"; enum?: readonly string[]; optional?: boolean; description?: string }
  | { type: "number"; min?: number; max?: number; integer?: boolean; optional?: boolean; description?: string }
  | { type: "boolean"; optional?: boolean; description?: string };

export type ParameterMap = Record<string, ParameterDeclaration>;

/** The argument object a `ParameterMap` describes. */
export type ArgsOf<P extends ParameterMap> = {
  [K in keyof P]: P[K] extends { type: "string"; enum: readonly (infer E)[] }
    ? E
    : P[K] extends { type: "string" }
      ? string
      : P[K] extends { type: "number" }
        ? number
        : boolean;
};

function schemaFor(parameters: ParameterMap): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, declaration] of Object.entries(parameters)) {
    let field: z.ZodTypeAny;

    if (declaration.type === "string") {
      field = declaration.enum?.length
        ? z.enum([...declaration.enum] as [string, ...string[]])
        : z.string().min(1);
    } else if (declaration.type === "number") {
      let numeric = declaration.integer ? z.number().int() : z.number();
      if (declaration.min !== undefined) numeric = numeric.min(declaration.min);
      if (declaration.max !== undefined) numeric = numeric.max(declaration.max);
      // A quote computed from a NaN or an Infinity is a number nobody can
      // honour, and `z.number()` accepts both.
      field = numeric.refine(Number.isFinite, { message: "must be a finite number" });
    } else {
      field = z.boolean();
    }

    shape[name] = declaration.optional ? field.optional() : field;
  }

  // Strict: an argument nobody declared is a model improvising, and silently
  // dropping it hides that from whoever is reading the audit trail.
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

/* ------------------------------------------------------- tool context --- */

/**
 * What the PRD's own handler signature reaches for, in the PRD's own spelling.
 *
 * `updateOrderDraft` takes `custom_specs`, `calculated_unit_price` and
 * `estimated_lead_days` because that is what §4.1 writes. The camelCase
 * equivalents are accepted too, so a handler written against this file's types
 * rather than against the PRD's snippet does not have to guess.
 */
export type OrderDraftUpdate = {
  custom_specs?: Record<string, unknown>;
  customSpecs?: Record<string, unknown>;
  /** Major units. Converted to integer minor units here, once. */
  calculated_unit_price?: number;
  calculatedUnitPrice?: number;
  quantity?: number;
  estimated_lead_days?: number;
  estimatedLeadDays?: number;
  productId?: string;
  variantId?: string;
};

export type SdkTwinStore = Omit<TwinStore, "updateOrderDraft"> & {
  updateOrderDraft(draft: OrderDraftUpdate): Promise<{ id: string; unitPrice: number; leadDays: number }>;
};

export type ToolContext = Omit<InternalToolContext, "twinStore" | "tx"> & {
  twinStore: SdkTwinStore;
};

export type SkillHandlerResult = Record<string, unknown> | void;

export type CustomSkillOptions<P extends ParameterMap> = {
  /** The tool name a model calls. Becomes the registry slug. */
  name: string;
  description: string;
  parameters: P;
  handler: (args: ArgsOf<P>, ctx: ToolContext) => Promise<SkillHandlerResult> | SkillHandlerResult;
  /** Defaults to `custom`. */
  category?: SkillCategory;
  /**
   * Whether an execution commits money or stock. Defaults to **true** — a
   * bespoke skill exists to compute a price, and assuming otherwise would let
   * a workspace on `money_only` release quotes unattended because the SDK
   * guessed.
   */
  touchesMoney?: boolean;
  alwaysEscalateOn?: string[];
  label?: string;
};

/**
 * A skill defined outside this codebase.
 *
 * `spec` is the object the registry holds. Everything interesting happens in
 * the wrapper it builds around `handler`: the draft-order translation, the
 * major-to-minor conversion, and the bookkeeping that lets the executor's
 * `maxSingleQuoteValue` check see what the handler actually quoted.
 */
export class CustomSkill<P extends ParameterMap = ParameterMap> {
  readonly name: string;
  readonly spec: SkillSpec<Record<string, unknown>>;

  constructor(private readonly options: CustomSkillOptions<P>) {
    this.name = options.name;
    const parameters = schemaFor(options.parameters);

    this.spec = {
      slug: options.name,
      label: options.label ?? options.name,
      description: options.description,
      category: options.category ?? "custom",
      touchesMoney: options.touchesMoney ?? true,
      alwaysEscalateOn: options.alwaysEscalateOn,
      parameters,
      run: async (args, ctx): Promise<SkillResult> => {
        // The largest amount the handler committed, so the executor can check
        // it against `maxSingleQuoteValue` without the handler having to
        // remember to report it. A skill that quietly wrote a draft worth more
        // than its ceiling is exactly what the ceiling is for.
        let quotedValue: number | undefined;

        const twinStore: SdkTwinStore = {
          ...ctx.twinStore,
          updateOrderDraft: async (draft) => {
            const majorPrice = draft.calculated_unit_price ?? draft.calculatedUnitPrice;
            if (majorPrice === undefined) {
              throw new Error("updateOrderDraft needs calculated_unit_price");
            }
            const quantity = draft.quantity ?? 1;
            const minorPrice = toMinorUnits(majorPrice);

            const written = await ctx.twinStore.updateOrderDraft({
              customSpecs: draft.custom_specs ?? draft.customSpecs,
              calculatedUnitPrice: minorPrice,
              quantity,
              estimatedLeadDays: draft.estimated_lead_days ?? draft.estimatedLeadDays,
              productId: draft.productId,
              variantId: draft.variantId,
            });

            const value = minorPrice * quantity;
            quotedValue = quotedValue === undefined ? value : Math.max(quotedValue, value);

            // Reported back in the units the caller works in, so a handler
            // that logs what it wrote logs the number it computed.
            return { id: written.id, unitPrice: majorPrice, leadDays: written.leadDays };
          },
        };

        const sdkContext = { ...ctx, twinStore } as unknown as ToolContext;
        const returned = (await options.handler(args as ArgsOf<P>, sdkContext)) ?? {};

        return {
          summary: `${options.name} ran`,
          data: returned as Record<string, unknown>,
          ...(quotedValue === undefined ? {} : { quotedValue }),
        };
      },
    };
  }

  /** Makes this skill executable in the running process. */
  register() {
    registerSkill(this.spec);
    return this;
  }

  /** Removes it again. Mostly for tests, which must not leak into each other. */
  unregister() {
    unregisterSkill(this.spec.slug);
  }

  get declaredParameters(): P {
    return this.options.parameters;
  }
}

/* -------------------------------------------------------------- agent --- */

/**
 * A skill an agent can hold, with its parameter types erased.
 *
 * `CustomSkill<P>` is invariant in `P` — the handler takes `ArgsOf<P>` in
 * argument position — so an array of `CustomSkill<ParameterMap>` will not
 * accept a `CustomSkill<{ material: ... }>`, which is every real skill. An
 * agent does not need the parameter types anyway: it registers the skill and
 * names it. This is the part of the surface it actually uses.
 */
export type RegisteredSkill = {
  readonly name: string;
  readonly spec: SkillSpec<Record<string, unknown>>;
  register(): unknown;
  unregister(): void;
};

export type LipiAgentOptions = {
  agentId: string;
  /** Recorded as the agent's description; model routing is a deployment concern. */
  baseModel?: string;
  systemPrompt?: string;
  skills: RegisteredSkill[];
  /**
   * The PRD's own shape (§4.1): `maxSingleQuoteValue` in **major units**, and
   * `escalateIfMaterialUnknown`. Anything `parseGuardrails` accepts works too.
   */
  guardrails?: Record<string, unknown>;
};

/**
 * A bespoke agent, ready to register and deploy.
 *
 * `agentId` in the PRD's example is a human-readable slug
 * (`smb_custom_cnc_quoter`), so it is used as the agent's *name* — which is
 * what deploy upserts on — rather than as a database id.
 */
export class LipiAgent {
  constructor(private readonly options: LipiAgentOptions) {}

  get name() {
    return this.options.agentId;
  }

  get skills() {
    return this.options.skills;
  }

  /** The parsed ceilings, with the PRD's major-unit quote value converted. */
  guardrails(): Guardrails {
    const declared = { ...(this.options.guardrails ?? {}) };
    for (const key of ["maxSingleQuoteValue", "max_single_quote_value"] as const) {
      const value = declared[key];
      if (typeof value === "number") declared[key] = toMinorUnits(value);
    }
    return parseGuardrails(declared);
  }

  /** Makes every skill this agent holds executable in the running process. */
  register() {
    for (const skill of this.options.skills) skill.register();
    return this;
  }

  unregister() {
    for (const skill of this.options.skills) skill.unregister();
  }

  /**
   * Registers the skills and deploys the agent.
   *
   * Goes through the same `deployAgent()` the HTTP endpoint does, so an agent
   * built with the SDK is validated exactly as one built in the browser: the
   * skills must exist, the channels must be connected, the guardrails must
   * parse.
   */
  async deploy(opts: { workspaceId: string; channels: string[]; knowledgeBaseIds?: string[] }) {
    this.register();
    return deployAgent(opts.workspaceId, {
      agent_name: this.options.agentId,
      skills: this.options.skills.map((skill) => skill.name),
      channels: opts.channels,
      knowledge_base_ids: opts.knowledgeBaseIds,
      guardrails: this.guardrails(),
      description: this.options.systemPrompt ?? this.options.baseModel,
    });
  }
}

export type { Guardrails, SkillSpec, TwinStore };
