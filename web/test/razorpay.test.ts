import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { env } from "@/server/env";
import { decrypt, invoiceToken, verifyRazorpaySignature } from "@/server/lib/crypto";
import { setPaymentProvider } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { razorpayProviderFor } from "@/server/payments/razorpay";
import { sell } from "@/server/services/selling";

/**
 * Razorpay, end to end through the route handlers, with Composio replaced
 * by the fake.
 *
 * What is being checked is the shape of a real chat sale: the shop connects
 * its own account; a quote carries a payment link; the link is the same
 * one however many times it is asked for; the customer pays on Razorpay's
 * page and either comes back to the invoice or does not; and in both cases
 * the order is paid, the stock taken and the customer told — once. And the
 * ways that must not go wrong: a delivery with the wrong signature, another
 * workspace's link, a shelf that emptied while the customer was paying.
 */

const AUTH = "ac_test_razorpay";
const KEY_ID = "rzp_test_Ab12Cd34Ef56Gh";
const KEY_SECRET = "razorpay-key-secret-0123456789";
const WEBHOOK_SECRET = "a-secret-the-operator-chose";
const TELEGRAM_ACCOUNT = "ca_razorpay_telegram";

const original = { key: env.COMPOSIO_API_KEY, razorpay: env.COMPOSIO_AUTH_CONFIG_RAZORPAY };

beforeAll(() => {
  env.COMPOSIO_API_KEY = "ck_test";
  env.COMPOSIO_AUTH_CONFIG_RAZORPAY = AUTH;
});

afterAll(() => {
  env.COMPOSIO_API_KEY = original.key;
  env.COMPOSIO_AUTH_CONFIG_RAZORPAY = original.razorpay;
});

let workspaceId: string;
let links = 0;

/** A payment link as Razorpay's API returns one, echoing what was asked for. */
const createdLink = (args: Record<string, unknown>) => {
  links += 1;
  return {
    successful: true, error: null,
    data: {
      id: `plink_${links}`, entity: "payment_link", status: "created", short_url: `https://rzp.io/i/test${links}`,
      amount: args.amount, amount_paid: 0, currency: args.currency, reference_id: args.reference_id,
      expire_by: args.expire_by ?? 0, notes: args.notes, payments: null,
    },
  };
};

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
  // No override: the workspace's own gateway, or the deployment's fallback,
  // is what is under test.
  setPaymentProvider(null);
  links = 0;

  fakeComposio.authConfigs.set(AUTH, "razorpay");
  fakeComposio.execute.respond("RAZORPAY_FETCH_ALL_PAYMENT_LINKS", { successful: true, error: null, data: { entity: "collection", count: 0, items: [] } });
  fakeComposio.execute.respond("RAZORPAY_CREATE_PAYMENT_LINK", ({ arguments: args }) => createdLink(args));

  // A channel to sell on and to confirm back through.
  fakeComposio.accounts.set(TELEGRAM_ACCOUNT, { id: TELEGRAM_ACCOUNT, status: "ACTIVE", statusReason: null, userId: workspaceId, toolkit: "telegram" });
  await prisma.channelConnection.create({
    data: { workspaceId, channel: "telegram", status: "connected", externalId: "bot_1", composioAccountId: TELEGRAM_ACCOUNT, connectedAt: new Date() },
  });
});

afterEach(() => setPaymentProvider(null));

const credentials = { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET };
const connect = (app: Awaited<ReturnType<typeof signedIn>>, body: Record<string, string> = credentials) =>
  app.post("/v1/payments/razorpay/connect").send(body);
const connected = async () => {
  const app = await signedIn();
  await connect(app).expect(201);
  return app;
};
const connection = () =>
  prisma.paymentConnection.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "razorpay" } } });

const variant = () =>
  prisma.variant.findFirstOrThrow({ where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } } });

