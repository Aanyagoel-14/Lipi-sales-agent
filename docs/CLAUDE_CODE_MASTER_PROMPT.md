# MASTER PROMPT — PRD-COMPLETE, TESTED, PRODUCTION-QUALITY IMPLEMENTATION

You are taking this repository from its CURRENT STATE to a COMPLETE, WORKING, VERIFIED implementation of the product described in the PRD.

**Source of truth:** `@docs/PRD.md`

**Your deliverable is working, tested code in this repository — not a plan, checklist, architecture doc, pseudocode, or partial implementation.** Those are intermediate steps only.

The loop you must execute end-to-end is:

ANALYZE → BUILD TRACEABILITY → IMPLEMENT → TEST → DEBUG → INTEGRATE → REGRESSION TEST → E2E TEST → SECURITY REVIEW → PRD AUDIT → FIX → VERIFY → REPORT

---

## 0. CONTEXT HYGIENE, CHECKPOINTING, AND COMPACTION (READ FIRST — APPLIES FOR THE WHOLE SESSION)

This is a long, multi-hour task. Context will fill up. Hallucination risk rises as context bloats. Follow these rules from the very first tool call:

### 0.1 Durable state lives on disk, not in your context
Create and maintain these files from the start of the task. They are your memory. Update them after every milestone, not just at the end:

- `docs/impl/PROGRESS.md` — current phase, what is done, what is in flight, exact next step, last verification commands run and their results.
- `docs/impl/TRACEABILITY.md` — the requirement traceability matrix (see §3).
- `docs/impl/DECISIONS.md` — every non-obvious engineering or product interpretation you made, with the PRD section it derives from.
- `docs/impl/BLOCKERS.md` — anything blocked by external dependencies, exactly what is missing, and what was done instead.

### 0.2 Milestone checkpoint + compaction protocol
A **milestone** = one completed vertical slice or phase (e.g., "discovery complete", "traceability matrix complete", "data models + migrations verified", "agent runtime + skills verified", "Journey A E2E passing").

At every milestone, in this exact order:
1. Run the relevant test suite and confirm green (or record the exact failures).
2. Update `PROGRESS.md`, `TRACEABILITY.md`, `DECISIONS.md`, `BLOCKERS.md`.
3. Commit with a descriptive message (`feat(agent): ... — verified by <test cmd>, N/N passing`). Never force-push or rewrite history. Never use `--no-verify`.
4. Then compact the conversation to declutter the context window: if you can invoke `/compact`, do so now with the instruction "preserve: current phase, next step, open failures, file paths touched"; if you cannot invoke it yourself, end your turn with the single line **`MILESTONE COMPLETE — safe to /compact. Resume with: <exact next step>`** so the user can run `/compact` before you continue. Do this at every milestone — do not wait for auto-compaction to fire at the worst possible moment.

### 0.3 Resume protocol (after any compaction, restart, or `/clear`)
Before doing anything else: read `docs/impl/PROGRESS.md`, `TRACEABILITY.md`, `DECISIONS.md`, `BLOCKERS.md`, then re-read the PRD section relevant to the next step. Trust these files over your summarized memory. Never resume from an assumption about where you were.

### 0.4 Keep the working context lean
- Delegate broad repository exploration, large log reading, and PRD section extraction to subagents; bring back only structured summaries.
- Never `cat` entire large files or dump full test output into the main context. Use `grep`, `head`, `tail -n 60`, `rg`, `wc -l`; pipe long test/build output to a file under `docs/impl/logs/` and read only the failure sections.
- Don't re-read files you already have accurate notes on unless you are about to edit them.

### 0.5 Anti-hallucination rules
- Before referencing any file, symbol, function, route, env var, or package, confirm it exists (`rg`, `ls`, `grep` in `package.json`/`pyproject`). Never invent module or API names.
- Before implementing any requirement, re-open the exact PRD section and quote its line(s) in your notes. Implement what the PRD says, not what you recall it saying.
- Never report a test/build/lint result you did not just observe in tool output. If in doubt, re-run.
- If you notice a contradiction between your memory and the repository, the repository wins — re-inspect.

