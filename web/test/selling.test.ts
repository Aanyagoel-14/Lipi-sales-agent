import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { env } from "@/server/env";
import { prisma } from "@/server/lib/prisma";
import { invoiceForOrder, renderInvoicePdf } from "@/server/services/invoicing";
import { repairSettledSale, sell } from "@/server/services/selling";

let workspaceId: string;

async function setup(policy: "everything" | "money_only" | "nothing" = "nothing") {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy });
  workspaceId = workspace.id;
  return workspace;
}

const buy = (text: string, handle = "+91 90 000 5555") =>
  sell({ workspaceId, channel: "webchat", handle, name: "Walk-in", text });

beforeEach(async () => { await resetDatabase(); });

describe("selling", () => {
  it("reserves real stock and creates a real order", async () => {
    await setup();
    const before = await prisma.variant.findFirstOrThrow({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
    });

    const result = await buy("I need 2 blue XL polos");

    const after = await prisma.variant.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.reserved).toBe(before.reserved + 2);
    expect(result.order).not.toBeNull();
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
  });

  it("raises an invoice for the order it just created", async () => {
    await setup();
    const result = await buy("I need 2 blue XL polos");

    expect(result.invoice).not.toBeNull();
    expect(result.invoice!.number).toMatch(/^INV-\d{4}-\d{4}-/);
    expect(result.invoice!.amountInr).toBe(result.order!.valueInr);

    const row = await prisma.invoice.findFirstOrThrow({ where: { workspaceId } });
    expect(row.orderId).toBe(result.order!.id);
  });

  it("does not sell stock it does not have", async () => {
    await setup();
    const result = await buy("I need 9999 blue XL polos");

    expect(result.order).toBeNull();
    expect(result.invoice).toBeNull();
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
  });

  it("answers a stock question without selling anything", async () => {
    await setup();
    const result = await buy("do you have XL polos in stock?");

    expect(result.order).toBeNull();
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(0);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("reuses the same customer twin across turns", async () => {
    await setup();
    const first = await buy("hello");
    const second = await buy("do you have polos?");

    expect(first.customer.isNew).toBe(true);
    expect(second.customer.id).toBe(first.customer.id);
  });

  it("returns the previous invoice when asked for it later", async () => {
    await setup();
    const bought = await buy("I need 2 blue XL polos");
    const asked = await buy("can you send me the invoice?");

    expect(asked.invoice!.number).toBe(bought.invoice!.number);
    // Asking twice must not raise a second demand for the same money.
    expect(await prisma.invoice.count({ where: { workspaceId } })).toBe(1);
  });
});

describe("invoicing", () => {
  it("is idempotent per order", async () => {
    await setup();
    await buy("I need 2 blue XL polos");
    const order = await prisma.order.findFirstOrThrow({ where: { workspaceId } });

    const a = await invoiceForOrder(workspaceId, order.id);
    const b = await invoiceForOrder(workspaceId, order.id);

    expect(b.created).toBe(false);
    expect(b.invoice.number).toBe(a.invoice.number);
  });

  it("gives a wholesale buyer credit terms", async () => {
    await setup();
    // Enough on the shelf that the size of the order is what is being tested,
    // not whether it can be filled.
    await prisma.variant.updateMany({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
      data: { stock: 500, reserved: 0 },
    });
    await buy("I need 60 blue XL polos", "+91 90 000 7777");

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { workspaceId } });
    const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId } });
    expect(customer.segment).toBe("Wholesale");
    expect(invoice.dueOn.getTime()).toBeGreaterThan(invoice.issuedOn.getTime());
  });

  it("renders a real PDF", async () => {
    await setup();
    const result = await buy("I need 2 blue XL polos");
    const { filename, body } = await renderInvoicePdf(workspaceId, result.invoice!.number);

    expect(filename).toBe(`${result.invoice!.number}.pdf`);
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.subarray(-6).toString()).toContain("%%EOF");
    expect(body.length).toBeGreaterThan(800);
  });

  it("writes an invoice.issued event", async () => {
    await setup();
    await buy("I need 2 blue XL polos");
    const events = await prisma.twinEvent.findMany({ where: { workspaceId, type: "invoice.issued" } });
    expect(events).toHaveLength(1);
  });
});