/** "I want 2 olive L polos" on Telegram, as a customer would send it. */
async function quote(text = "I want 2 olive L polos", handle = "555") {
  const result = await sell({ workspaceId, channel: "telegram", handle, text });
  const number = result.invoice!.number;
  return { result, number, token: invoiceToken(number), orderId: result.order!.id };
}

const executed = (slug: string) => fakeComposio.calls.execute.filter((call) => call.slug === slug);
const sends = () => executed("TELEGRAM_SEND_MESSAGE");
const payments = (number: string) => prisma.payment.findMany({ where: { invoiceNumber: number } });
const link = (number: string) => prisma.paymentLink.findUnique({ where: { invoiceNumber: number } });

const sign = (body: string, secret = WEBHOOK_SECRET) => createHmac("sha256", secret).update(body).digest("hex");

/** `payment_link.paid`, as Razorpay delivers it (trimmed to the fields that matter). */
const paidEvent = (plinkId: string, number: string, amount: number, payment: { id?: string; method?: string } = {}) =>
  JSON.stringify({
    entity: "event", event: "payment_link.paid", contains: ["payment_link", "order", "payment"],
    payload: {
      payment_link: { entity: { id: plinkId, reference_id: number, status: "paid", amount, amount_paid: amount, notes: { invoice: number, workspace: workspaceId } } },
      payment: { entity: { id: payment.id ?? "pay_1", amount, method: payment.method ?? "upi", status: "captured" } },
    },
  });

const deliver = (body: string, options: { secret?: string; to?: string } = {}) =>
  agent()
    .post(`/webhooks/razorpay/${options.to ?? workspaceId}`)
    .set("x-razorpay-signature", sign(body, options.secret))
    .send(body);

const paidLookup = (amount: number, payment: { id?: string; method?: string } = {}) => ({
  successful: true, error: null,
  data: {
    id: "plink_1", status: "paid", amount, amount_paid: amount,
    payments: [{ payment_id: payment.id ?? "pay_9", amount, method: payment.method ?? "upi", status: "captured" }],
  },
});

describe("the signature", () => {
  it("is Razorpay's hex HMAC of the raw body, in either case", () => {
    const body = '{"event":"payment_link.paid"}';
    expect(verifyRazorpaySignature(Buffer.from(body), sign(body), WEBHOOK_SECRET)).toBe(true);
    expect(verifyRazorpaySignature(Buffer.from(body), sign(body).toUpperCase(), WEBHOOK_SECRET)).toBe(true);
    expect(verifyRazorpaySignature(Buffer.from(body), sign(body, "another"), WEBHOOK_SECRET)).toBe(false);
    expect(verifyRazorpaySignature(Buffer.from(body + " "), sign(body), WEBHOOK_SECRET)).toBe(false);
    expect(verifyRazorpaySignature(Buffer.from(body), undefined, WEBHOOK_SECRET)).toBe(false);
  });
});

