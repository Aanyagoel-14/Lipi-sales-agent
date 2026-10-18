import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { fakeComposio } from "./fakes/composio";
import { invoiceNumberFrom, invoiceToken } from "@/server/lib/crypto";
import { demoPaymentProvider, noPaymentProvider, setPaymentProvider } from "@/server/lib/payments";
import { prisma } from "@/server/lib/prisma";
import { settleInvoice } from "@/server/services/checkout";
import { sell } from "@/server/services/selling";

/**
 * Pay first, then the stock is theirs.
 *
 * A chat message quotes and invoices; the invoice page is where the customer
 * pays; payment is the one moment stock is taken. These follow that from the
 * link in the reply to the confirmation on the customer's own channel, and
 * the cases that must not go wrong on the way: the last unit sold to someone
 * else first, a double click, a forged link.
 */

let workspaceId: string;
const ACCOUNT = "ca_checkout_telegram";

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id, policy: "nothing" })).id;
  setPaymentProvider(demoPaymentProvider);

  fakeComposio.accounts.set(ACCOUNT, { id: ACCOUNT, status: "ACTIVE", statusReason: null, userId: workspaceId, toolkit: "telegram" });
  await prisma.channelConnection.create({
    data: { workspaceId, channel: "telegram", status: "connected", externalId: "bot_1", composioAccountId: ACCOUNT, connectedAt: new Date() },
  });
});

afterEach(() => setPaymentProvider(null));

const variant = () =>
  prisma.variant.findFirstOrThrow({ where: { optionA: "L", optionB: "Olive", product: { workspaceId, name: "Polo Classic" } } });

/** "I want 2 olive L polos" on Telegram, as a customer would send it. */
async function quote(text = "I want 2 olive L polos", handle = "555") {
  const result = await sell({ workspaceId, channel: "telegram", handle, text });
  const token = result.invoice!.link.split("/i/")[1]!;
  return { result, token, number: result.invoice!.number };
}

const pay = (token: string) => agent().post(`/i/${token}/pay`);
const sends = () => fakeComposio.calls.execute.filter((call) => call.slug === "TELEGRAM_SEND_MESSAGE");

describe("the invoice link", () => {
  it("carries the invoice number, signed", () => {
    const token = invoiceToken("INV-2026-0001-abcd");
    expect(invoiceNumberFrom(token)).toBe("INV-2026-0001-abcd");
  });

  it("is not an invoice when the signature does not match", () => {
    const [encoded] = invoiceToken("INV-2026-0001-abcd").split(".");
    expect(invoiceNumberFrom(`${encoded}.forgedforgedforgedforg`)).toBeNull();
    expect(invoiceNumberFrom("nonsense")).toBeNull();
  });

  it("refuses a forged link at the pay route", async () => {
    await pay(`${Buffer.from("INV-2026-0001-abcd").toString("base64url")}.forgedforgedforgedforg`).expect(404);
  });
});

describe("a quote", () => {
  it("sends the invoice link and takes no stock", async () => {
    const before = await variant();
    const { result } = await quote();

    expect(result.reply).toContain(result.invoice!.link);
    expect((await variant()).reserved).toBe(before.reserved);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.order!.id } })).toMatchObject({ stage: "Quoted", reservedUntil: null });
  });
});

