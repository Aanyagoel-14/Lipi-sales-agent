# `@lipi-ai/sdk-node`

The bespoke agent SDK from PRD §4: define a skill with your own business
maths, give it guardrails, and deploy it across the channels a workspace has
connected.

It lives inside this repository rather than in a separate package registry
because it is the *same runtime* the built-in skills use — `CustomSkill`
produces exactly the `SkillSpec` that `server/agents/registry.ts` holds, and a
custom skill is executed by exactly the boundary in `server/agents/execute.ts`
that a built-in one is. A separate package would mean a second executor, and a
second executor is a second set of checks to get wrong.

```ts
import { LipiAgent, CustomSkill, type ToolContext } from "@lipi-ai/sdk-node";
```

That import line is the PRD's own, and it resolves: `tsconfig.json` and
`vitest.config.mts` both map the package name at `web/sdk/src`.

## What a custom skill gets

A handler receives `(args, ctx)`. `args` has already been validated against the
`parameters` you declared — an argument that does not match never reaches your
code. `ctx` is a `ToolContext`, and it is deliberately narrow:

| | |
| --- | --- |
| `ctx.twinStore.updateOrderDraft(...)` | create or update the draft order this conversation is negotiating |
| `ctx.twinStore.findProduct(name \| sku)` | a catalogue row, with live variant stock |
| `ctx.twinStore.availability(variantId)` | stock, reserved, available |
| `ctx.twinStore.customer()` | the customer twin, or null outside a conversation |
| `ctx.twinStore.pastDueInvoices()` | the credit-risk signal |
| `ctx.record(type, twin, payload)` | append to this execution's audit trail |
| `ctx.guardrails` | the ceilings this agent runs under |
| `ctx.config` | whatever the operator configured this skill with |

You do not get a database client. Tenant scoping, integer money and the
append-only event log are guarantees of the system, not of your good manners.

## Money

**Amounts you write are in major units** — 12.34 means twelve and
thirty-four — because that is what the PRD's own example computes and what a
pricing formula naturally produces. The SDK converts to the integer minor units
everything downstream stores, once, at this boundary, and rounds half away from
zero. Nothing below this line ever sees a float.

The same applies to `guardrails.maxSingleQuoteValue`: `25000` means twenty-five
thousand, not two hundred and fifty.

## Deploying

```ts
await customFabricationAgent.deploy({ workspaceId, channels: ["WHATSAPP", "WEB_SDK"] });
```

`deploy()` registers the agent's custom skills with the running process and
then performs the same validated deployment `POST /v1/agents/builder/deploy`
does — the skills must exist, the channels must be connected, the guardrails
must parse.

## The worked example

`test/sdk.test.ts` is the PRD's own metal-fabrication quoter, with its
arithmetic asserted against actual values at every boundary the PRD names:
each supported material, an unsupported one, quantity at and either side of 50
and 100, the resulting price, the lead time, the Digital Twin mutation and the
guardrail behaviour.
