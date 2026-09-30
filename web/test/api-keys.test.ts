import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests, checkRateLimit } from "@/server/lib/rate-limit";
import { API_KEY_LIMIT, API_KEY_WINDOW_MS, apiKeyRateLimitKey, touchApiKey } from "@/server/lib/api-key";

beforeEach(resetDatabase);
beforeEach(_resetRateLimitsForTests);

/** `after()` is not awaited by the response, so bookkeeping lands just behind it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

type Minted = { id: string; secret: string; prefix: string };

/** Mints a key through the lifecycle endpoint — the only place a secret exists. */
async function issueKey(
  opts: { email?: string; scopes?: string[]; expiresInDays?: number } = {},
): Promise<Minted> {
  const a = await signedIn(opts.email ?? "owner@test.local");
  const res = await a
    .post("/v1/api-keys")
    .send({
      name: "Storefront",
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
      ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {}),
    })
    .expect(201);
  return { id: res.body.key.id, secret: res.body.secret, prefix: res.body.key.prefix };
}

describe("api key authentication", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("lets a valid key reach a /v1 route with no cookie", async () => {
    const { secret } = await issueKey();

    const res = await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);

    expect(res.body.products.length).toBeGreaterThan(0);
  });

  it("refuses a key that was never issued", async () => {
    await agent().get("/v1/products").set("authorization", "Bearer lipi_sk_notarealkey").expect(401);
  });

  it("refuses a revoked key", async () => {
    const { id, secret } = await issueKey();
    const a = await signedIn();
    await a.delete(`/v1/api-keys/${id}`).expect(200);

    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(401);
  });

  it("refuses a key past its expiry", async () => {
    const { id, secret } = await issueKey({ expiresInDays: 30 });
    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);

    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(401);
  });

  // Unknown, revoked and expired all answer the same way: a 401 that told them
  // apart would confirm which secrets had once been real.
  it("says the same thing about an unknown key as about a dead one", async () => {
    const { id, secret } = await issueKey();
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });

    const revoked = await agent().get("/v1/products").set("authorization", `Bearer ${secret}`);
    const unknown = await agent().get("/v1/products").set("authorization", "Bearer lipi_sk_nope");

    expect(revoked.status).toBe(unknown.status);
    expect(revoked.body.error).toBe(unknown.body.error);
  });

  it("ignores an Authorization header that is not a Bearer", async () => {
    await agent().get("/v1/products").set("authorization", "Basic abc123").expect(401);
  });

  it("refuses a request carrying both a cookie and a key", async () => {
    const { secret } = await issueKey();
    const a = await signedIn();

    const res = await a.get("/v1/products").set("authorization", `Bearer ${secret}`).expect(400);
    expect(res.body.error).toMatch(/not both/i);
  });

  // The header names which workspace, never whether. Without a credential it
  // is just a string a stranger typed.
  it("refuses a request that offers only a workspace id", async () => {
    const workspace = await prisma.workspace.findFirstOrThrow();
    await agent().get("/v1/products").set("x-workspace-id", workspace.id).expect(401);
  });

  it("leaves session-authenticated traffic alone", async () => {
    const a = await signedIn();
    await a.get("/v1/products").expect(200);
    await a.post("/v1/twin/knowledge").send({ kind: "faq", title: "Hours", body: "Nine to five" }).expect(201);
  });
});

describe("api key scopes", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("lets a read key read", async () => {
    const { secret } = await issueKey({ scopes: ["read"] });
    await agent().get("/v1/twin/knowledge").set("authorization", `Bearer ${secret}`).expect(200);
  });

  it("refuses a read key on a write", async () => {
    const { secret } = await issueKey({ scopes: ["read"] });

    const res = await agent()
      .post("/v1/twin/knowledge")
      .set("authorization", `Bearer ${secret}`)
      .send({ kind: "faq", title: "Hours", body: "Nine to five" })
      .expect(403);

    expect(res.body.error).toMatch(/write/);
  });

  it("lets a write key write", async () => {
    const { secret } = await issueKey({ scopes: ["write"] });
    await agent()
      .post("/v1/twin/knowledge")
      .set("authorization", `Bearer ${secret}`)
      .send({ kind: "faq", title: "Hours", body: "Nine to five" })
      .expect(201);
  });

  // A key that could POST an order but not GET it back would be a trap.
  it("gives a write key the read scope too", async () => {
    const { id, secret } = await issueKey({ scopes: ["write"] });

    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(key.scopes).toEqual(["read", "write"]);
    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);
  });

  // Every method that is not a read is a write. A scope check that only knew
  // about POST would wave a read key through a deletion.
  it("refuses a read key on a delete", async () => {
    const { secret } = await issueKey({ scopes: ["read"] });
    const a = await signedIn();
    const created = await a
      .post("/v1/twin/knowledge")
      .send({ kind: "faq", title: "Hours", body: "Nine to five" })
      .expect(201);
    const entryId = created.body.entry.id as string;

    await agent()
      .delete(`/v1/twin/knowledge/${entryId}`)
      .set("authorization", `Bearer ${secret}`)
      .expect(403);

    expect(await prisma.knowledgeEntry.count({ where: { id: entryId } })).toBe(1);
  });

  it("refuses a read key on a put", async () => {
    const { secret } = await issueKey({ scopes: ["read"] });
    const variant = await prisma.variant.findFirstOrThrow();

    await agent()
      .put(`/v1/catalogue/products/${variant.productId}/stock`)
      .set("authorization", `Bearer ${secret}`)
      .send({ variantId: variant.id, stock: 3 })
      .expect(403);

    expect((await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } })).stock)
      .toBe(variant.stock);
  });

  it("defaults to read when the caller names no scope", async () => {
    const { id } = await issueKey();
    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(key.scopes).toEqual(["read"]);
  });
});

