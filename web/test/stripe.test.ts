import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { env } from "@/server/env";
import { invoiceToken } from "@/server/lib/crypto";
import { setPaymentProvider } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { stripeProviderFor, TRIGGERS } from "@/server/payments/stripe";
import { sell } from "@/server/services/selling";

/**
 * Stripe, end to end through the route handlers, with Composio replaced by
 * the fake.
 *
 * What is being checked is the shape of a real chat sale: the shop connects
 * its own account with one key; a quote carries a payment link; the link is
 * the same one however many times it is asked for; the customer pays on
 * Stripe's page and either comes back to the invoice or does not; and in
 * both cases the order is paid, the stock taken and the customer told —
 * once. And the ways that must not go wrong: a delivery for another
 * workspace's link, a shelf that emptied while the customer was paying, a
 * key that Stripe refuses.
 */

const AUTH = "ac_test_stripe";
const SECRET_KEY = "sk_test_51Abc123Def456Ghi789";
const TELEGRAM_ACCOUNT = "ca_stripe_telegram";

const original = { key: env.COMPOSIO_API_KEY, stripe: env.COMPOSIO_AUTH_CONFIG_STRIPE };

beforeAll(() => {
  env.COMPOSIO_API_KEY = "ck_test";
  env.COMPOSIO_AUTH_CONFIG_STRIPE = AUTH;
});

afterAll(() => {
  env.COMPOSIO_API_KEY = original.key;
  env.COMPOSIO_AUTH_CONFIG_STRIPE = original.stripe;
});

let workspaceId: string;
let links = 0;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
  // No override: the workspace's own gateway, or the deployment's fallback,
  // is what is under test.
  setPaymentProvider(null);
  links = 0;

  fakeComposio.authConfigs.set(AUTH, "stripe");
  fakeComposio.execute.respond("STRIPE_RETRIEVE_BALANCE", { successful: true, error: null, data: { object: "balance", livemode: false, available: [] } });
  fakeComposio.execute.respond("STRIPE_CREATE_PRICE", ({ arguments: args }) => ({
    successful: true, error: null,
    data: { id: `price_${links + 1}`, object: "price", unit_amount: args.unit_amount, currency: args.currency },
  }));
  fakeComposio.proxy.respond("/v1/account", { status: 200, data: { id: "acct_1Acme", object: "account", business_profile: { name: "Acme Apparel" } } });
  fakeComposio.proxy.respond("/v1/payment_links", ({ query }) => {
    links += 1;
    return {
      status: 200,
      data: {
        id: `plink_${links}`, object: "payment_link", active: true, url: `https://buy.stripe.com/test_${links}`,
        livemode: false, metadata: { invoice: query?.["metadata[invoice]"], workspace: query?.["metadata[workspace]"], reference: query?.["metadata[reference]"] },
      },
    };
  });

  // A channel to sell on and to confirm back through.
  fakeComposio.accounts.set(TELEGRAM_ACCOUNT, { id: TELEGRAM_ACCOUNT, status: "ACTIVE", statusReason: null, userId: workspaceId, toolkit: "telegram" });
  await prisma.channelConnection.create({
    data: { workspaceId, channel: "telegram", status: "connected", externalId: "bot_1", composioAccountId: TELEGRAM_ACCOUNT, connectedAt: new Date() },
  });
});

afterEach(() => setPaymentProvider(null));

const connect = (app: Awaited<ReturnType<typeof signedIn>>, body: Record<string, string> = { secretKey: SECRET_KEY }) =>
  app.post("/v1/payments/stripe/connect").send(body);
/** The Composio account the last `connected()` made: what a trigger delivery is routed by. */
let accountId = "";
const connected = async () => {
  const app = await signedIn();
  await connect(app).expect(201);
  accountId = (await connection())!.composioAccountId!;
  return app;
};
const connection = () =>
  prisma.paymentConnection.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "stripe" } } });

const variant = () =>
  prisma.variant.findFirstOrThrow({ where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } } });

/** "I want 2 olive L polos" on Telegram, as a customer would send it. */
async function quote(text = "I want 2 olive L polos", handle = "555") {
  const result = await sell({ workspaceId, channel: "telegram", handle, text });
  const number = result.invoice!.number;
  return { result, number, token: invoiceToken(number), orderId: result.order!.id };
}

const executed = (slug: string) => fakeComposio.calls.execute.filter((call) => call.slug === slug);
const proxied = (endpoint: string, method?: string) =>
  fakeComposio.calls.proxy.filter((call) => call.endpoint === endpoint && (!method || call.method === method));
const sends = () => executed("TELEGRAM_SEND_MESSAGE");
const payments = (number: string) => prisma.payment.findMany({ where: { invoiceNumber: number } });
const link = (number: string) => prisma.paymentLink.findUnique({ where: { invoiceNumber: number } });

const AMOUNT = 1196 * 2 * 100;

/** A Checkout Session as Stripe's event carries it on `data.object`. */
const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_test_1", object: "checkout.session", payment_link: "plink_1", payment_status: "paid",
  payment_intent: "pi_1", amount_total: AMOUNT, currency: "inr", livemode: false,
  payment_method_types: ["card"], metadata: {}, ...over,
});

/** A trigger delivery for the connected Stripe account, signed by Composio. */
const delivery = (object: Record<string, unknown>, options: { slug?: string; account?: string; webhookId?: string } = {}) =>
  fakeComposio.sign({
    type: "composio.trigger.message",
    metadata: { connected_account_id: options.account ?? "", trigger_slug: options.slug ?? TRIGGERS[0] },
    data: { account: null, livemode: false, data: { object } },
  }, { webhookId: options.webhookId });

const deliver = (object: Record<string, unknown>, options: { slug?: string; account?: string; webhookId?: string } = {}) => {
  const signed = delivery(object, { ...options, account: options.account ?? accountId });
  const request = agent().post("/webhooks/composio").send(signed.body);
  for (const [key, value] of Object.entries(signed.headers)) request.set(key, value);
  return request;
};