describe("connecting Razorpay", () => {
  it("lists it, with the webhook URL to paste, before anything is connected", async () => {
    const app = await signedIn();
    const res = await app.get("/v1/payments").expect(200);

    expect(res.body.gateways).toHaveLength(1);
    expect(res.body.gateways[0]).toMatchObject({
      provider: "razorpay", status: "disconnected", available: true, mode: null, keyId: null,
      webhookUrl: `${env.PUBLIC_URL}/webhooks/razorpay/${workspaceId}`,
    });
    expect(res.body.gateways[0].webhookEvents).toContain("payment_link.paid");
  });

  it("hands the key pair to Composio, proves it with a read, and keeps only what it must", async () => {
    const app = await signedIn();
    const res = await connect(app).expect(201);

    expect(res.body.gateway).toMatchObject({ provider: "razorpay", status: "connected", mode: "test", keyId: "rzp_test_Ab12…56Gh" });
    expect(res.body.gateway.displayName).toContain("test mode");
    // Never the secret, never the whole key, never the account id.
    expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(KEY_ID);

    expect(fakeComposio.calls.initiateApiKey).toEqual([
      { userId: workspaceId, authConfigId: AUTH, apiKey: KEY_SECRET, field: "generic_api_key", extra: { generic_id: KEY_ID } },
    ]);
    expect(executed("RAZORPAY_FETCH_ALL_PAYMENT_LINKS")[0]?.arguments).toEqual({ count: 1 });

    const row = await connection();
    expect(row).toMatchObject({ status: "connected", keyId: KEY_ID, composioAuthConfigId: AUTH });
    expect(row?.webhookSecret).not.toBe(WEBHOOK_SECRET);
    expect(decrypt(row!.webhookSecret!)).toBe(WEBHOOK_SECRET);

    const listed = await app.get("/v1/payments").expect(200);
    expect(listed.body.gateways[0]).toMatchObject({ status: "connected", mode: "test" });
  });

  it("refuses a key id that is not Razorpay's before Composio is called", async () => {
    const app = await signedIn();
    const res = await connect(app, { ...credentials, keyId: "sk_live_notrazorpay0000" }).expect(422);

    expect(res.body.details.keyId[0]).toMatch(/Razorpay Key ID/);
    expect(fakeComposio.calls.initiateApiKey).toHaveLength(0);
    expect(await connection()).toBeNull();
  });

  it("does not say connected when the key cannot read anything", async () => {
    fakeComposio.execute.respond("RAZORPAY_FETCH_ALL_PAYMENT_LINKS", { successful: false, error: "Authentication failed", data: {} });
    const app = await signedIn();
    const res = await connect(app).expect(400);

    expect(res.body.error).toContain("Authentication failed");
    expect(await connection()).toMatchObject({ status: "error", lastError: "Authentication failed", connectedAt: null });
    expect(await razorpayProviderFor(workspaceId)).toBeNull();
  });

  it("says why when the deployment has no auth config for it", async () => {
    env.COMPOSIO_AUTH_CONFIG_RAZORPAY = undefined;
    try {
      const app = await signedIn();
      const listed = await app.get("/v1/payments").expect(200);
      expect(listed.body.gateways[0]).toMatchObject({ available: false });
      expect(listed.body.gateways[0].unavailableReason).toContain("COMPOSIO_AUTH_CONFIG_RAZORPAY");

      const res = await connect(app).expect(400);
      expect(res.body.error).toContain("COMPOSIO_AUTH_CONFIG_RAZORPAY");
      expect(fakeComposio.calls.initiateApiKey).toHaveLength(0);
    } finally {
      env.COMPOSIO_AUTH_CONFIG_RAZORPAY = AUTH;
    }
  });

  it("tests the connection with the same read, and marks it when that fails", async () => {
    const app = await connected();
    const ok = await app.post("/v1/payments/razorpay/test").expect(200);
    expect(ok.body).toMatchObject({ ok: true });
    expect(ok.body.displayName).toContain("test mode");

    fakeComposio.execute.respond("RAZORPAY_FETCH_ALL_PAYMENT_LINKS", { successful: false, error: "Key revoked", data: {} });
    const failed = await app.post("/v1/payments/razorpay/test").expect(400);
    expect(failed.body).toMatchObject({ ok: false, error: "Key revoked" });
    expect(await connection()).toMatchObject({ status: "error", lastError: "Key revoked" });
  });

  it("reconnecting retires the previous Composio account first", async () => {
    const app = await connected();
    const first = (await connection())!.composioAccountId!;

    await connect(app, { ...credentials, keyId: "rzp_live_Zz98Yy87Xx76Ww" }).expect(201);

    expect(fakeComposio.calls.deleteAccount).toEqual([first]);
    const row = await connection();
    expect(row?.composioAccountId).not.toBe(first);
    expect(row).toMatchObject({ status: "connected", keyId: "rzp_live_Zz98Yy87Xx76Ww" });
    expect(row?.displayName).toContain("live mode");
  });

  it("disconnects, deletes the Composio account and destroys the secret", async () => {
    const app = await connected();
    const accountId = (await connection())!.composioAccountId!;

    await app.delete("/v1/payments/razorpay").expect(204);

    expect(fakeComposio.calls.deleteAccount).toContain(accountId);
    expect(await connection()).toMatchObject({ status: "disconnected", keyId: null, webhookSecret: null, composioAccountId: null });
    expect(await razorpayProviderFor(workspaceId)).toBeNull();
    // A webhook the operator forgot to remove on Razorpay's side now has
    // nothing to be checked against.
    await deliver(paidEvent("plink_1", "INV-x", 100)).expect(404);
  });
});

