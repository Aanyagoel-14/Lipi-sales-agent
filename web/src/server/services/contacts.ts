import { detectContact, type DetectedContact } from "./extract";
import type { TwinEffect } from "../lib/events";
import type { Tx } from "../lib/prisma";
import type { ContactField, ContactHeld } from "./leads";
import type { Channel, ContactSource } from "@/generated/prisma/client";

/**
 * Progressive contact capture (#16), decided in one place.
 *
 * Two things give the twin a way to reach somebody: a pattern that found an
 * address in a message they wrote for some other reason, and the widget's
 * own labelled field. They arrive down different paths — one inside the
 * `ingest()` transaction, one from its own route — and they must not decide
 * differently about what overwrites what or what counts as a duplicate, so
 * the decision lives here and each caller does its own writing.
 *
 * Nothing here writes. `planContactCapture()` reads the twin, decides, and
 * hands back the columns to set and the events to append; `ingest()` folds
 * those into the customer update and the event batch it was already making
 * (invariants 1 and 6), and the widget's route writes them in a transaction
 * of its own.
 */

/** The columns the decision reads. A webchat twin's `name` is its `handle`
 *  until somebody gives a real one, which is how "do we have a name" is
 *  answered without a column for it. */
export type ContactRow = {
  id: string;
  name: string;
  handle: string;
  channel: Channel;
  email: string | null;
  phone: string | null;
};

/** What to set on the customer row. Every field is optional: a message that
 *  volunteered nothing produces an empty object and no write of its own. */
export type ContactUpdate = {
  name?: string;
  email?: string;
  emailSource?: ContactSource;
  emailAt?: Date;
  phone?: string;
  phoneSource?: ContactSource;
  phoneAt?: Date;
};

export type ContactPlan = {
  update: ContactUpdate;
  captured: ContactField[];
  /**
   * The other twin in this workspace already holding this email, when there
   * is one. The address is still written here — it is what this person said —
   * but the two rows stay two people. Merging identities across twins is its
   * own problem with its own evidence; guessing at it from one shared address
   * would silently fold a colleague, a shared family inbox or a typo into
   * somebody else's history (invariant 5).
   */
  duplicateEmailOf: string | null;
  events: TwinEffect[];
};

/** A typed box answers for exactly one field, so the other two are spread in
 *  from here rather than written out at each return. */
const NOTHING_DETECTED: DetectedContact = { name: null, email: null, phone: null };

/**
 * A value typed into the widget's own labelled field, read as that field.
 *
 * The label says what the box is for; the visitor is still free to type
 * anything into it, so an address or a number goes through exactly the
 * patterns that read one out of a sentence — a box must not be able to write
 * something into the twin that a sentence could not. Null means it is not
 * that thing, and the caller refuses it rather than storing it.
 *
 * A name is the exception, and `form` provenance is why: nobody types their
 * name into a box labelled for it by accident, and the heuristics that keep
 * "I'm looking for polos" from introducing a customer called Looking have
 * nothing to do here.
 */
export function readTypedContact(field: ContactField, value: string): DetectedContact | null {
  const typed = value.trim();
  if (!typed) return null;

  if (field === "name") return { ...NOTHING_DETECTED, name: typed };

  const found = detectContact(typed)[field];
  return found ? { ...NOTHING_DETECTED, [field]: found } : null;
}

/**
 * The channels whose handle IS a way to reach somebody: a WhatsApp handle is
 * the number we send to, an email handle is the address. Asking a customer
 * for the number the thread is already running over makes the twin look like
 * it is not reading its own screen — so the handle counts as held, even
 * though it is not copied into the column. A Telegram chat id or an
 * Instagram username is neither, and nothing is assumed from those.
 *
 * Held, not captured: the column says what somebody gave us, and the handle
 * is what the provider routed. Copying one into the other would make the
 * provenance a lie.
 */
const HANDLE_IS: Partial<Record<Channel, ContactField>> = {
  whatsapp: "phone",
  email: "email",
};

/** What the twin already has, for `nextContactAsk`. */
export function contactHeld(customer: ContactRow): ContactHeld {
  const fromHandle = HANDLE_IS[customer.channel];

  return {
    name: customer.name !== customer.handle,
    email: Boolean(customer.email) || fromHandle === "email",
    phone: Boolean(customer.phone) || fromHandle === "phone",
  };
}

/**
 * Event payloads name the field and where it came from, never the value.
 * `TwinEvent` is the append-only log that `/v1/events` publishes and the
 * outbound webhook dispatcher posts to whatever endpoint a workspace
 * registered (#21) — an address written into a payload would be an address
 * we cannot take back out of it.
 */
const captured = (customer: string, field: ContactField, source: ContactSource): TwinEffect => ({
  type: "customer_twin.contact_captured",
  twin: "customer",
  payload: `${customer} field=${field} source=${source}`,
});

const conflict = (customer: string, alsoOn: string): TwinEffect => ({
  type: "customer_twin.contact_conflict",
  twin: "customer",
  payload: `${customer} field=email also_on=${alsoOn} resolution=not_merged`,
});

/**
 * What this contact detail does to the twin, if anything.
 *
 * A name is only taken while the twin is still called by its handle: a
 * person who introduced themselves once is not renamed by a later "this is
 * urgent". An address or a number is taken when there is none, and replaced
 * when a different one arrives — somebody retyping their email is correcting
 * it, and the correction is the one worth keeping. The same value arriving
 * twice writes nothing at all, so the timestamp keeps saying when the twin
 * actually learned it.
 */
export async function planContactCapture(
  client: Tx,
  input: {
    workspaceId: string;
    customer: ContactRow;
    detected: DetectedContact;
    source: ContactSource;
    now: Date;
  },
): Promise<ContactPlan> {
  const { customer, detected, source, now } = input;
  const update: ContactUpdate = {};
  const fields: ContactField[] = [];
  const events: TwinEffect[] = [];
  let duplicateEmailOf: string | null = null;

  if (detected.name && customer.name === customer.handle) {
    update.name = detected.name;
    fields.push("name");
    events.push(captured(customer.id, "name", source));
  }

  if (detected.email && detected.email !== customer.email) {
    // Scoped to this workspace, like every read: the same address in two
    // tenants is two unrelated people and neither is evidence about the other.
    const other = await client.customer.findFirst({
      where: { workspaceId: input.workspaceId, email: detected.email, NOT: { id: customer.id } },
      select: { id: true },
    });

    update.email = detected.email;
    update.emailSource = source;
    update.emailAt = now;
    fields.push("email");
    events.push(captured(customer.id, "email", source));

    if (other) {
      duplicateEmailOf = other.id;
      events.push(conflict(customer.id, other.id));
    }
  }

  if (detected.phone && detected.phone !== customer.phone) {
    update.phone = detected.phone;
    update.phoneSource = source;
    update.phoneAt = now;
    fields.push("phone");
    events.push(captured(customer.id, "phone", source));
  }

  return { update, captured: fields, duplicateEmailOf, events };
}
