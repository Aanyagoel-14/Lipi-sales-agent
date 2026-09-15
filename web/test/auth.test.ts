import { beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { prisma } from "@/server/lib/prisma";

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