describe("a quote, with Razorpay connected", () => {
  it("puts the payment link in the reply, with the invoice page beneath it, and takes no stock", async () => {
    await connected();
    const before = await variant();

    const { result, number } = await quote();

    const [created] = executed("RAZORPAY_CREATE_PAYMENT_LINK");
    expect(created?.connectedAccountId).toBe((await connection())!.composioAccountId);
    expect(created?.arguments).toMatchObject({
      amount: 1196 * 2 * 100,
      currency: "INR",
      reference_id: number,
      callback_url: `${env.PUBLIC_URL}/i/${invoiceToken(number)}/return`,
      callback_method: "get",
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice: number, workspace: workspaceId },
    });
    expect(String(created?.arguments.description)).toContain("Polo Classic");
    // A week past the due date, give or take the clock.
    expect(Number(created?.arguments.expire_by)).toBeGreaterThan(Date.now() / 1000 + 6 * 86_400);

    expect(result.invoice).toMatchObject({ number, payUrl: "https://rzp.io/i/test1" });
    expect(result.reply).toContain(`Pay securely here: https://rzp.io/i/test1\nYour invoice: ${result.invoice!.link}`);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(stored.text).toContain("https://rzp.io/i/test1");

    expect(await link(number)).toMatchObject({ id: "plink_1", provider: "razorpay", reference: number, test: true, closedAt: null });
    expect((await variant()).reserved).toBe(before.reserved);
  });

  it("makes one link per invoice: the Pay button reuses it", async () => {
    await connected();
    const { token } = await quote();

    const res = await agent().post(`/i/${token}/pay`).expect(303);

    expect(res.headers.location).toBe("https://rzp.io/i/test1");
    expect(executed("RAZORPAY_CREATE_PAYMENT_LINK")).toHaveLength(1);
  });

  it("re-issues under a new reference once the old link is closed", async () => {
    await connected();
    const { token, number } = await quote();
    await prisma.paymentLink.update({ where: { invoiceNumber: number }, data: { closedAt: new Date(), closedAs: "expired" } });

    const res = await agent().post(`/i/${token}/pay`).expect(303);

    expect(res.headers.location).toBe("https://rzp.io/i/test2");
    const [, second] = executed("RAZORPAY_CREATE_PAYMENT_LINK");
    expect(second?.arguments.reference_id).toBe(`${number}~2`);
    expect(await link(number)).toMatchObject({ id: "plink_2", reference: `${number}~2`, closedAt: null });
  });

  it("still quotes, with the invoice page to pay from, when Razorpay will not answer", async () => {
    await connected();
    fakeComposio.execute.respond("RAZORPAY_CREATE_PAYMENT_LINK", { successful: false, error: "Razorpay is down", data: {} });

    const { result, number } = await quote();

    expect(result.invoice?.payUrl).toBeNull();
    expect(result.reply).toContain(`Your invoice and payment link: ${result.invoice!.link}`);
    expect(result.reply).not.toContain("rzp.io");
    expect(await link(number)).toBeNull();
    const trail = await prisma.twinEvent.findFirst({ where: { workspaceId, type: "checkout.link_unavailable" } });
    expect(trail?.payload).toContain("Razorpay is down");
  });

  it("is quoted without a Razorpay link when the gateway is not connected", async () => {
    const { result } = await quote();
    expect(result.invoice?.payUrl).toBeNull();
    expect(executed("RAZORPAY_CREATE_PAYMENT_LINK")).toHaveLength(0);
  });
});