describe("api key lifecycle", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("stores a hash, never the secret", async () => {
    const { id, secret } = await issueKey();

    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(key.hash).not.toContain(secret);
    expect(key.hash).toHaveLength(64);
    expect(secret.startsWith("lipi_sk_")).toBe(true);
    expect(key.prefix).toBe(secret.slice(0, key.prefix.length));
    expect(secret.length).toBeGreaterThan(key.prefix.length);
  });

  it("shows the secret exactly once", async () => {
    const { secret } = await issueKey();

    const a = await signedIn();
    const res = await a.get("/v1/api-keys").expect(200);

    expect(res.text).not.toContain(secret);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].prefix).toBe(secret.slice(0, res.body.keys[0].prefix.length));
    expect(res.body.keys[0]).not.toHaveProperty("hash");
    expect(res.body.keys[0]).not.toHaveProperty("secret");
  });

  it("keeps a revoked key in the list, marked", async () => {
    const { id } = await issueKey();
    const a = await signedIn();

    await a.delete(`/v1/api-keys/${id}`).expect(200);
    const res = await a.get("/v1/api-keys").expect(200);

    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].revokedIso).not.toBeNull();
  });

  it("records the creation and the revocation as events", async () => {
    const { id } = await issueKey();
    const a = await signedIn();
    await a.delete(`/v1/api-keys/${id}`).expect(200);

    const types = (await prisma.twinEvent.findMany({ orderBy: { id: "asc" } })).map((e) => e.type);
    expect(types).toContain("api_key.created");
    expect(types).toContain("api_key.revoked");
  });

  it("does not revoke the same key twice", async () => {
    const { id } = await issueKey();
    const a = await signedIn();
    await a.delete(`/v1/api-keys/${id}`).expect(200);
    await a.delete(`/v1/api-keys/${id}`).expect(404);
  });

  it("rejects a nameless key", async () => {
    const a = await signedIn();
    await a.post("/v1/api-keys").send({ name: "x" }).expect(422);
  });

  // A leaked key that could mint its successor would outlive its own revocation.
  it("refuses to manage keys with a key", async () => {
    const { secret } = await issueKey();

    await agent().get("/v1/api-keys").set("authorization", `Bearer ${secret}`).expect(403);
    await agent()
      .post("/v1/api-keys")
      .set("authorization", `Bearer ${secret}`)
      .send({ name: "Second" })
      .expect(403);
  });

  it("refuses to revoke a key with a key", async () => {
    const { id, secret } = await issueKey();
    await agent().delete(`/v1/api-keys/${id}`).set("authorization", `Bearer ${secret}`).expect(403);

    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(key.revokedAt).toBeNull();
  });
});

describe("api key last use", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("records a first use behind the response", async () => {
    const { id, secret } = await issueKey();
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();

    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);
    await settle();

    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
  });

  // Answering "when was this last used" in hours costs nothing; answering it in
  // milliseconds would put an UPDATE in front of every read the key makes.
  it("coalesces a second use inside the window", async () => {
    const { id, secret } = await issueKey();
    const marker = new Date(Date.now() - 5_000);
    await prisma.apiKey.update({ where: { id }, data: { lastUsedAt: marker } });

    await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(200);
    await settle();

    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(key.lastUsedAt?.getTime()).toBe(marker.getTime());
  });

  // Nothing to await is what keeps it out of a request's transaction: a caller
  // cannot enlist a call that hands back no promise.
  it("gives the caller nothing to await", async () => {
    const { id } = await issueKey();
    const scheduled = touchApiKey({ id, workspaceId: "ws", scopes: ["read"], lastUsedAt: null });

    expect(scheduled).toBeUndefined();
    await settle();
  });

  // What a request in flight holds is the key as it was when it authenticated.
  // An operator who revokes during that call must not see the row come back to
  // life underneath them.
  it("does not resurrect a key revoked before the write lands", async () => {
    const { id } = await issueKey();
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });

    touchApiKey({ id, workspaceId: "ws", scopes: ["read"], lastUsedAt: null });
    await settle();

    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();
  });
});

describe("api key rate limiting", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("throttles by key rather than by address", async () => {
    const { id, secret } = await issueKey();

    // Spend the key's budget directly: 600 HTTP round-trips would prove the
    // same thing about `checkRateLimit` and nothing extra about the wiring.
    for (let i = 0; i < API_KEY_LIMIT; i++) {
      checkRateLimit(apiKeyRateLimitKey(id), API_KEY_LIMIT, API_KEY_WINDOW_MS);
    }

    const res = await agent().get("/v1/products").set("authorization", `Bearer ${secret}`).expect(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("leaves another key's budget alone", async () => {
    const { id } = await issueKey();
    const a = await signedIn();
    const second = (await a.post("/v1/api-keys").send({ name: "Second" }).expect(201)).body;

    for (let i = 0; i < API_KEY_LIMIT; i++) {
      checkRateLimit(apiKeyRateLimitKey(id), API_KEY_LIMIT, API_KEY_WINDOW_MS);
    }

    await agent()
      .get("/v1/products")
      .set("authorization", `Bearer ${second.secret}`)
      .expect(200);
  });

  it("does not throttle a session", async () => {
    const { id } = await issueKey();
    for (let i = 0; i < API_KEY_LIMIT; i++) {
      checkRateLimit(apiKeyRateLimitKey(id), API_KEY_LIMIT, API_KEY_WINDOW_MS);
    }

    const a = await signedIn();
    await a.get("/v1/products").expect(200);
  });
});
