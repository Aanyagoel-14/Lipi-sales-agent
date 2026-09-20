import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";

/**
 * The two CORS stories, and the line between them.
 *
 * The widget is anonymous and answers `*` to anybody — unchanged, and the
 * last describe block here exists to keep it that way. A key-authenticated
 * browser call is the other story: it is readable cross-origin only from an
 * origin the *resolved* workspace listed, so an operator decides which of
 * their own pages may spend their key.
 */
beforeEach(resetDatabase);
beforeEach(_resetRateLimitsForTests);

const ORIGIN = "https://shop.example.com";

/** A workspace whose key is write-scoped, with `origins` on its allow-list. */
async function workspaceWithOrigins(email: string, origins: string[]) {
  const { user } = await createUser(email);
  const workspace = await createWorkspace({ userId: user.id, name: email });

  const owner = await signedIn(email);
  await owner.patch("/v1/workspaces/current").send({ allowedOrigins: origins }).expect(200);
  const minted = await owner
    .post("/v1/api-keys")
    .send({ name: "Browser", scopes: ["read", "write"] })
    .expect(201);

  return { workspace, secret: minted.body.secret as string };
}

const from = (secret: string, origin?: string) => {
  const client = agent().get("/v1/customers").set("authorization", `Bearer ${secret}`);
  return origin ? client.set("origin", origin) : client;
};

describe("a key-authenticated browser call", () => {
  it("is readable from an origin the workspace listed", async () => {
    const { secret } = await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const res = await from(secret, ORIGIN).expect(200);

    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    // The answer depends on Origin, so a cache that ignored it would serve
    // one tenant's allowance to another's page.
    expect(res.headers.vary).toBe("Origin");
  });

  it("is not readable from an origin the workspace did not list", async () => {
    const { secret } = await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const res = await from(secret, "https://attacker.example").expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is not readable from an origin only another workspace listed", async () => {
    const { secret } = await workspaceWithOrigins("mine@test.local", []);
    await workspaceWithOrigins("theirs@test.local", [ORIGIN]);

    const res = await from(secret, ORIGIN).expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never lets a browser ride the operator's cookie", async () => {
    const { secret } = await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const res = await from(secret, ORIGIN).expect(200);

    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("opens nothing until an operator opens it", async () => {
    // The default is an empty list, so a workspace that never integrates a
    // browser never has an origin that can read its key's responses.
    const { secret } = await workspaceWithOrigins("owner@test.local", []);

    const res = await from(secret, ORIGIN).expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lets the browser read the error too, once the tenant is known", async () => {
    const { secret } = await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const res = await agent()
      .get("/v1/customers/cus_missing")
      .set("authorization", `Bearer ${secret}`)
      .set("origin", ORIGIN)
      .expect(404);

    // A 404 a browser cannot read shows up as an opaque network failure, and
    // the integrator debugs the wrong thing.
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("tells an unauthenticated caller nothing, whatever origin it claims", async () => {
    await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const res = await agent()
      .get("/v1/customers")
      .set("authorization", "Bearer lipi_sk_nope")
      .set("origin", ORIGIN)
      .expect(401);

    // No credential resolved means no workspace whose list this could be.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a same-origin caller without any of this", async () => {
    await workspaceWithOrigins("owner@test.local", [ORIGIN]);
    const a = await signedIn();

    const res = await a.get("/v1/customers").expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("the preflight", () => {
  it("lets the browser ask, whoever is asking", async () => {
    const res = await agent().options("/v1/customers").set("origin", ORIGIN);

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    // A browser strips Authorization from the preflight, so it has to be
    // named here or the request that follows never happens.
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("is not an oracle for who uses Lipi", async () => {
    // An origin nobody has listed gets the same answer as one somebody has.
    // The difference shows up on the real request, where the tenant is known.
    await workspaceWithOrigins("owner@test.local", [ORIGIN]);

    const listed = await agent().options("/v1/customers").set("origin", ORIGIN);
    const unlisted = await agent().options("/v1/customers").set("origin", "https://attacker.example");

    expect(unlisted.status).toBe(listed.status);
    expect(unlisted.headers["access-control-allow-origin"]).toBe("https://attacker.example");
  });

  it("grants an unlisted origin nothing it can actually read", async () => {
    const { secret } = await workspaceWithOrigins("owner@test.local", [ORIGIN]);
    await agent().options("/v1/customers").set("origin", "https://attacker.example");

    const res = await from(secret, "https://attacker.example").expect(200);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a request with no origin at all", async () => {
    const res = await agent().options("/v1/customers");
    expect(res.status).toBe(403);
  });

  it("is answered on a by-id path too", async () => {
    const res = await agent().options("/v1/customers/cus_anything").set("origin", ORIGIN);

    expect(res.status).toBe(204);
  });
});

describe("the allow-list itself", () => {
  beforeEach(async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
  });

  it("refuses a wildcard", async () => {
    const a = await signedIn();
    await a.patch("/v1/workspaces/current").send({ allowedOrigins: ["*"] }).expect(422);
  });

  it("refuses anything that is not bare scheme, host and port", async () => {
    const a = await signedIn();
    for (const bad of ["https://shop.example.com/", "https://shop.example.com/path", "shop.example.com", "ftp://shop.example.com"]) {
      await a.patch("/v1/workspaces/current").send({ allowedOrigins: [bad] }).expect(422);
    }
  });

  it("accepts a port, which is what a local front end runs on", async () => {
    const a = await signedIn();
    await a.patch("/v1/workspaces/current").send({ allowedOrigins: ["http://localhost:5173"] }).expect(200);
  });

  it("closes the workspace again when the list is emptied", async () => {
    const a = await signedIn();
    await a.patch("/v1/workspaces/current").send({ allowedOrigins: [ORIGIN] }).expect(200);
    await a.patch("/v1/workspaces/current").send({ allowedOrigins: [] }).expect(200);

    const workspace = await prisma.workspace.findFirstOrThrow();
    expect(workspace.allowedOrigins).toEqual([]);
  });
});

describe("the widget's own CORS", () => {
  it("still answers any origin, which is what a public widget is for", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });

    const res = await agent()
      .post(`/v1/webchat/${workspace.id}/session`)
      .set("origin", "https://any-site-at-all.example")
      .send({ visitorId: "visitor-cors-1" })
      .expect(201);

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("is not narrowed by a workspace's key allow-list", async () => {
    const { user } = await createUser();
    const workspace = await createWorkspace({ userId: user.id });
    const owner = await signedIn();
    await owner.patch("/v1/workspaces/current").send({ allowedOrigins: [ORIGIN] }).expect(200);

    const res = await agent()
      .post(`/v1/webchat/${workspace.id}/session`)
      .set("origin", "https://somewhere-else.example")
      .send({ visitorId: "visitor-cors-1" })
      .expect(201);

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