describe("voicing the reply", () => {
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  it("hands the model the verified facts and sends what it says back", async () => {
    await setup();
    let system = "";
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      system = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Lovely, those are reserved for you." } }] }), { status: 200 });
    });

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("openrouter");
    expect(result.reply).toBe("Lovely, those are reserved for you.");
    expect(system).toContain("AN ORDER WAS CREATED");
    expect(system).toContain(result.order!.id);
    // The conversation must show what the customer was actually sent.
    const message = await prisma.message.findFirstOrThrow({
      where: { conversationId: result.conversationId, from: "agent" },
    });
    expect(message.text).toBe("Lovely, those are reserved for you.");
  });

  it("grounds the prompt in the policies the message asks about, and says which", async () => {
    await setup();
    let system = "";
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      system = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Both of those, yes." } }] }), { status: 200 });
    });

    const result = await buy("do you do bulk pricing for 200 units, and what is your returns window?");

    expect(system).toContain("POLICY THAT ANSWERS THIS MESSAGE");
    expect(system).toContain("Orders above 100 units qualify for tiered pricing");
    expect(system).toContain("Unworn items can be returned within 14 days");
    expect(result.knowledgeUsed.map((k) => k.title).sort()).toEqual(["Returns window", "Volume discounts"]);
  });

  it("reports the template's own entry when there is no model to ground", async () => {
    await setup();
    env.OPENROUTER_API_KEY = undefined;

    const result = await buy("what is your returns policy for unworn items?");

    expect(result.voicedBy).toBe("template");
    expect(result.knowledgeUsed.map((k) => k.title)).toEqual(["Returns window"]);
  });

  it("falls back to the composed reply when the model fails, keeping the order", async () => {
    await setup();
    vi.stubGlobal("fetch", async () => new Response("no credits", { status: 402 }));

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("402");
    expect(result.order).not.toBeNull();
    expect(result.reply).toContain("Reserved");
  });

  /**
   * Same salesperson, different surface. The length and formatting rule is
   * chosen from the channel rather than applied to the model's output after
   * the fact — trimming a reply to fit a bubble would cut a verified price in
   * half, which is a number nobody computed.
   */
  it("asks for the reply the channel can actually render", async () => {
    await setup();
    // A key turns on the model-backed extractor too, and it posts to the
    // same endpoint; only the sales prompt is of interest here.
    const prompts: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      const system: string = JSON.parse(init.body).messages[0].content;
      if (system.startsWith("You are a salesperson")) prompts.push(system);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "Olive is in." }) } }] }), { status: 200 });
    });

    await sell({ workspaceId, channel: "webchat", handle: "web:v1", text: "do you have olive polos" });
    await sell({ workspaceId, channel: "whatsapp", handle: "+91 90 000 5555", text: "do you have olive polos" });

    const [web, whatsapp] = prompts;
    expect(web).toContain("renders as markdown");
    expect(whatsapp).toContain("WhatsApp message");
    expect(whatsapp).not.toContain("renders as markdown");
  });

  it("refuses a reply that uses a banned phrase", async () => {
    await setup();
    await prisma.twinVoice.update({ where: { workspaceId }, data: { neverSay: ["no problem"] } });
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "No problem, done!" } }] }), { status: 200 }));

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("banned");
    expect(result.reply).not.toContain("No problem");
  });
});