---

## 1. UNDERSTAND THE REPOSITORY BEFORE CHANGING ANYTHING

Do NOT start writing code yet.

Inspect thoroughly: project structure, frontend, backend, APIs, database, authentication, state management, services, integrations, components, routes, pages, workers, background jobs, configuration, environment variables, testing infrastructure, package managers, build system, deployment configuration, Docker, CI/CD, existing mocks, fixtures, test data, and existing documentation.

For everything you find, classify it as one of: **exists and works / partially exists / stubbed / mocked / hardcoded / broken / disconnected / implemented differently from the PRD / completely missing.**

Do not assume something works because a component or file exists. Trace important functionality end-to-end through the real code:

UI → frontend state → API → backend → service → database/external service → response → UI

Run the existing test suite, build, lint, and typecheck **now** and record the baseline (command + pass/fail counts) in `PROGRESS.md`. This baseline is what regression testing compares against.

Output of this phase: `docs/impl/REPO_MAP.md` (concise: architecture, key modules, entry points, discovered gaps). **Milestone → checkpoint (§0.2).**

---

## 2. READ THE PRD COMPLETELY

Read `@docs/PRD.md` from the first line to the last. Do not stop after the first sections.

Build a complete requirement inventory covering: product requirements, functional requirements, user flows, UI requirements, UX requirements, API requirements, database requirements, Digital Twin requirements, AI/LLM requirements, agent requirements, skills, guardrails, integrations, omnichannel requirements, voice requirements, deployment requirements, security requirements, performance requirements, acceptance criteria, roadmap requirements, and testing requirements implied by the PRD.

Do not silently drop a requirement because it is hard. If it cannot be fully implemented because an external service, credential, API, infrastructure component, or environment is unavailable, record it explicitly in `BLOCKERS.md` and implement the best production-ready abstraction (clean adapter + deterministic test implementation) rather than pretending it works.

---

## 3. REQUIREMENT TRACEABILITY MATRIX

Create `docs/impl/TRACEABILITY.md` before major implementation work. One row per requirement:

| ID | PRD section | Requirement | Existing impl | Missing impl | Files/components | Status | Unit test | Integration test | E2E test | Manual verification | Acceptance criteria | Final verification |

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTING`, `VERIFIED`, `BLOCKED_EXTERNAL_DEPENDENCY`.

Rules:
- Every requirement must end as `VERIFIED` or `BLOCKED_EXTERNAL_DEPENDENCY` (with the blocker documented).
- `VERIFIED` requires evidence: a named test that exercises the behavior and passed, or a recorded direct verification. Code having been written is not evidence.
- Update the matrix continuously, not at the end.

**Milestone → checkpoint (§0.2).**

---

## 4. PRESERVE WORKING FUNCTIONALITY

Keep existing functionality wherever it already satisfies the PRD. Prefer incremental, modular, backwards-compatible changes that reuse existing abstractions and follow project conventions.

Only refactor when the existing architecture fundamentally prevents the PRD from being implemented correctly — then refactor properly rather than layering hacks.

Never introduce: unnecessary rewrites, duplicate implementations, temporary hacks, dead code, fake APIs, fake success responses, hardcoded production behavior, or silently swallowed errors.

---

## 5. IMPLEMENTATION ORDER

Implement in dependency order. Default order:

1. Repository architecture & foundations
2. Database / data models (+ migrations)
3. Authentication / authorization
4. Core backend services
5. API contracts
6. Digital Twin / state layer
7. Agent infrastructure
8. Skills / tools
9. Knowledge / RAG
10. Integrations / connectors
11. Frontend state / API integration
12. Core UI
13. Agent Builder
14. Website Builder
15. Developer SDK
16. Voice / conversation infrastructure
17. Monitoring / audit / telemetry
18. Security / guardrails
19. Performance
20. Full integration
21. E2E validation

Adjust if the repository's architecture demands a different order. Where possible, drive each layer with a **thin vertical slice of a real user journey** (§26) so integration failures surface early instead of at the end.

Each numbered step, once its tests pass, is a **milestone → checkpoint (§0.2).**

---

## 6. NEVER IMPLEMENT ONLY THE UI

Any UI action that claims to deploy an agent, create a website, update a Digital Twin, create an order, calculate a quote, connect a channel, update configuration, trigger an agent, send a message, or create a checkout link must be traced through the real stack and actually perform that operation.

No fake buttons, dashboards, API responses, agent deployments, Digital Twin data, integrations, or success states — unless the PRD explicitly requires a mock/demo mode, in which case it must be clearly labeled as such in code and UI.

---

## 7. CORE PRODUCT: 3-STEP NO-CODE AGENT BUILDER

Verify the complete flow is connected across UI, API, persistence, agent runtime, and deployment state:

- **Step 1:** choose an existing template; create/customize an agent; combine modular skills.
- **Step 2:** upload knowledge; configure training/knowledge sources; brand voice; business rules; discount floors; escalation thresholds.
- **Step 3:** deploy across supported channels; monitor conversations; view telemetry; inspect audit trails; modify behavior.

Templates from the PRD: Customer Support, SDR, Calendar PA, Inbound Reception.
Skills from the PRD: `Calendar_Negotiation`, `Inventory_Lookup`, `Discount_Calculator`, `Stripe_Invoice`, `Lead_Scoring`.

Architect so new skills can be added without rewriting the agent system (registry/plugin pattern, not a switch statement in an agent class).

---

## 8. DIGITAL TWIN SYSTEM

The Digital Twin is a real stateful system, not static JSON shown in the UI.

Entities per PRD: Customer/Lead Twin, Product & Fitment Twin, Order & Supply Twin, Personal PA Twin, Opportunity & ABM Twin.

Implement: entity models, relationships, state transitions, persistence, retrieval, mutation, event handling, business rules, auditability.

Where Neo4j is required by the repository/environment, integrate it properly. Where unavailable locally, provide one clean adapter/interface with a deterministic test implementation — never scatter fake DB logic across the app.

Verify the canonical mutation chain with tests:

Conversation/event → intent extraction → business validation → Digital Twin lookup → action → Digital Twin mutation → audit event → response

---

## 9. AGENT EXECUTION AND SKILLS

Each skill is a modular, testable capability with: clear input schema, validation, execution logic, error handling, authorization/guardrails, observable result, and test coverage.

Maintain clean separation between agent, skill, tool, business logic, data access, external integrations, and guardrails. No god-class agent.

---

## 10. BESPOKE SDK (TypeScript / Python)

Verify the SDK supports: custom agents, custom skills, custom tools, tool parameters, tool execution, `ToolContext`, Digital Twin updates, guardrails, deployment, error handling.

Use the PRD's **custom fabrication pricing example** as a primary test case. Pricing must be deterministic. Test and assert **actual values** (not just "returns an object") for: supported materials, invalid materials, different thicknesses, different cut lengths, different quantities, quantity > 50, quantity ≤ 50, quantity > 100, quantity ≤ 100, resulting price, lead time, Digital Twin mutation, guardrail behavior.

---

## 11. WEBSITE GENERATOR

Implement and verify all three PRD phases: **Phase 1** Intent → structure; **Phase 2** Dynamic Twin binding; **Phase 3** deployment.

Verify: business profile input, goals, generated structure, responsive components, semantic metadata, sitemap, product/service binding, quote formulas, payment integration, review integration, deployment configuration, SSL/domain abstraction, SEO configuration, embedded assistant.

Verify `POST /api/v1/builder/sites/generate`: request schema, required fields, optional fields, invalid input, error responses, successful response, persistence, generated site configuration.

---

## 12. API CONTRACT VALIDATION

For every PRD API: implement the endpoint; validate request and response schemas, authentication, authorization, errors, edge cases; test success and failure paths. Endpoints must perform the intended operation, not just return 200.

Priority endpoints:
- `POST /api/v1/builder/sites/generate`
- `POST /api/v1/conversations/ingest`
- `POST /api/v1/agents/builder/deploy`

---

## 13. OMNICHANNEL ARCHITECTURE

Channels referenced by the PRD: WhatsApp, Telegram, Slack, Phone/VoIP, Instagram DM, LinkedIn, Zoom/Teams, Web SDK.

Determine which are currently implemented. For each supported channel verify: authentication, inbound handling, outbound handling, error handling, retries, idempotency, event normalization, agent routing, Digital Twin updates, audit logs.

Use adapters mapping every channel to one consistent internal message model. Do not duplicate agent logic per channel.

---

## 14. CONVERSATION INTELLIGENCE

Where applicable implement/test: ASR, VAD, turn-taking, interruption handling, entity extraction, PII/PHI detection, redaction, conversation state, transcript persistence.

The PRD specifies that caller speech over a threshold emits an `AUDIO_INTERRUPT` signal — verify this at the appropriate abstraction level with a test.

For ML services that cannot run in CI, create deterministic mocks that simulate realistic provider behavior, and test the real adapter separately when credentials/services are available.

---

## 15. VOICE PIPELINE

Verify the full flow: Audio input → transport → transcription → turn detection → reasoning → tool execution → response → TTS → interruption handling.

Test: normal speech, silence, interruption, rapid interruption, malformed audio, provider failure, timeout, retry, cancellation, concurrent calls.

Do not claim latency targets are met unless actually measured.

---

## 16. USE CASE VALIDATION (PRD ACCEPTANCE TESTS)

Treat the four PRD scenarios as acceptance tests with automated coverage.

**Use Case 1 — Autonomous Conversational Commerce.** Input: *"Need 400 blue XL polo shirts delivered to Nairobi warehouse before Friday. Can we do $8.50/unit?"* Verify: intent extraction; item, color, size, quantity, proposed price, deadline extraction; inventory lookup; price-floor validation; customer credit validation; inventory reservation; checkout generation; order draft; ERP integration abstraction; WhatsApp response; audit trail; all PRD business rules.

**Use Case 2 — Personal Assistant.** Input: *"Find 45 minutes with Dr. Chen next week for budget review, avoid mornings, and maintain 15-min buffers."* Verify: calendar retrieval, availability analysis, timezone handling, morning exclusion, buffer enforcement, negotiation state, confirmation, calendar mutation, audit event.

**Use Case 3 — Regulated Meeting Intelligence.** Verify: audio ingestion, transcription, entity detection, PII/PHI handling, redaction, structured output, legal/medical knowledge retrieval abstraction, auditability. Do not claim HIPAA/SOC2 compliance because code exists; document exactly what is implemented and what requires infrastructure/process validation.

**Use Case 4 — Inbound Phone Reception.** Verify: inbound call → routing → agent → knowledge retrieval → response → appointment booking → confirmation. Test failures and retries.

---

## 17. UI/UX IMPLEMENTATION

Verify against the PRD, including **interactions**, not just appearance:

- **Omnichannel split-pane workspace:** channel sidebar, transcript center, Digital Twin inspector.
- **Agent Studio:** node graph, triggers, guardrails, fallback conditions, human escalation.
- **Instant Web Customizer:** mobile preview, desktop preview, block library, theme tokens, prompt-based modifications.

---

## 18. DESIGN SYSTEM

Apply the PRD's design tokens. Verify colors, typography, spacing, components, responsive behavior, accessibility, and loading/empty/error/disabled/hover/focus states, on desktop and mobile.

Use **Inter** for UI and **JetBrains Mono** for technical values (SKUs, JSON, timestamps).

---

## 19. SECURITY

Review the whole implementation for: authentication bypasses, authorization bugs, IDOR, missing tenant isolation, SQL/NoSQL/command injection, XSS, CSRF, SSRF, path traversal, insecure file uploads, malicious document handling, prompt injection, tool abuse, excessive permissions, secrets in source or logs, unsafe error messages, insecure webhooks, replay attacks, missing signature validation, rate-limit issues.

**Agent tool execution is a hard security boundary.** An LLM-generated tool call must never be able to run a dangerous operation unchecked. Enforce and test: allowed-tool lists, argument schemas, authorization, guardrails, tenant context, audit logging, maximum values, escalation rules.

Record findings and fixes in `docs/impl/SECURITY_REVIEW.md`.

---

## 20. MULTI-TENANCY AND DATA ISOLATION

If multi-tenant, write explicit tests that Tenant A cannot access Tenant B's users, conversations, Digital Twins, documents, agents, credentials, or analytics. Enforce at the data/service layer — never rely on frontend filtering.

---

## 21. ERROR HANDLING

Every major operation needs predictable errors. Test: invalid input, missing input, unauthorized, forbidden, nonexistent resource, provider failure, timeout, database failure, network failure, malformed external response, duplicate request, concurrent request, partial failure.

Errors must be actionable, never expose secrets or production stack traces, preserve correlation/request IDs, and produce useful logs.

---

## 22. OBSERVABILITY

Important operations must have structured logs, request IDs, correlation IDs, agent execution traces, tool execution traces, audit events, integration error logging, and useful metrics. Failures must be diagnosable.

---

## 23. TESTING STRATEGY

Testing is part of implementation, not an afterthought. Use every relevant level.

**Level 1 — Static validation:** type checking, linting, formatting, schema validation, build. Fix all errors. Do not ignore warnings that indicate real defects. Never suppress with `any`, `@ts-ignore`, `# type: ignore`, or lint-disable comments to get green.