describe("the customer comes back from Razorpay", () => {
  it("settles when Razorpay says paid, and shows the page as paid", async () => {
    await connected();
    const before = await variant();
    const { token, number, orderId } = await quote();
    fakeComposio.execute.respond("RAZORPAY_FETCH_A_PAYMENT_LINK", paidLookup(1196 * 2 * 100, { id: "pay_9", method: "upi" }));
    fakeComposio.calls.execute.length = 0;

    const res = await agent().get(`/i/${token}/return?razorpay_payment_id=pay_9&razorpay_payment_link_status=paid`).expect(303);

    expect(res.headers.location).toBe(`/i/${token}`);
    expect(executed("RAZORPAY_FETCH_A_PAYMENT_LINK")[0]?.arguments).toEqual({ plink_id: "plink_1" });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid", blocked: null });
    expect(await payments(number)).toMatchObject([{ method: "upi", reference: "pay_9", loggedBy: "razorpay", amount: 1196 * 2 * 100 }]);
    expect((await variant()).reserved).toBe(before.reserved + 2);
    expect(await link(number)).toMatchObject({ closedAs: "paid" });
    expect(sends()).toHaveLength(1);
    expect(String(sends()[0]!.arguments.text)).toContain("Payment received");
  });

  it("believes the gateway, not the query string", async () => {
    await connected();
    const { token, number, orderId } = await quote();
    fakeComposio.execute.respond("RAZORPAY_FETCH_A_PAYMENT_LINK", { successful: true, error: null, data: { id: "plink_1", status: "created", amount_paid: 0, payments: null } });

    const res = await agent().get(`/i/${token}/return?razorpay_payment_link_status=paid&razorpay_payment_id=pay_forged`).expect(303);

    expect(res.headers.location).toBe(`/i/${token}?error=unpaid`);
    expect(await payments(number)).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Quoted" });
  });

  it("records the gateway's method in the ledger's words", async () => {
    await connected();
    const { token, number } = await quote();
    fakeComposio.execute.respond("RAZORPAY_FETCH_A_PAYMENT_LINK", paidLookup(1196 * 2 * 100, { id: "pay_nb", method: "netbanking" }));

    await agent().get(`/i/${token}/return`).expect(303);

    expect(await payments(number)).toMatchObject([{ method: "bank_transfer", reference: "pay_nb" }]);
  });
});