describe("connecting Stripe", () => {
  it("lists it before anything is connected", async () => {
    const app = await signedIn();
    const res = await app.get("/v1/payments").expect(200);

    expect(res.body.gateways).toHaveLength(1);
    expect(res.body.gateways[0]).toMatchObject({ provider: "stripe", label: "Stripe", status: "disconnected", available: true, mode: null });
  });

  it("hands the key to Composio, proves it with a read, and switches the payment triggers on", async () => {
    const app = await signedIn();
    const res = await connect(app).expect(201);

    expect(res.body.gateway).toMatchObject({
      provider: "stripe", status: "connected", mode: "test", accountId: "acct_1Acme", displayName: "Acme Apparel, test mode",
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);

    expect(fakeComposio.calls.initiateApiKey).toEqual([
      { userId: workspaceId, authConfigId: AUTH, apiKey: SECRET_KEY, field: "generic_api_key" },
    ]);
    expect(executed("STRIPE_RETRIEVE_BALANCE")).toHaveLength(1);
    expect(fakeComposio.calls.upsertTrigger.map((t) => t.slug)).toEqual([...TRIGGERS]);
    expect(fakeComposio.calls.upsertTrigger.every((t) => t.userId === workspaceId)).toBe(true);

    const row = await connection();
    expect(row).toMatchObject({ status: "connected", mode: "test", accountId: "acct_1Acme", composioAuthConfigId: AUTH });
    expect(row?.composioTriggerIds).toHaveLength(2);
  });

  it("believes Stripe about the mode, not the prefix", async () => {
    fakeComposio.execute.respond("STRIPE_RETRIEVE_BALANCE", { successful: true, error: null, data: { object: "balance", livemode: true } });
    const app = await signedIn();
    const res = await connect(app).expect(201);
    expect(res.body.gateway).toMatchObject({ mode: "live" });
    expect(res.body.gateway.displayName).toContain("live mode");
  });

  it("refuses a key that is not Stripe's before Composio is called", async () => {
    const app = await signedIn();
    const res = await connect(app, { secretKey: "pk_test_51NotASecretKey000" }).expect(422);

    expect(res.body.details.secretKey[0]).toMatch(/Stripe secret key/);
    expect(fakeComposio.calls.initiateApiKey).toHaveLength(0);
    expect(await connection()).toBeNull();
  });

  it("does not say connected when the key cannot read anything", async () => {
    fakeComposio.execute.respond("STRIPE_RETRIEVE_BALANCE", { successful: false, error: "Invalid API Key provided", data: {} });
    const app = await signedIn();
    const res = await connect(app).expect(400);

    expect(res.body.error).toContain("Invalid API Key");
    expect(await connection()).toMatchObject({ status: "error", lastError: "Invalid API Key provided", connectedAt: null });
    expect(fakeComposio.calls.upsertTrigger).toHaveLength(0);
    expect(await stripeProviderFor(workspaceId)).toBeNull();
  });

  it("is still connected without a name when the account call fails", async () => {
    fakeComposio.proxy.respond("/v1/account", { status: 403, data: { error: { message: "restricted key" } } });
    const app = await signedIn();
    const res = await connect(app).expect(201);
    expect(res.body.gateway).toMatchObject({ status: "connected", accountId: null, displayName: "Stripe account, test mode" });
  });

  it("says why when the deployment has no auth config for it", async () => {
    env.COMPOSIO_AUTH_CONFIG_STRIPE = undefined;
    try {
      const app = await signedIn();
      const listed = await app.get("/v1/payments").expect(200);
      expect(listed.body.gateways[0]).toMatchObject({ available: false });
      expect(listed.body.gateways[0].unavailableReason).toContain("COMPOSIO_AUTH_CONFIG_STRIPE");

      const res = await connect(app).expect(400);
      expect(res.body.error).toContain("COMPOSIO_AUTH_CONFIG_STRIPE");
      expect(fakeComposio.calls.initiateApiKey).toHaveLength(0);
    } finally {
      env.COMPOSIO_AUTH_CONFIG_STRIPE = AUTH;
    }
  });

  it("tests the connection with the same read, and marks it when that fails", async () => {
    const app = await connected();
    const ok = await app.post("/v1/payments/stripe/test").expect(200);
    expect(ok.body).toMatchObject({ ok: true, displayName: "Acme Apparel, test mode" });

    fakeComposio.execute.respond("STRIPE_RETRIEVE_BALANCE", { successful: false, error: "Key revoked", data: {} });
    const failed = await app.post("/v1/payments/stripe/test").expect(400);
    expect(failed.body).toMatchObject({ ok: false, error: "Key revoked" });
    expect(await connection()).toMatchObject({ status: "error", lastError: "Key revoked" });
  });

  it("reconnecting retires the previous account and its triggers first", async () => {
    const app = await connected();
    const before = (await connection())!;

    await connect(app, { secretKey: "sk_live_51Zz987Yy654Xx321" }).expect(201);

    expect(fakeComposio.calls.deleteTrigger).toEqual(before.composioTriggerIds);
    expect(fakeComposio.calls.deleteAccount).toEqual([before.composioAccountId]);
    const row = await connection();
    expect(row?.composioAccountId).not.toBe(before.composioAccountId);
    expect(row?.composioTriggerIds).not.toEqual(before.composioTriggerIds);
    expect(row).toMatchObject({ status: "connected" });
  });

  it("disconnects, and takes the triggers and the Composio account down with it", async () => {
    const app = await connected();
    const row = (await connection())!;

    await app.delete("/v1/payments/stripe").expect(204);

    expect(fakeComposio.calls.deleteTrigger).toEqual(row.composioTriggerIds);
    expect(fakeComposio.calls.deleteAccount).toContain(row.composioAccountId);
    expect(await connection()).toMatchObject({ status: "disconnected", mode: null, accountId: null, composioAccountId: null, composioTriggerIds: [] });
    expect(await stripeProviderFor(workspaceId)).toBeNull();
  });

  it("needs reconnecting when Composio says the account expired or a trigger went down", async () => {
    await connected();
    const row = (await connection())!;
    const expired = fakeComposio.sign({
      type: "composio.connected_account.expired",
      data: { id: row.composioAccountId, status: "EXPIRED", status_reason: "The key was revoked" },
    });
    const request = agent().post("/webhooks/composio").send(expired.body);
    for (const [key, value] of Object.entries(expired.headers)) request.set(key, value);
    await request.expect(200);

    expect(await connection()).toMatchObject({ status: "needs_reconnect", lastError: "The key was revoked" });
    expect(await prisma.twinEvent.count({ where: { workspaceId, type: "payments.expired" } })).toBe(1);
    expect(await stripeProviderFor(workspaceId)).toBeNull();
  });
});

describe("a quote, with Stripe connected", () => {
  it("puts the payment link in the reply, with the invoice page beneath it, and takes no stock", async () => {
    await connected();
    const before = await variant();

    const { result, number } = await quote();

    const [priced] = executed("STRIPE_CREATE_PRICE");
    expect(priced?.arguments).toMatchObject({ currency: "inr", unit_amount: AMOUNT, metadata: { invoice: number, workspace: workspaceId } });
    expect(String((priced?.arguments.product_data as { name: string }).name)).toContain("Polo Classic");

    const [created] = proxied("/v1/payment_links", "POST");
    expect(created?.connectedAccountId).toBe((await connection())!.composioAccountId);
    expect(created?.query).toMatchObject({
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": 1,
      "after_completion[type]": "redirect",
      "after_completion[redirect][url]": `${env.PUBLIC_URL}/i/${invoiceToken(number)}/return?session_id={CHECKOUT_SESSION_ID}`,
      "restrictions[completed_sessions][limit]": 1,
      "metadata[invoice]": number,
      "metadata[workspace]": workspaceId,
    });
    expect(created?.body).toBeUndefined();

    expect(result.invoice).toMatchObject({ number, payUrl: "https://buy.stripe.com/test_1" });
    expect(result.reply).toContain(`Pay securely here: https://buy.stripe.com/test_1\nYour invoice: ${result.invoice!.link}`);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: result.replyMessageId } });
    expect(stored.text).toContain("https://buy.stripe.com/test_1");

    expect(await link(number)).toMatchObject({ id: "plink_1", provider: "stripe", reference: number, test: true, closedAt: null });
    expect((await variant()).reserved).toBe(before.reserved);
  });

  it("makes one link per invoice: the Pay button reuses it", async () => {
    await connected();
    const { token } = await quote();

    const res = await agent().post(`/i/${token}/pay`).expect(303);

    expect(res.headers.location).toBe("https://buy.stripe.com/test_1");
    expect(proxied("/v1/payment_links", "POST")).toHaveLength(1);
  });

  it("re-issues under a new reference once the old link is closed", async () => {
    await connected();
    const { token, number } = await quote();
    await prisma.paymentLink.update({ where: { invoiceNumber: number }, data: { closedAt: new Date(), closedAs: "cancelled" } });

    const res = await agent().post(`/i/${token}/pay`).expect(303);

    expect(res.headers.location).toBe("https://buy.stripe.com/test_2");
    const [, second] = proxied("/v1/payment_links", "POST");
    expect(second?.query?.["metadata[reference]"]).toBe(`${number}~2`);
    expect(await link(number)).toMatchObject({ id: "plink_2", reference: `${number}~2`, closedAt: null });
  });

  it("still quotes, with the invoice page to pay from, when Stripe will not answer", async () => {
    await connected();
    fakeComposio.proxy.respond("/v1/payment_links", { status: 500, data: { error: { message: "Stripe is down" } } });

    const { result, number } = await quote();

    expect(result.invoice?.payUrl).toBeNull();
    expect(result.reply).toContain(`Your invoice and payment link: ${result.invoice!.link}`);
    expect(result.reply).not.toContain("buy.stripe.com");
    expect(await link(number)).toBeNull();
    const trail = await prisma.twinEvent.findFirst({ where: { workspaceId, type: "checkout.link_unavailable" } });
    expect(trail?.payload).toContain("Stripe is down");
  });

  it("is quoted without a Stripe link when the gateway is not connected", async () => {
    const { result } = await quote();
    expect(result.invoice?.payUrl).toBeNull();
    expect(proxied("/v1/payment_links", "POST")).toHaveLength(0);
  });
});