**Level 2 — Unit tests:** every important pure function and isolated business rule — pricing, validation, parsers, entity-extraction adapters, state transitions, Digital Twin rules, discount logic, escalation rules, scheduling rules, quote calculations, utilities, permission checks, guardrails. Cover happy path, boundaries, invalid inputs, extreme inputs, null/undefined, exceptions. Meaningful coverage, not inflated numbers.

---

## 24. INTEGRATION TESTING

Test real application boundaries working together: API → service → database; Agent → skill → Digital Twin; Conversation → intent extraction → business logic → response; Website builder → API → generator → persistence; Connector → normalized event → agent → response.

Mock only true external dependencies. Do not mock everything.

---

## 25. REGRESSION TESTING

Before declaring done: run the full pre-existing suite, then all new tests, and compare against the §1 baseline. If an existing test fails because the PRD intentionally changes behavior: update implementation, update test, document why in `DECISIONS.md`. Never delete or `.skip` failing tests, and never weaken assertions to pass.

---

## 26. END-TO-END JOURNEYS (MINIMUM)

- **Journey A:** sign in → create agent → configure → add knowledge → configure guardrails → deploy → receive conversation → agent responds → audit trail appears.
- **Journey B:** generate website → configure business → select features → generate → preview → modify → deploy/configure deployment.
- **Journey C:** inbound customer conversation → intent detection → Digital Twin lookup → business rule → tool call → action → response → audit.
- **Journey D:** PA scheduling → user request → calendar analysis → negotiation → confirmation → calendar update.
- **Journey E:** custom SDK tool → agent invokes tool → validation → business calculation → Digital Twin update → response.