describe("the storefront endpoints", () => {
  it("refuses an anonymous seller call", async () => {
    await setup();
    const { agent } = await import("./helpers");
    await agent().post("/v1/twin/sell").send({ text: "hi", handle: "x" }).expect(401);
  });

  it("serves the invoice as a PDF", async () => {
    await setup();
    const result = await buy("I need 2 blue XL polos");
    const a = await signedIn();

    const res = await a.get(`/v1/invoices/${encodeURIComponent(result.invoice!.number)}/pdf`).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("will not serve another workspace's invoice", async () => {
    await setup();
    const result = await buy("I need 2 blue XL polos");

    const { user } = await createUser("other@test.local");
    await createWorkspace({ userId: user.id, name: "Other Co" });
    const other = await signedIn("other@test.local");

    await other.get(`/v1/invoices/${encodeURIComponent(result.invoice!.number)}/pdf`).expect(404);
  });
});

describe("what a customer is allowed to see", () => {
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  /**
   * The bug this locks down: the seller was handed the operator briefing, and
   * told a shopper that two units were reserved for someone else's order,
   * naming the order and what it was quoted at.
   */
  it("never puts other orders, customers or margins in the sales prompt", async () => {
    await setup();
    // Give the workspace something to leak: a real order from another buyer.
    await sell({ workspaceId, channel: "whatsapp", handle: "+91 90 000 1111", name: "Priya Sharma", text: "I need 2 blue XL polos" });
    const other = await prisma.order.findFirstOrThrow({ where: { workspaceId } });

    let system = "";
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      system = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "Sure!" }) } }] }), { status: 200 });
    });

    await sell({ workspaceId, channel: "webchat", handle: "+91 98 222 3333", name: "Walk-in", text: "what do you have?" });

    expect(system).not.toContain(other.id);
    expect(system).not.toContain("Priya Sharma");
    expect(system).not.toContain("TOP CUSTOMERS");
    expect(system).not.toContain("PENDING APPROVALS");
    // "N reserved" is the shape that leaked; the word alone appears in the
    // instructions telling the model to confirm this customer's own order.
    expect(system).not.toMatch(/\d+ reserved/);
    // Likewise the words "margin" and "supplier" appear in the rule that
    // forbids them, so assert on the shape the operator briefing prints.
    expect(system).not.toMatch(/margin \d+%/);
    expect(system).not.toMatch(/supplier \w/);
    expect(system).not.toContain("lifetime");
    // It still knows what it is selling.
    expect(system).toContain("Polo Classic");
    expect(system).toContain("WHAT IS FOR SALE");
  });

  it("shows a customer availability, not the reservation behind it", async () => {
    await setup();
    const { buildGrounding } = await import("@/server/services/briefing");
    await prisma.variant.updateMany({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
      data: { stock: 10, reserved: 4 },
    });

    const { text: catalogue } = await buildGrounding(workspaceId, { text: "what do you have?" });
    expect(catalogue).toContain("XL / Cobalt (6)");
    expect(catalogue).not.toContain("4 reserved");
  });

  it("marks a variant with nothing left as sold out", async () => {
    await setup();
    const { buildGrounding } = await import("@/server/services/briefing");
    await prisma.variant.updateMany({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
      data: { stock: 3, reserved: 3 },
    });

    const { text: catalogue } = await buildGrounding(workspaceId, { text: "what do you have?" });
    expect(catalogue).toMatch(/Sold out:.*XL \/ Cobalt/);
  });
});

