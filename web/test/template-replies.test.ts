import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { sell } from "@/server/services/selling";

/**
 * The composed reply, which is what a customer gets whenever the model is not
 * speaking: no key, a spent budget, a model that failed or timed out. It is
 * meant to be "less warm, still correct", and these are the turns from a live
 * Telegram thread (Kamal Papers, 2026-10-28) where it was not.
 */

let workspaceId: string;

async function stationer() {
  const { user } = await createUser();
  const workspace = await createWorkspace({
    userId: user.id, name: "Kamal Papers", vertical: "wholesale", policy: "nothing", withCatalogue: false,
  });
  workspaceId = workspace.id;
  await prisma.supplier.create({
    data: { id: "sup_kp", workspaceId, name: "Mill", onTimePct: 90, avgLeadDays: 5, defectRatePct: 1, moq: 10, responseHours: 4 },
  });
  await prisma.product.create({
    data: {
      id: "prd_dj", workspaceId, name: "Dotted Journal", category: "Journal", axes: ["Size", "Page Count"],
      price: 34900, marginPct: 30, leadTimeDays: 7, crossSell: [], supplierId: "sup_kp",
      variants: { create: [{ optionA: "A5", optionB: "192 Pages", stock: 31, reserved: 0, sku: "DJ-A5-192" }] },
    },
  });
  await prisma.product.create({
    data: {
      id: "prd_tr", workspaceId, name: "Thermal Receipt Roll", category: "Paper", axes: ["Size", "Page Count"],
      price: 4500, marginPct: 30, leadTimeDays: 7, crossSell: [], supplierId: "sup_kp",
      variants: {
        create: [
          { optionA: "79mm", optionB: "50m", stock: 60, reserved: 0, sku: "TR-79-50" },
          { optionA: "57mm", optionB: "25m", stock: 45, reserved: 0, sku: "TR-57-25" },
        ],
      },
    },
  });
}

const say = (text: string) => sell({ workspaceId, channel: "telegram", handle: "tg:4471", name: "Anuj", text });

const STALL = /look into that/i;

beforeEach(async () => {
  await resetDatabase();
  await stationer();
});

describe("the composed reply", () => {
  it("names the only variant there is rather than asking which one", async () => {
    const result = await say("Hello!! Is Dotted journal available??");

    expect(result.reply).toContain("A5 / 192 Pages");
    expect(result.reply).toContain("31");
    expect(result.reply).not.toMatch(/1 variants/);
    expect(result.reply).not.toMatch(/which size and page count/i);
  });

  it("lists the variants when there is a choice to make", async () => {
    const result = await say("Is the thermal receipt roll available?");

    expect(result.reply).toContain("79mm / 50m");
    expect(result.reply).toContain("57mm / 25m");
    expect(result.reply).not.toMatch(/across 2 variants/);
  });

  it("answers a follow-up about options from the product the customer just asked about", async () => {
    await say("Hello!! Is Dotted journal available??");
    const result = await say("What size and page options do you have??");

    expect(result.matched?.product).toBe("Dotted Journal");
    expect(result.reply).toContain("A5 / 192 Pages");
    expect(result.reply).not.toMatch(STALL);
  });

  it("does not quote the same order twice when the customer repeats it", async () => {
    const first = await say("I want to order 2 dotted journals of 192 pages and A5 Size");
    const again = await say("I want to order 2 dotted journals of 192 pages and A5 Size");

    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.invoice.count({ where: { workspaceId } })).toBe(1);
    expect(again.order?.id).toBe(first.order?.id);
    expect(again.invoice?.link).toBe(first.invoice?.link);
  });

  it("sends the payment link again when asked for it", async () => {
    const bought = await say("I want to order 2 dotted journals of 192 pages and A5 Size");
    const asked = await say("I want payment link");

    expect(asked.reply).not.toMatch(STALL);
    expect(asked.reply).toContain(bought.invoice!.link);
    expect(await prisma.order.count({ where: { workspaceId } })).toBe(1);
  });

  it("does not read a product called a receipt roll as a request for a receipt", async () => {
    await say("I want to order 2 dotted journals of 192 pages and A5 Size");
    const result = await say("Is the thermal receipt roll available?");

    expect(result.intent).toBe("inventory_request");
    expect(result.invoice).toBeNull();
  });

  it("answers a greeting as a greeting", async () => {
    const result = await say("Hi");

    expect(result.reply).not.toMatch(STALL);
  });
});