describe("Razorpay's webhook", () => {
  it("settles a paid link once, however many times it is delivered", async () => {
    await connected();
    const before = await variant();
    const { number, orderId } = await quote();
    const body = paidEvent("plink_1", number, 1196 * 2 * 100, { id: "pay_w1", method: "card" });

    await deliver(body).expect(200);
    await deliver(body).expect(200);

    expect(await payments(number)).toMatchObject([{ method: "card", reference: "pay_w1", loggedBy: "razorpay" }]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid" });
    expect((await variant()).reserved).toBe(before.reserved + 2);
    expect(sends()).toHaveLength(1);
    expect((await connection())?.lastEventAt).toBeInstanceOf(Date);
  });

  it("refuses a delivery that is not signed with this workspace's secret", async () => {
    await connected();
    const { number } = await quote();
    const body = paidEvent("plink_1", number, 1196 * 2 * 100);

    await deliver(body, { secret: "somebody-elses-secret" }).expect(401);
    await agent().post(`/webhooks/razorpay/${workspaceId}`).send(body).expect(401);

    expect(await payments(number)).toHaveLength(0);
  });

  it("is a 404 for a workspace with no Razorpay, and reads nothing", async () => {
    await deliver(paidEvent("plink_1", "INV-none", 100), { to: "ws_nobody" }).expect(404);
    await deliver(paidEvent("plink_1", "INV-none", 100)).expect(404);
  });

  it("acknowledges a link it does not know, and settles nothing", async () => {
    await connected();
    const body = JSON.stringify({
      event: "payment_link.paid",
      payload: { payment_link: { entity: { id: "plink_stranger", status: "paid", amount: 100 } }, payment: { entity: { id: "pay_x", amount: 100, method: "upi" } } },
    });
    await deliver(body).expect(200);
    expect(await prisma.payment.count({ where: { workspaceId } })).toBe(0);
  });

  it("acknowledges an event it does not handle", async () => {
    await connected();
    await deliver(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } })).expect(200);
    await deliver("not json").expect(400);
  });

  it("finds the invoice by the link's notes when the link row was replaced", async () => {
    await connected();
    const { number, orderId } = await quote();
    await prisma.paymentLink.deleteMany({ where: { invoiceNumber: number } });

    await deliver(paidEvent("plink_1", number, 1196 * 2 * 100)).expect(200);

    expect(await payments(number)).toHaveLength(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid" });
  });

  it("records a payment that landed after the shelf emptied, and flags the order for a person", async () => {
    await connected();
    const { number, orderId } = await quote();
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { reserved: v.stock - 1 } });

    await deliver(paidEvent("plink_1", number, 1196 * 2 * 100)).expect(200);

    // The money is real, so the payment is.
    expect(await payments(number)).toHaveLength(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.stage).toBe("Paid");
    expect(order.blocked).toContain("sold out before the payment landed");
    // No unit was taken that was not there.
    expect((await variant()).reserved).toBe(v.stock - 1);
    expect(String(sends()[0]!.arguments.text)).toMatch(/refund/);
  });

  it("closes the link when Razorpay says it expired", async () => {
    await connected();
    const { number } = await quote();
    const body = JSON.stringify({ event: "payment_link.expired", payload: { payment_link: { entity: { id: "plink_1", status: "expired" } } } });

    await deliver(body).expect(200);

    expect(await link(number)).toMatchObject({ closedAs: "expired" });
    expect(await payments(number)).toHaveLength(0);
  });

  it("does not settle another workspace's invoice through this workspace's URL", async () => {
    await connected();
    const { user: other } = await createUser("other@test.local");
    const otherId = (await createWorkspace({ userId: other.id, policy: "nothing" })).id;
    const theirs = await sell({ workspaceId: otherId, channel: "telegram", handle: "777", text: "I want 1 olive L polo" });
    const number = theirs.invoice!.number;

    // Signed with *our* secret, naming *their* invoice: a valid delivery to
    // the wrong door.
    await deliver(paidEvent("plink_theirs", number, 119600)).expect(200);

    expect(await payments(number)).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: theirs.order!.id } })).toMatchObject({ stage: "Quoted" });
  });
});

describe("cancelling an order", () => {
  it("cancels its payment link on Razorpay", async () => {
    const app = await connected();
    const { number, orderId } = await quote();

    await app.post(`/v1/orders/${orderId}/stage`).send({ stage: "Cancelled" }).expect(200);

    expect(executed("RAZORPAY_CANCEL_PAYMENT_LINK")[0]?.arguments).toEqual({ plink_id: "plink_1" });
    expect(await link(number)).toMatchObject({ closedAs: "cancelled" });
  });

  it("cancels the order even when Razorpay will not", async () => {
    const app = await connected();
    const { number, orderId } = await quote();
    fakeComposio.execute.respond("RAZORPAY_CANCEL_PAYMENT_LINK", { successful: false, error: "nope", data: {} });

    await app.post(`/v1/orders/${orderId}/stage`).send({ stage: "Cancelled" }).expect(200);

    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Cancelled" });
    expect(await link(number)).toMatchObject({ closedAt: null });
  });
});
