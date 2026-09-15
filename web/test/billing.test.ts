import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase } from "./helpers";
import { prisma } from "@/server/lib/prisma";
import { toPaise } from "@/server/lib/money";
import { ageing, bucketOf, resolveInvoices, resolvePayments } from "@/server/services/billing";

let workspaceId: string;
let customerId: string;

beforeEach(async () => {
  await resetDatabase();
  const { user } = await createUser();
  workspaceId = (await createWorkspace({ userId: user.id })).id;
  customerId = (await prisma.customer.create({
    data: {
      id: "cus_1", workspaceId, name: "Buyer", handle: "b", channel: "whatsapp", segment: "Retail",
      lifetimeValue: 0, orderCount: 0, avgOrderValue: 0, returnRatePct: 0, priceSensitivity: "Low",
      negotiationStyle: "Direct", sizeProfile: [], predictedNext: "-", riskScore: 0, lastSeenAt: new Date(),
    },
  })).id;
});

const invoice = (number: string, amountInr: number, dueIso: string) =>
  prisma.invoice.create({
    data: {
      number, workspaceId, source: "manual", issuedOn: new Date("2026-07-01"),
      dueOn: new Date(dueIso), amount: toPaise(amountInr), customerId,
    },
  });

const payment = (id: string, number: string, amountInr: number, atIso: string) =>
  prisma.payment.create({
    data: {
      id, workspaceId, receivedAt: new Date(atIso), method: "bank_transfer",
      reference: null, loggedBy: "Test", amount: toPaise(amountInr),
      invoiceNumber: number, customerId,
    },
  });

describe("bucketOf", () => {
  it.each([
    [0, "not_due"], [-5, "not_due"], [1, "late_1_15"], [15, "late_1_15"],
    [16, "late_16_30"], [30, "late_16_30"], [31, "late_30_plus"],
  ])("puts %i days late in %s", (days, bucket) => {
    expect(bucketOf(days)).toBe(bucket);
  });
});

describe("owed is derived, never stored", () => {
  it("subtracts payments from the invoice", async () => {
    await invoice("INV-1", 10_000, "2026-08-01");
    await payment("pay_1", "INV-1", 4_000, "2026-07-20");

    const [resolved] = await resolveInvoices(workspaceId);
    expect(resolved?.amountInr).toBe(10_000);
    expect(resolved?.receivedInr).toBe(4_000);
    expect(resolved?.owedInr).toBe(6_000);
    expect(resolved?.status).toBe("overdue");
  });

  it("marks a fully paid invoice as paid with no days late", async () => {
    await invoice("INV-2", 5_000, "2026-08-01");
    await payment("pay_2", "INV-2", 5_000, "2026-07-20");

    const [resolved] = await resolveInvoices(workspaceId);
    expect(resolved?.status).toBe("paid");
    expect(resolved?.daysLate).toBe(0);
  });

  it("marks an unpaid invoice that is not yet due as awaiting", async () => {
    await invoice("INV-3", 5_000, "2026-12-01");
    const [resolved] = await resolveInvoices(workspaceId);
    expect(resolved?.status).toBe("awaiting");
  });
});

describe("running balance", () => {
  it("walks payments oldest first so each balance is right", async () => {
    await invoice("INV-4", 10_000, "2026-08-01");
    await payment("pay_a", "INV-4", 3_000, "2026-07-10");
    await payment("pay_b", "INV-4", 2_000, "2026-07-20");

    // Returned newest first for display.
    const [newest, oldest] = await resolvePayments(workspaceId);
    expect(oldest?.balanceAfterInr).toBe(7_000);
    expect(newest?.balanceAfterInr).toBe(5_000);
  });
});

describe("ageing", () => {
  it("buckets sum to the total outstanding", async () => {
    await invoice("INV-5", 10_000, "2026-08-21");
    await invoice("INV-6", 2_000, "2026-08-01");
    await invoice("INV-7", 1_000, "2026-07-01");
    await invoice("INV-8", 4_000, "2026-12-01");
    await payment("pay_c", "INV-5", 1_000, "2026-08-10");

    const result = await ageing(workspaceId);
    const sum = result.rows.reduce((a, r) => a + r.amountInr, 0);

    expect(sum).toBe(result.totalOutstanding);
    expect(result.totalOutstanding).toBe(9_000 + 2_000 + 1_000 + 4_000);
  });

  it("excludes settled invoices from the buckets", async () => {
    await invoice("INV-9", 5_000, "2026-08-01");
    await payment("pay_d", "INV-9", 5_000, "2026-08-02");

    const result = await ageing(workspaceId);
    expect(result.totalOutstanding).toBe(0);
    expect(result.settledCount).toBe(1);
  });
});