Each green journey is a **milestone → checkpoint (§0.2).**

---

## 27. EDGE CASES

Test: empty values, extremely long messages, Unicode, emojis, malformed JSON, missing fields, duplicate events, retries, concurrent requests, stale state, conflicting updates, network timeout, external API failure, rate limiting, invalid authentication, expired credentials, invalid tool arguments, unknown skills, unavailable inventory, insufficient permissions, business-rule violations.

---

## 28. PERFORMANCE VALIDATION

Measure what can be measured locally: API latency, DB query latency, UI response time, agent execution time, tool execution overhead, generation time, build time, page load time. Record commands and numbers in `docs/impl/PERFORMANCE.md`.

Label every figure as `MEASURED LOCALLY` or `REQUIRES PRODUCTION INFRASTRUCTURE VALIDATION`. **Never fabricate a benchmark.**

---

## 29. EXTERNAL SERVICES

For WhatsApp, Telegram, Slack, Twilio, Stripe, Google Calendar, Neo4j, Pinecone, Cloudflare, Vercel, LLM providers, etc.: determine which are actually configured. Read credentials from environment variables only; never hardcode. If credentials are unavailable: implement the integration cleanly, create deterministic integration mocks, test the adapter and its error behavior, and document in `BLOCKERS.md` what requires live credentials. Never present a mocked integration as live.