describe("the customer comes back from Stripe", () => {
  it("settles when Stripe says the session is paid, and shows the page as paid", async () => {
    await connected();
    const before = await variant();
    const { token, number, orderId } = await quote();
    fakeComposio.proxy.respond("/v1/checkout/sessions/cs_test_1", { status: 200, data: session({ payment_intent: "pi_9", payment_method_types: ["upi"] }) });
    fakeComposio.calls.execute.length = 0;

    const res = await agent().get(`/i/${token}/return?session_id=cs_test_1`).expect(303);

    expect(res.headers.location).toBe(`/i/${token}`);
    expect(proxied("/v1/checkout/sessions/cs_test_1", "GET")).toHaveLength(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid", blocked: null });
    expect(await payments(number)).toMatchObject([{ method: "upi", reference: "pi_9", loggedBy: "stripe", amount: AMOUNT }]);
    expect((await variant()).reserved).toBe(before.reserved + 2);
    expect(await link(number)).toMatchObject({ closedAs: "paid" });
    expect(sends()).toHaveLength(1);
    expect(String(sends()[0]!.arguments.text)).toContain("Payment received");
  });

  it("believes the gateway, not the query string", async () => {
    await connected();
    const { token, number, orderId } = await quote();
    fakeComposio.proxy.respond("/v1/checkout/sessions/cs_test_1", { status: 200, data: session({ payment_status: "unpaid", payment_intent: null }) });

    const res = await agent().get(`/i/${token}/return?session_id=cs_test_1`).expect(303);

    expect(res.headers.location).toBe(`/i/${token}?error=unpaid`);
    expect(await payments(number)).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Quoted" });
  });

  it("ignores a session that was opened from somebody else's link", async () => {
    await connected();
    const { token, number } = await quote();
    fakeComposio.proxy.respond("/v1/checkout/sessions/cs_test_other", { status: 200, data: session({ id: "cs_test_other", payment_link: "plink_someone_else" }) });

    const res = await agent().get(`/i/${token}/return?session_id=cs_test_other`).expect(303);

    expect(res.headers.location).toBe(`/i/${token}?error=unpaid`);
    expect(await payments(number)).toHaveLength(0);
  });

  it("asks about the link's sessions when the customer came back without one", async () => {
    await connected();
    const { token, number } = await quote();
    fakeComposio.proxy.respond("/v1/checkout/sessions", { status: 200, data: { object: "list", data: [session({ payment_intent: "pi_list" })] } });

    await agent().get(`/i/${token}/return`).expect(303);

    expect(proxied("/v1/checkout/sessions", "GET")[0]?.query).toMatchObject({ payment_link: "plink_1" });
    expect(await payments(number)).toMatchObject([{ reference: "pi_list" }]);
  });
});

describe("Stripe's trigger, through Composio's webhook", () => {
  it("settles a paid session once, however many times it is delivered", async () => {
    await connected();
    const before = await variant();
    const { number, orderId } = await quote();

    await deliver(session({ payment_intent: "pi_w1" }), { webhookId: "msg_1" }).expect(200);
    await deliver(session({ payment_intent: "pi_w1" }), { webhookId: "msg_1" }).expect(200);
    await deliver(session({ payment_intent: "pi_w1" }), { slug: TRIGGERS[1] }).expect(200);

    expect(await payments(number)).toMatchObject([{ method: "card", reference: "pi_w1", loggedBy: "stripe", amount: AMOUNT }]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid" });
    expect((await variant()).reserved).toBe(before.reserved + 2);
    expect(sends()).toHaveLength(1);
    expect((await connection())?.lastEventAt).toBeInstanceOf(Date);
  });

  it("waits for a delayed payment: completed but unpaid settles nothing", async () => {
    await connected();
    const { number, orderId } = await quote();

    await deliver(session({ payment_status: "unpaid", payment_intent: null })).expect(200);

    expect(await payments(number)).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Quoted" });
  });

  it("drops a trigger the gateway does not listen on", async () => {
    await connected();
    const { number } = await quote();

    await deliver(session(), { slug: "STRIPE_PAYOUT_PAID" }).expect(200);

    expect(await payments(number)).toHaveLength(0);
  });

  it("acknowledges a session it cannot place, and settles nothing", async () => {
    await connected();
    await deliver(session({ payment_link: "plink_stranger", metadata: {} })).expect(200);
    expect(await prisma.payment.count({ where: { workspaceId } })).toBe(0);
  });

  it("finds the invoice by the link's metadata when the link row was replaced", async () => {
    await connected();
    const { number, orderId } = await quote();
    await prisma.paymentLink.deleteMany({ where: { invoiceNumber: number } });

    await deliver(session({ metadata: { invoice: number, workspace: workspaceId } })).expect(200);

    expect(await payments(number)).toHaveLength(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Paid" });
  });

  it("records a payment that landed after the shelf emptied, and flags the order for a person", async () => {
    await connected();
    const { number, orderId } = await quote();
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { reserved: v.stock - 1 } });

    await deliver(session()).expect(200);

    // The money is real, so the payment is.
    expect(await payments(number)).toHaveLength(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.stage).toBe("Paid");
    expect(order.blocked).toContain("sold out before the payment landed");
    // No unit was taken that was not there.
    expect((await variant()).reserved).toBe(v.stock - 1);
    expect(String(sends()[0]!.arguments.text)).toMatch(/refund/);
  });

  it("does not settle another workspace's invoice through this workspace's account", async () => {
    await connected();
    const { user: other } = await createUser("other@test.local");
    const otherId = (await createWorkspace({ userId: other.id, policy: "nothing" })).id;
    const theirs = await sell({ workspaceId: otherId, channel: "telegram", handle: "777", text: "I want 1 olive L polo" });
    const number = theirs.invoice!.number;

    // Delivered for *our* account, naming *their* invoice.
    await deliver(session({ payment_link: "plink_theirs", metadata: { invoice: number, workspace: otherId } })).expect(200);

    expect(await payments(number)).toHaveLength(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: theirs.order!.id } })).toMatchObject({ stage: "Quoted" });
  });

  it("is dropped once the gateway is disconnected", async () => {
    const app = await connected();
    const { number } = await quote();
    await app.delete("/v1/payments/stripe").expect(204);

    // Routed by the account it used to have; nothing owns it now.
    await deliver(session()).expect(200);

    expect(await payments(number)).toHaveLength(0);
  });
});

describe("cancelling an order", () => {
  it("deactivates its payment link on Stripe", async () => {
    const app = await connected();
    const { number, orderId } = await quote();

    await app.post(`/v1/orders/${orderId}/stage`).send({ stage: "Cancelled" }).expect(200);

    expect(proxied("/v1/payment_links/plink_1", "POST")[0]?.query).toEqual({ active: "false" });
    expect(await link(number)).toMatchObject({ closedAs: "cancelled" });
  });

  it("cancels the order even when Stripe will not", async () => {
    const app = await connected();
    const { number, orderId } = await quote();
    fakeComposio.proxy.respond("/v1/payment_links/plink_1", { status: 500, data: { error: { message: "nope" } } });

    await app.post(`/v1/orders/${orderId}/stage`).send({ stage: "Cancelled" }).expect(200);

    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: "Cancelled" });
    expect(await link(number)).toMatchObject({ closedAt: null });
  });
});
