import { randomUUID } from "node:crypto";
import type { Tx } from "../lib/prisma";
import type { OrderDraftInput, TwinCustomer, TwinProduct, TwinStore } from "./types";

/**
 * The twin, as a skill is allowed to touch it.
 *
 * Built per execution and closed over one workspace and one transaction, so a
 * skill has no way to name another tenant: none of the methods takes a
 * `workspaceId`, because a skill that could pass one could pass somebody
 * else's (invariant 5). It is also the only object a skill gets — `prisma`
 * itself is never handed over, which is what keeps integer money, tenant
 * scoping and the append-only event log from becoming a plugin author's good
 * manners rather than the system's guarantees.
 */

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** A draft order's stage. Named once here so the two writers agree. */
const DRAFT_STAGE = "Quoted" as const;

export function twinStoreFor(opts: {
  tx: Tx;
  workspaceId: string;
  customerId: string | null;
  now: Date;
  record(type: string, twin: string, payload: string): void;
}): TwinStore {
  const { tx, workspaceId, customerId, now, record } = opts;

  return {
    async customer(): Promise<TwinCustomer | null> {
      if (!customerId) return null;
      const row = await tx.customer.findFirst({ where: { id: customerId, workspaceId } });
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        handle: row.handle,
        segment: row.segment,
        lifetimeValue: row.lifetimeValue,
        riskScore: row.riskScore,
        priceSensitivity: row.priceSensitivity,
        leadScore: row.leadScore,
        leadStage: row.leadStage,
      };
    },

    async findProduct(query: string): Promise<TwinProduct | null> {
      const trimmed = query.trim();
      if (!trimmed) return null;

      // SKU first: a skill that has one means that exact variant's product,
      // and a SKU is never a substring of a product name by accident.
      const bySku = await tx.product.findFirst({
        where: { workspaceId, variants: { some: { sku: { equals: trimmed, mode: "insensitive" } } } },
        include: { variants: { orderBy: [{ optionA: "asc" }, { optionB: "asc" }] } },
      });
      const row =
        bySku ??
        (await tx.product.findFirst({
          where: { workspaceId, name: { contains: trimmed, mode: "insensitive" } },
          include: { variants: { orderBy: [{ optionA: "asc" }, { optionB: "asc" }] } },
        }));
      if (!row) return null;

      return {
        id: row.id,
        name: row.name,
        category: row.category,
        price: row.price,
        marginPct: row.marginPct,
        leadTimeDays: row.leadTimeDays,
        axes: row.axes,
        variants: row.variants.map((v) => ({
          id: v.id, sku: v.sku, optionA: v.optionA, optionB: v.optionB, stock: v.stock, reserved: v.reserved,
        })),
      };
    },

    async availability(variantId: string) {
      // Scoped through the product, because `Variant` carries no workspace of
      // its own — the same join every other reader of variants makes.
      const variant = await tx.variant.findFirst({
        where: { id: variantId, product: { workspaceId } },
        select: { stock: true, reserved: true },
      });
      if (!variant) return null;
      return {
        stock: variant.stock,
        reserved: variant.reserved,
        available: variant.stock - variant.reserved,
      };
    },

    async updateOrderDraft(draft: OrderDraftInput) {
      if (!Number.isInteger(draft.calculatedUnitPrice) || draft.calculatedUnitPrice < 0) {
        // Refused rather than rounded. A skill that computed 8.5049 and got
        // 850 back would have quoted a price nobody agreed to, and invariant
        // 4 exists precisely so that cannot happen quietly.
        throw new Error(
          `calculatedUnitPrice must be a non-negative integer in minor units, received ${draft.calculatedUnitPrice}`,
        );
      }
      if (!customerId) {
        throw new Error("updateOrderDraft needs a customer twin; this skill was executed outside a conversation");
      }

      const quantity = draft.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error(`quantity must be a positive integer, received ${quantity}`);
      }

      const value = draft.calculatedUnitPrice * quantity;
      const leadDays = draft.estimatedLeadDays ?? 0;

      // The draft this conversation is negotiating, not a second one per
      // revision: a bespoke quoter is called again every time the customer
      // changes a dimension, and each call would otherwise leave an order
      // behind that nobody placed.
      const existing = await tx.order.findFirst({
        where: { workspaceId, customerId, stage: DRAFT_STAGE, variantId: draft.variantId ?? undefined },
        orderBy: { createdAt: "desc" },
      });

      const specs = draft.customSpecs ? JSON.stringify(draft.customSpecs) : null;

      if (existing) {
        const updated = await tx.order.update({
          where: { id: existing.id },
          data: {
            qty: quantity,
            value,
            blocked: specs ? `Custom spec: ${specs}` : existing.blocked,
          },
        });
        record(
          "order_twin.updated",
          "order",
          `${updated.id} draft unit=${draft.calculatedUnitPrice} qty=${quantity} value=${value} lead_days=${leadDays}`,
        );
        return { id: updated.id, unitPrice: draft.calculatedUnitPrice, leadDays };
      }

      // A draft with no catalogue row behind it is the bespoke case the PRD's
      // SDK example is about: the customer is buying something that does not
      // exist until it is cut. It still needs a product and variant to point
      // at, because `Order` requires them, so the skill has to have matched
      // one — the executor refuses the call otherwise rather than inventing a
      // catalogue entry here.
      if (!draft.productId || !draft.variantId) {
        throw new Error(
          "updateOrderDraft needs productId and variantId when no draft order exists yet for this customer",
        );
      }

      const variant = await tx.variant.findFirst({
        where: { id: draft.variantId, productId: draft.productId, product: { workspaceId } },
        select: { optionA: true, optionB: true },
      });
      if (!variant) throw new Error("updateOrderDraft was given a variant that is not in this workspace");

      const created = await tx.order.create({
        data: {
          id: id("ord"),
          workspaceId,
          customerId,
          productId: draft.productId,
          variantId: draft.variantId,
          variant: `${variant.optionA} / ${variant.optionB}`,
          qty: quantity,
          value,
          stage: DRAFT_STAGE,
          channel: "webchat",
          createdAt: now,
          blocked: specs ? `Custom spec: ${specs}` : null,
        },
      });
      record(
        "order_twin.created",
        "order",
        `${created.id} status=draft unit=${draft.calculatedUnitPrice} qty=${quantity} value=${value} lead_days=${leadDays}`,
      );
      return { id: created.id, unitPrice: draft.calculatedUnitPrice, leadDays };
    },

    async pastDueInvoices() {
      if (!customerId) return { count: 0, totalPaise: 0 };

      // What is owed is derived from the payments recorded against an
      // invoice, never stored — `services/billing.ts` is explicit that
      // storing it would let the total drift from the rows it summarises. So
      // the payments come back with the invoices and the arithmetic happens
      // here, the same way `resolveInvoices()` does it.
      const rows = await tx.invoice.findMany({
        where: { workspaceId, customerId, dueOn: { lt: now } },
        select: { amount: true, payments: { select: { amount: true } } },
      });

      let count = 0;
      let totalPaise = 0;
      for (const row of rows) {
        const owed = row.amount - row.payments.reduce((sum, p) => sum + p.amount, 0);
        if (owed <= 0) continue;
        count += 1;
        totalPaise += owed;
      }
      return { count, totalPaise };
    },
  };
}
