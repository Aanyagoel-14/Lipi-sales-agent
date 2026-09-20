import { corsPreflight, corsRoute } from "@/server/lib/cors";
import { HttpError, body, json } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { readTypedContact } from "@/server/services/contacts";
import { captureTypedContact } from "@/server/services/webchat";
import { contactSchema } from "../../schemas";

export const OPTIONS = corsPreflight;

/**
 * One contact detail, typed into the widget's inline field rather than said
 * in a sentence (#16). Its own route rather than a flag on `/message`,
 * because pressing Save on a box is not sending a message: it must not cost
 * a model call, must not appear in the transcript, and must not make the
 * visitor wait on a reply they did not ask for.
 *
 * The answer carries what the next field should be for, so the widget shows
 * one at a time without deciding for itself what is still missing.
 */
export const POST = corsRoute<{ workspaceId: string }>(async (req, { workspaceId }) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) throw new HttpError(404, "Unknown workspace");

  const data = await body(req, contactSchema, "Check the contact detail");

  // The label said what the box was for; this is the check that it holds
  // one. Refusing is the right answer — a wrong address written onto the
  // twin as fact is worse than an empty column.
  const detected = readTypedContact(data.field, data.value);
  if (!detected) throw new HttpError(422, `That does not look like a ${data.field}`);

  const result = await captureTypedContact({ workspaceId, visitorId: data.visitorId, detected });
  if (!result) throw new HttpError(404, "Unknown visitor");

  return json(result);
});