---

## 30. DATABASE MIGRATIONS

All schema changes ship as migrations. Test: fresh database, migration from existing database, seed data, rollback where supported, constraints, indexes, relationships.

---

## 31. API BACKWARDS COMPATIBILITY

Before changing an existing API, inspect current consumers, tests, frontend calls, and any external callers represented in the repo. If the PRD requires a breaking change, update all consumers and tests and record it in `DECISIONS.md`.

---

## 32. NO FAKE COMPLETION

Never say "implemented", "looks good", "everything works", "should work", "probably works", "appears complete", or "looks correct" when verification is possible and you have not done it.

Provide concrete evidence instead: the exact command, number of tests, passed, failed, build status, lint status, typecheck status, E2E status, known limitations — copied from actual tool output you just observed.

---

## 33. AUTOMATIC FIX LOOP

On any failure: (1) read the failure carefully; (2) identify the root cause; (3) fix the root cause, not the symptom; (4) re-run the failed test; (5) re-run related tests; (6) re-run the full relevant suite; (7) check for regression. Repeat until green or a genuine external dependency blocks completion (then document in `BLOCKERS.md`).

If you have attempted the same fix three times without progress, stop, write down what you know in `PROGRESS.md`, and take a different approach — do not thrash.

---

## 34. DO NOT STOP AFTER FIRST SUCCESS

"Implement → one test passes → done" is a failure mode. After implementation, all of the following are required where applicable: unit tests, integration tests, regression tests, E2E tests, static checks, security review, PRD traceability review, final build, final smoke test.

---

## 35. FINAL PRD AUDIT

Re-read the entire PRD. For every requirement answer, and record in `TRACEABILITY.md`: Where is it implemented (file/module)? How is it tested (which test)? Does that test actually exercise the behavior? Is it fully satisfied? Is anything missing?

Pay particular attention to API contracts, numerical thresholds, latency requirements, guardrails, state transitions, Digital Twin behavior, channel integrations, acceptance criteria, deployment requirements.

---

## 36. ACCEPTANCE CRITERIA

Verify each measurable PRD criterion individually — e.g., website generation timing, agent deployment timing, WER target, auto-resolution target, intent F1 target, voice turn-taking latency, custom tool overhead, security/compliance readiness.

Each is marked exactly one of: `VERIFIED` (with the measurement), `NOT VERIFIED`, `REQUIRES PRODUCTION VALIDATION`, `BLOCKED BY EXTERNAL DEPENDENCY`. Never claim a metric you did not measure.

---

## 37. CODE QUALITY

Before finishing, review for: duplication, dead code, unnecessary complexity, giant functions/components, circular dependencies, poor naming, hidden side effects, missing error handling, unsafe type assertions, unvalidated inputs, hardcoded configuration, debug statements, TODOs that should have been completed. Refactor where appropriate. Another engineer must be able to understand it.

---

## 38. DOCUMENTATION

Update docs for: setup, environment variables, database setup, migrations, local development, testing, external integrations, deployment, architecture, important assumptions, limitations, known external dependencies. Never document functionality that is not actually verified.

---

