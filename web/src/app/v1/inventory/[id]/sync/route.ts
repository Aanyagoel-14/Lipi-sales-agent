import { z } from "zod";
import { body, HttpError, json, route } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { applySync, secretMatches } from "@/server/services/inventory";

const syncSchema = z.object({
  /** The source's own batch id. Required: without it a retry cannot be told
   *  apart from a second real batch. Uniqueness is scoped to this connector,
   *  so a source numbering its batches 1, 2, 3 is fine — no minimum length is
   *  imposed, because rejecting a source's own id scheme is not our call. */
  idempotencyKey: z.string().trim().min(1).max(200),
  cursor: z.string().trim().max(500).optional(),
  rows: z.array(z.object({
    sku: z.string().trim().min(1).max(120),
    // Deliberately loose: an out-of-range count becomes a visible exception
    // rather than a 422 that tells the operator nothing about which row.
    stock: z.number(),
  })).min(1).max(5_000),
});

/**
 * Where the source pushes. Authenticated by the connector's bearer token
 * rather than a session, because an ERP has no user to sign in as — the same
 * reason the channel webhooks authenticate themselves.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const connector = await prisma.inventoryConnector.findUnique({ where: { id } });
  const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  // One message for a missing connector and a wrong token: telling a caller
  // which connector ids exist is not something a bad token has earned.
  if (!connector || !presented || !secretMatches(presented, connector.secretHash)) {
    throw new HttpError(401, "That connector token is not valid");
  }

  let data: z.infer<typeof syncSchema>;
  try {
    data = await body(req, syncSchema, "Check the batch");
  } catch (error) {
    await prisma.inventoryConnector.update({
      where: { id },
      data: { status: "error", lastError: "A pushed batch was malformed" },
    });
    throw error;
  }

  const outcome = await applySync(connector, data);
  return json(outcome, outcome.replayed ? 200 : 201);
});
