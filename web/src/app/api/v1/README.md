# `/api/v1` — the PRD's own paths

The PRD writes its three API contracts with an `/api` prefix
(`POST /api/v1/builder/sites/generate`, `POST /api/v1/conversations/ingest`,
`POST /api/v1/agents/builder/deploy`). This repository has always served its
API at `/v1`, and ~70 route modules, the generated OpenAPI document, the
dashboard's own fetch helpers and every existing integrator use that prefix.

Renaming them would be a breaking change to a published API for the sake of a
path segment. Serving both is four lines per endpoint.

So: `/v1/...` stays canonical, and the endpoints the PRD names by path also
answer at `/api/v1/...`. Each alias re-exports the canonical module's handlers
— the same function object, not a copy — so there is exactly one
implementation, one set of checks, and no way for the two paths to drift.

Endpoints reachable at both prefixes:

| PRD path | Canonical |
| --- | --- |
| `POST /api/v1/conversations/ingest` | `/v1/conversations/ingest` |
| `POST /api/v1/agents/builder/deploy` | `/v1/agents/builder/deploy` |
| `POST /api/v1/builder/sites/generate` | `/v1/builder/sites/generate` |