describe("a sale that is already made", () => {
  it("cuts the question and confirms the invoice instead", () => {
    const asked = "Hi! XL / Olive Polo Classic is in stock with 9 available. At ₹1,196 each, 2 would be ₹2,392. Shall I reserve them for you? — Test Co";
    expect(repairSettledSale(asked, "— Test Co", "INV-2026-0001-abcd")).toBe(
      "Hi! XL / Olive Polo Classic is in stock with 9 available. At ₹1,196 each, 2 would be ₹2,392. Invoice INV-2026-0001-abcd is ready to download.\n— Test Co",
    );
  });

  it.each([
    "Shall I go ahead and place that order?",
    "Would you like me to reserve these for you?",
    "Should I proceed to checkout?",
    "Do you want me to book those?",
  ])("catches %j", (question) => {
    const reply = `Two Polo Classic in XL / Olive at ₹1,196 each, ₹2,392 total. ${question}`;
    expect(repairSettledSale(reply, null, null)).toBe(
      "Two Polo Classic in XL / Olive at ₹1,196 each, ₹2,392 total. It is reserved for you.",
    );
  });

  it("leaves a reply that does not ask permission alone", () => {
    const fine = "Reserved 2 × Polo Classic for you. Anything else?";
    expect(repairSettledSale(fine, null, "INV-1")).toBeNull();
  });

  it("gives up when cutting the question leaves nothing", () => {
    expect(repairSettledSale("Shall I reserve those?", null, "INV-1")).toBeNull();
  });

  it("falls back to the composed reply when the model only asks permission", async () => {
    await setup();
    env.OPENROUTER_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "Shall I reserve those?" }) } }] }), { status: 200 }));

    const result = await buy("I need 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("already placed");
    expect(result.order).not.toBeNull();
    env.OPENROUTER_API_KEY = undefined;
    vi.unstubAllGlobals();
  });
});

describe("objections, alternatives and what may answer them", () => {
  beforeEach(() => { env.OPENROUTER_API_KEY = "test-key"; });
  afterEach(() => { env.OPENROUTER_API_KEY = undefined; vi.unstubAllGlobals(); });

  /** Answers with whatever the model is told to say, and keeps the prompt. */
  function modelSays(reply: string) {
    const seen = { system: "" };
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      seen.system = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply }) } }] }), { status: 200 });
    });
    return seen;
  }

  it("refuses a discount the model invented, and sends the plain reply instead", async () => {
    await setup();
    modelSays("I can do 15% off if you take two today.");

    const result = await buy("that is more than I wanted to spend on 2 blue XL polos");

    expect(result.voicedBy).toBe("template");
    expect(result.degraded).toContain("unauthorised discount");
    expect(result.reply).not.toContain("15%");
    expect(result.reply).not.toMatch(/discount/i);
  });

  it("hands the model in-stock alternatives when what they asked for is gone", async () => {
    await setup();
    await prisma.variant.updateMany({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
      data: { stock: 0, reserved: 0 },
    });
    const seen = modelSays("That size is gone, but M is here.");

    const result = await buy("I need 2 blue XL polos");

    expect(seen.system).toContain("WHAT TO PUT IN FRONT OF THEM");
    expect(seen.system).toMatch(/which is sold out: Polo Classic in .+ available/);
    expect(result.recommended.some((r) => r.kind === "alternative" && r.available > 0)).toBe(true);
    // Nothing was sold, so nothing was reserved.
    expect(result.order).toBeNull();
  });

  it("tells the model it may not invent a discount", async () => {
    await setup();
    const seen = modelSays("Those are reserved.");

    await buy("I need 2 blue XL polos");

    expect(seen.system).toContain("You may NEVER offer a discount");
    expect(seen.system).toContain("HANDLING AN OBJECTION IS A MATTER OF WORDS");
  });
});