describe("paying", () => {
  it("takes the stock, marks the order paid and records the payment", async () => {
    const before = await variant();
    const { result, token, number } = await quote();

    const res = await pay(token).expect(303);
    expect(res.headers.location).toBe(`/i/${token}`);

    expect((await variant()).reserved).toBe(before.reserved + 2);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.order!.id } })).toMatchObject({ stage: "Paid", reservedUntil: null });
    const payments = await prisma.payment.findMany({ where: { invoiceNumber: number } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe(1196 * 2 * 100);
  });

  it("tells the customer on the channel they bought on", async () => {
    const { result, token } = await quote();
    fakeComposio.calls.execute.length = 0;

    await pay(token).expect(303);

    expect(sends()).toHaveLength(1);
    expect(String(sends()[0]!.arguments.text)).toContain("Payment received");
    const confirmation = await prisma.message.findFirstOrThrow({
      where: { conversation: { workspaceId, customerId: result.customer.id }, text: { startsWith: "Payment received" } },
    });
    expect(confirmation.deliveryStatus).toBe("sent");
  });

  it("charges once when the button is pressed twice", async () => {
    const { token, number } = await quote();
    const before = await variant();

    await pay(token).expect(303);
    await pay(token).expect(303);

    expect(await prisma.payment.count({ where: { invoiceNumber: number } })).toBe(1);
    expect((await variant()).reserved).toBe(before.reserved + 2);
  });

  it("charges nothing and takes nothing when it sold out first", async () => {
    const { result, token, number } = await quote();
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { reserved: v.stock - 1 } });

    const res = await pay(token).expect(303);

    expect(res.headers.location).toBe(`/i/${token}?error=sold_out`);
    expect(await prisma.payment.count({ where: { invoiceNumber: number } })).toBe(0);
    expect((await variant()).reserved).toBe(v.stock - 1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.order!.id } })).toMatchObject({ stage: "Quoted" });
  });

  it("sells the last unit to whoever pays first", async () => {
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { stock: 2, reserved: 0 } });
    const first = await quote("I want 2 olive L polos", "555");
    const second = await quote("I want 2 olive L polos", "556");

    await pay(second.token).expect(303);
    const res = await pay(first.token).expect(303);

    expect(res.headers.location).toContain("error=sold_out");
    expect((await variant()).reserved).toBe(2);
  });

  it("says so rather than pretending, when no provider is configured", async () => {
    setPaymentProvider(noPaymentProvider);
    const { token, number } = await quote();

    const res = await pay(token).expect(303);

    expect(res.headers.location).toBe(`/i/${token}?error=unavailable`);
    expect(await prisma.payment.count({ where: { invoiceNumber: number } })).toBe(0);
  });

  it("is the same settlement whoever calls it", async () => {
    const { number, result } = await quote();
    const settled = await settleInvoice(workspaceId, number, { method: "card", reference: "cs_1", by: "stripe" });
    expect(settled).toMatchObject({ ok: true, alreadyPaid: false, orderId: result.order!.id });
    expect(await settleInvoice(workspaceId, number, { method: "card", reference: "cs_1", by: "stripe" }))
      .toMatchObject({ ok: true, alreadyPaid: true });
  });
});

describe("the PDF", () => {
  it("is served behind the same signed link", async () => {
    const { token } = await quote();
    const res = await agent().get(`/i/${token}/pdf`).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });
});

describe("an order confirmed by hand", () => {
  // Paid by bank transfer, say: the operator confirms it, and that is when
  // the stock is taken, if it is there.
  it("takes the stock when confirmed, since the quote held none", async () => {
    const { result } = await quote();
    const before = await variant();
    const app = await signedIn();

    await app.post(`/v1/orders/${result.order!.id}/stage`).send({ stage: "Confirmed" }).expect(200);

    expect((await variant()).reserved).toBe(before.reserved + 2);
  });

  it("refuses to confirm what the shelf cannot fill", async () => {
    const { result } = await quote();
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { reserved: v.stock } });
    const app = await signedIn();

    await app.post(`/v1/orders/${result.order!.id}/stage`).send({ stage: "Confirmed" }).expect(409);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: result.order!.id } })).toMatchObject({ stage: "Quoted" });
  });

  // An unpaid quote held nothing, so returning it must not hand back
  // somebody else's reservation.
  it("releases nothing for a quote that was never paid", async () => {
    const { result } = await quote();
    const v = await variant();
    await prisma.variant.update({ where: { id: v.id }, data: { reserved: 5 } });
    const app = await signedIn();

    await app.post(`/v1/orders/${result.order!.id}/stage`).send({ stage: "Returned" }).expect(200);

    expect((await variant()).reserved).toBe(5);
  });
});