## 39. FINAL VERIFICATION COMMANDS

Inspect `package.json`, `pyproject.toml`, Makefiles, CI config, or equivalents to determine the **actual** commands for this repository — do not assume `npm test` / `npm run build`. Run install/dependency validation, lint, typecheck, unit, integration, E2E, build, and smoke tests **from a clean state** after all changes.

---

## 40. FINAL DELIVERABLE — `docs/impl/FINAL_REPORT.md`

Concise and evidence-based:

- **A. Implementation Summary** — what was implemented.
- **B. PRD Coverage** — requirements total / implemented / verified / blocked.
- **C. Tests** — unit, integration, regression, E2E, lint, typecheck, build: command, result, pass/fail counts.
- **D. Important Files Changed** — and why.
- **E. External Dependencies** — API credentials, production infra, third-party config, manual setup required.
- **F. Remaining Limitations** — genuine ones only; hide nothing.
- **G. Acceptance Criteria** — each marked `VERIFIED` / `NOT VERIFIED` / `REQUIRES PRODUCTION VALIDATION` / `BLOCKED BY EXTERNAL DEPENDENCY`.

---

## 41. CRITICAL OPERATING RULES (ALWAYS IN FORCE)

1. Do not rush. 2. Do not code before understanding the repository. 3. Do not assume existing code works. 4. Do not assume the PRD is implemented because UI exists. 5. No fake success states. 6. Do not silently skip hard requirements. 7. Do not delete tests because they fail. 8. Do not weaken tests to pass. 9. Do not hardcode secrets. 10. Do not fabricate performance numbers. 11. Do not fabricate integration results. 12. Do not claim compliance certifications. 13. No TODOs left for core PRD functionality. 14. Fix root causes, not symptoms. 15. Test every important business rule. 16. Test success and failure paths. 17. Test edge cases. 18. Test integration boundaries. 19. Regression test. 20. E2E test. 21. Re-read the PRD before declaring completion. 22. Verify every requirement. 23. Preserve working functionality unless the PRD requires change. 24. Maintainable architecture over quick hacks. 25. If blocked, investigate alternatives before declaring a blocker. 26. Never claim completion without evidence. 27. Checkpoint to disk and compact at every milestone (§0.2). 28. After any compaction, run the resume protocol (§0.3) before touching code.

---

## 42. WORK AUTONOMOUSLY

Do not ask "Should I implement / fix / add tests / continue?" — you have the PRD and these instructions. Make reasonable engineering decisions and log them in `DECISIONS.md`.

Stop and ask only when: a genuinely ambiguous product decision cannot be resolved from the PRD or code; an irreversible destructive action is required (e.g., dropping data, deleting branches, history rewrites); credentials/secrets are required and unavailable; an external service needs the user's authorization; or two requirements directly conflict with no technically safe interpretation. When you do ask, batch all open questions into one message and continue with everything that is not blocked.

---

## 43. DEFINITION OF DONE

Done only when: the repository builds; typecheck passes; lint passes; unit, integration, regression, and (where applicable) E2E tests pass; all major user journeys work; all major PRD requirements are implemented; traceability is complete; critical security issues are addressed; no core functionality is knowingly fake; external dependencies are documented; every measurable acceptance criterion is verified or explicitly marked as requiring production validation; the implementation is coherent and maintainable; and one final clean verification run has been executed from the repository state as it exists after all changes.

---

## START NOW

1. Create `docs/impl/` with `PROGRESS.md`, `TRACEABILITY.md`, `DECISIONS.md`, `BLOCKERS.md`.
2. Inspect the repository (§1) and record the test/build/lint/typecheck baseline.
3. Read `@docs/PRD.md` completely (§2).
4. Build the traceability matrix (§3).
5. **Checkpoint and compact (§0.2).**
6. Then execute §5 onward, checkpointing and compacting at every milestone, until §43 is satisfied and `FINAL_REPORT.md` is written.

Do not modify application code until steps 1–4 are complete.