describe("the grounding block", () => {
  /** A second product in an existing category, so neighbours have something to be. */
  async function addPolo(name: string) {
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { workspaceId } });
    await prisma.product.create({
      data: {
        id: `prd_${name.toLowerCase().replace(/\W/g, "")}`, workspaceId, name, category: "Polo",
        axes: ["Size", "Colour"], price: 150_000, marginPct: 40, leadTimeDays: 5,
        crossSell: [], supplierId: supplier.id,
        variants: { create: [{ optionA: "L", optionB: "Cobalt", stock: 7, reserved: 0, sku: `${name}-L-COB` }] },
      },
    });
  }

  it("carries every policy the message asks about, not just the first", async () => {
    await setup();
    const { buildGrounding } = await import("@/server/services/briefing");

    const grounding = await buildGrounding(workspaceId, {
      text: "do you do bulk pricing for 200 units, and what is your returns window?",
      intent: "quote_request",
    });

    expect(grounding.knowledge.map((k) => k.title).sort()).toEqual(["Returns window", "Volume discounts"]);
    expect(grounding.text).toContain("Unworn items can be returned within 14 days");
    expect(grounding.text).toContain("Orders above 100 units qualify for tiered pricing");
  });

  it("puts the matched product and its category neighbours in front", async () => {
    await setup();
    await addPolo("Polo Sport");
    const { buildGrounding } = await import("@/server/services/briefing");

    const { text } = await buildGrounding(workspaceId, {
      text: "I need 2 blue XL polos",
      intent: "buy",
      matched: { product: "Polo Classic", variant: "XL / Cobalt" },
    });

    expect(text.indexOf("Polo Classic")).toBeLessThan(text.indexOf("Polo Sport"));
    // Alphabetically the belt leads the catalogue; relevance puts it behind both polos.
    expect(text.indexOf("Polo Sport")).toBeLessThan(text.indexOf("Leather Belt"));
  });

  it("takes every price and count from the database", async () => {
    await setup();
    await prisma.product.updateMany({ where: { workspaceId, name: "Polo Classic" }, data: { price: 123400 } });
    await prisma.variant.updateMany({
      where: { optionA: "XL", optionB: "Cobalt", product: { workspaceId, name: "Polo Classic" } },
      data: { stock: 10, reserved: 4 },
    });
    const { buildGrounding } = await import("@/server/services/briefing");

    const { text } = await buildGrounding(workspaceId, { text: "how much is a polo?", intent: "other" });

    expect(text).toContain("₹1,234 each");
    expect(text).toContain("XL / Cobalt (6)");
    // The reservation behind the number is still none of a customer's business.
    expect(text).not.toContain("4 reserved");
  });

  it("stays inside its ceiling with 500 knowledge entries, keeping the ones that answer", async () => {
    await setup();
    const { buildGrounding, GROUNDING_MAX_CHARS } = await import("@/server/services/briefing");
    await prisma.knowledgeEntry.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        workspaceId, kind: "faq" as const, title: `Filler ${i}`,
        // Long, because a taught policy is often a few paragraphs: twenty of
        // these are already past the ceiling on their own.
        body: `An entry about nothing in particular, number ${i}. `.repeat(20),
      })),
    });

    const grounding = await buildGrounding(workspaceId, {
      text: "do you do bulk pricing for 200 units, and what is your returns window?",
      intent: "quote_request",
    });

    expect(grounding.text.length).toBeLessThanOrEqual(GROUNDING_MAX_CHARS);
    // Trimmed, not merely short: the entries that answer nothing are the ones cut.
    expect(grounding.text.split("Filler").length - 1).toBeLessThan(20);
    expect(grounding.text).toContain("Returns window");
    expect(grounding.text).toContain("Volume discounts");
    expect(grounding.text).toContain("Polo Classic");
  });

  it("says so when what it lists is not the whole catalogue", async () => {
    await setup();
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { workspaceId } });
    // Past the page the block reads, and named so they sort last: a model told
    // nothing would answer "we do not sell that" for the products off the page.
    await prisma.product.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        id: `prd_filler_${i}`, workspaceId, name: `Zz Filler ${i}`, category: "Filler",
        axes: ["Size", "Colour"], price: 10000, marginPct: 10, leadTimeDays: 3,
        crossSell: [], supplierId: supplier.id,
      })),
    });
    const { buildGrounding } = await import("@/server/services/briefing");

    const { text } = await buildGrounding(workspaceId, { text: "what do you have?" });

    expect(text).toContain("This is not the whole catalogue");
  });

  it("is deterministic — the same message and workspace build the same block", async () => {
    await setup();
    const { buildGrounding } = await import("@/server/services/briefing");
    const focus = { text: "returns on a bulk order of polos", intent: "other" };

    const first = await buildGrounding(workspaceId, focus);
    const second = await buildGrounding(workspaceId, focus);

    expect(second.text).toBe(first.text);
    expect(second.knowledge).toEqual(first.knowledge);
  });
});
