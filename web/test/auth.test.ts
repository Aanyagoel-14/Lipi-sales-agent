import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { AUTH_EMAIL_LIMIT, AUTH_IP_LIMIT } from "@/server/lib/auth-throttle";
import { prisma } from "@/server/lib/prisma";
import { _resetRateLimitsForTests } from "@/server/lib/rate-limit";

beforeEach(resetDatabase);

describe("signup", () => {
  it("creates an account and signs it in", async () => {
    const res = await agent()
      .post("/v1/auth/signup")
      .send({ name: "Sam", email: "Sam@Example.com", password: "longenough123" })
      .expect(201);

    expect(res.body.user.email).toBe("sam@example.com");
    expect(res.headers["set-cookie"].join()).toContain("lipi_session=");
  });

  it("never stores the password", async () => {
    await agent().post("/v1/auth/signup").send({ name: "Sam", email: "s@e.com", password: "longenough123" }).expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "s@e.com" } });
    expect(user.passwordHash).not.toContain("longenough123");
    expect(user.passwordHash.startsWith("scrypt$")).toBe(true);
  });

  it("rejects a short password", async () => {
    await agent().post("/v1/auth/signup").send({ name: "Sam", email: "s@e.com", password: "short" }).expect(422);
  });

  it("refuses a duplicate email", async () => {
    await createUser("taken@test.local");
    await agent().post("/v1/auth/signup").send({ name: "Someone", email: "taken@test.local", password: "longenough123" }).expect(409);
  });
});

describe("login", () => {
  beforeEach(async () => { await createUser(); });

  it("accepts the right password", async () => {
    await agent().post("/v1/auth/login").send({ email: "owner@test.local", password: "testing12345" }).expect(200);
  });

  it("rejects the wrong password", async () => {
    await agent().post("/v1/auth/login").send({ email: "owner@test.local", password: "wrongpassword" }).expect(401);
  });

  // Different messages for unknown-email and wrong-password would enumerate accounts.
  it("does not reveal whether an email exists", async () => {
    const unknown = await agent().post("/v1/auth/login").send({ email: "nobody@test.local", password: "whatever12345" });
    const wrong = await agent().post("/v1/auth/login").send({ email: "owner@test.local", password: "whatever12345" });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error).toBe(wrong.body.error);
  });
});

describe("session", () => {
  it("gates every read behind a session", async () => {
    for (const path of ["/v1/customers", "/v1/invoices", "/v1/dashboard/overview", "/v1/products"]) {
      await agent().get(path).expect(401);
    }
  });

  it("gates writes too", async () => {
    await agent().post("/v1/messages").send({ channel: "whatsapp", handle: "x", text: "hi" }).expect(401);
  });

  it("revokes on logout", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
    const a = await signedIn();

    await a.get("/v1/customers").expect(200);
    await a.post("/v1/auth/logout").expect(204);
    await a.get("/v1/customers").expect(401);
  });

  it("rejects a session row that has expired", async () => {
    const { user } = await createUser();
    await createWorkspace({ userId: user.id });
    const a = await signedIn();

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await a.get("/v1/customers").expect(401);
  });
});

describe("the password endpoints have a budget", () => {
  // These two were the only unauthenticated write endpoints in the API with no
  // ceiling at all, which made them the cheapest place to guess a password or
  // to learn which addresses have accounts.
  beforeEach(_resetRateLimitsForTests);
  afterEach(_resetRateLimitsForTests);

  it("refuses a caller that has spent the per-address budget", async () => {
    await createUser();

    for (let attempt = 1; attempt <= AUTH_IP_LIMIT; attempt++) {
      await agent()
        .post("/v1/auth/login")
        .set("x-forwarded-for", "203.0.113.7")
        .send({ email: `nobody${attempt}@test.local`, password: "wrong-password" })
        .expect(401);
    }

    const refused = await agent()
      .post("/v1/auth/login")
      .set("x-forwarded-for", "203.0.113.7")
      .send({ email: "owner@test.local", password: "testing12345" })
      .expect(429);

    expect(refused.headers["retry-after"]).toBeDefined();
    expect(refused.body.error).toContain("Too many attempts");
  });

  // An attacker with a thousand addresses defeats the address budget, which is
  // why there is a second one on the account being attacked.
  it("refuses a distributed attempt on one account", async () => {
    await createUser();

    for (let attempt = 1; attempt <= AUTH_EMAIL_LIMIT; attempt++) {
      await agent()
        .post("/v1/auth/login")
        .set("x-forwarded-for", `198.51.100.${attempt}`)
        .send({ email: "owner@test.local", password: "wrong-password" })
        .expect(401);
    }

    await agent()
      .post("/v1/auth/login")
      .set("x-forwarded-for", "198.51.100.200")
      .send({ email: "owner@test.local", password: "testing12345" })
      .expect(429);
  });

  // The refusal must not say which of the two ceilings was hit: a distinct
  // message for the per-email one would confirm that the address has an
  // account, which is the enumeration the login route already guards against.
  it("says the same thing whichever budget refused it", async () => {
    await createUser();

    for (let attempt = 1; attempt <= AUTH_EMAIL_LIMIT; attempt++) {
      await agent()
        .post("/v1/auth/login")
        .set("x-forwarded-for", `192.0.2.${attempt}`)
        .send({ email: "owner@test.local", password: "wrong-password" })
        .expect(401);
    }
    const byEmail = await agent()
      .post("/v1/auth/login")
      .set("x-forwarded-for", "192.0.2.250")
      .send({ email: "owner@test.local", password: "wrong-password" })
      .expect(429);

    for (let attempt = 1; attempt <= AUTH_IP_LIMIT; attempt++) {
      await agent()
        .post("/v1/auth/login")
        .set("x-forwarded-for", "203.0.113.99")
        .send({ email: `spread${attempt}@test.local`, password: "wrong-password" })
        .expect(401);
    }
    const byAddress = await agent()
      .post("/v1/auth/login")
      .set("x-forwarded-for", "203.0.113.99")
      .send({ email: "someone@test.local", password: "wrong-password" })
      .expect(429);

    expect(byEmail.body.error).toBe(byAddress.body.error);
  });

  it("throttles signup too", async () => {
    for (let attempt = 1; attempt <= AUTH_IP_LIMIT; attempt++) {
      await agent()
        .post("/v1/auth/signup")
        .set("x-forwarded-for", "203.0.113.42")
        .send({ email: `new${attempt}@test.local`, name: "New Person", password: "testing12345" })
        .expect(201);
    }

    await agent()
      .post("/v1/auth/signup")
      .set("x-forwarded-for", "203.0.113.42")
      .send({ email: "onemore@test.local", name: "New Person", password: "testing12345" })
      .expect(429);
  });
});
