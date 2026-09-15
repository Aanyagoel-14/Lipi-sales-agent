import { z } from "zod";

const variantSchema = z.object({
  optionA: z.string().trim().min(1).max(60),
  optionB: z.string().trim().min(1).max(60),
  stock: z.number().int().min(0).max(1_000_000),
});

export const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(1).max(60),
  axes: z.tuple([z.string().trim().min(1).max(40), z.string().trim().min(1).max(40)]),
  priceInr: z.number().int().min(0).max(100_000_000),
  marginPct: z.number().int().min(0).max(100),
  leadTimeDays: z.number().int().min(0).max(365),
  supplierId: z.string().trim().min(1).nullable(),
  attributes: z.record(z.string().max(40), z.string().max(200)).default({}),
  variants: z.array(variantSchema).min(1).max(200),
});

const importRowSchema = z.object({
  product: z.string().trim().min(2).max(120),
  category: z.string().trim().min(1).max(60),
  axisAName: z.string().trim().min(1).max(40),
  axisAValue: z.string().trim().min(1).max(60),
  axisBName: z.string().trim().min(1).max(40),
  axisBValue: z.string().trim().min(1).max(60),
  priceInr: z.number().int().min(0).max(100_000_000),
  stock: z.number().int().min(0).max(1_000_000),
  marginPct: z.number().int().min(0).max(100).default(0),
  leadTimeDays: z.number().int().min(0).max(365).default(0),
});

export const importSchema = z.object({ rows: z.array(importRowSchema).min(1).max(5_000) });

export const stockSchema = z.object({
  variants: z.array(z.object({
    optionA: z.string().trim().min(1),
    optionB: z.string().trim().min(1),
    stock: z.number().int().min(0).max(1_000_000),
  })).min(1).max(200),
});

export const productId = () => `prd_${Math.random().toString(36).slice(2, 10)}`;
export const supplierId = () => `sup_${Math.random().toString(36).slice(2, 10)}`;
