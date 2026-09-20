"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiJson } from "@/lib/client";
import { dayOf } from "@/lib/dash-types";

type Subscription = {
  id: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdIso: string;
};

type Delivery = {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  nextAttemptIso: string;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptIso: string | null;
  createdIso: string;
};

type Summary = { queued: number; delivered: number; retrying: number; dead: number };

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

const TONE = {
  delivered: "teal",
  pending: "amber",
  dead: "magenta",
} as const;

/** What an operator is actually asking when they look at a row. */
function outcomeOf(delivery: Delivery): string {
  if (delivery.status === "delivered") return `answered ${delivery.lastStatus}`;
  if (!delivery.attempts) return "not tried yet";
  return delivery.lastError ?? `answered ${delivery.lastStatus}`;
}

/**
 * Outbound webhooks, from the operator's side.
 *
 * Two things this screen has to get right. The secret exists in the create
 * response and nowhere afterwards, so it is shown once and dismissed
 * deliberately — the same contract the API keys screen holds. And the
 * delivery list is a log rather than a count: when a customer says "we
 * stopped seeing orders", the status code their endpoint answered with is the
 * fact that settles whose side the fault is on.
 */
export function WebhookPanel() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState("");
  const [issued, setIssued] = useState<{ secret: string; url: string } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      apiJson<{ subscriptions: Subscription[] }>("webhooks"),
      apiJson<{ deliveries: Delivery[] }>("webhooks/deliveries?limit=25"),
    ])
      .then(([subs, dels]) => {
        setSubscriptions(subs.subscriptions);
        setDeliveries(dels.deliveries);
      })
      .catch((e: unknown) => setError((e as Error).message));

  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    act(async () => {
      const body = await apiJson<{ secret: string; subscription: Subscription }>("webhooks", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          eventTypes: types.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      setIssued({ secret: body.secret, url: body.subscription.url });
      setUrl("");
      setTypes("");
    });

  const toggle = (subscription: Subscription) =>
    act(async () => {
      await apiJson(`webhooks/${subscription.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !subscription.active }),
      });
    });

  const remove = (subscription: Subscription) =>
    act(async () => {
      await apiJson(`webhooks/${subscription.id}`, { method: "DELETE" });
    });

  const deliverNow = () =>
    act(async () => {
      setSummary(await apiJson<Summary>("webhooks/dispatch", { method: "POST" }));
    });

  const again = (delivery: Delivery) =>
    act(async () => {
      await apiJson(`webhooks/deliveries/${delivery.id}/redeliver`, { method: "POST" });
      setSummary(await apiJson<Summary>("webhooks/dispatch", { method: "POST" }));
    });

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-xl bg-magenta/10 px-4 py-2.5 text-[0.8125rem] text-magenta">
          {error}
        </p>
      ) : null}

      {issued ? (
        <section className="rounded-2xl border border-violet bg-violet-soft/40 p-5">
          <h2 className="text-[0.875rem] font-medium">Copy the signing secret for {issued.url} now</h2>
          <p className="mt-1 text-[0.8125rem] text-ink-muted">
            This is the only time it is shown. Lipi keeps it encrypted and no endpoint returns it,
            so if it is lost the subscription has to be made again.
          </p>
          <p className="mt-4 break-all rounded-xl bg-surface px-4 py-3 font-mono text-[0.8125rem]">
            {issued.secret}
          </p>
          <p className="mt-3 text-[0.75rem] text-ink-subtle">
            Your endpoint verifies a delivery by recomputing the HMAC-SHA256 of{" "}
            <code className="font-mono">{"<X-Lipi-Timestamp>.<raw body>"}</code> with this secret
            and comparing it, hex-encoded, to <code className="font-mono">X-Lipi-Signature</code>.
          </p>
          <div className="mt-4">
            <Button variant="secondary" size="sm" chevron={false} onClick={() => setIssued(null)}>
              I have saved it
            </Button>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="text-[0.875rem] font-medium">Endpoints</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
            Every twin event this workspace records is offered to each endpoint, unless it named the
            types it wants. Pausing one keeps its place in the log, so resuming does not replay a
            month of events.
          </p>
        </header>

        {subscriptions.length === 0 ? (
          <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">
            No endpoints yet. Nothing outside Lipi hears about an order until one is added.
          </p>
        ) : (
          <ul className="divide-y divide-line/60">
            {subscriptions.map((subscription) => (
              <li key={subscription.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="min-w-0 break-all font-mono text-[0.8125rem]">{subscription.url}</p>
                  <span className="ml-auto">
                    <Tag tone={subscription.active ? "teal" : "neutral"}>
                      {subscription.active ? "live" : "paused"}
                    </Tag>
                  </span>
                </div>
                <p className="mt-2 text-[0.75rem] text-ink-subtle">
                  {subscription.eventTypes.length
                    ? subscription.eventTypes.join(", ")
                    : "every event type"}
                  {" · added "}
                  {dayOf(subscription.createdIso)}
                </p>
                <div className="mt-3.5 flex gap-2">
                  <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => toggle(subscription)}>
                    {subscription.active ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => remove(subscription)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line px-5 py-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="hook-url" className="sr-only">Endpoint URL</label>
            <input
              id="hook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-crm.example.com/hooks/lipi"
              className={field}
            />
            <label htmlFor="hook-types" className="sr-only">Event types</label>
            <input
              id="hook-types"
              value={types}
              onChange={(e) => setTypes(e.target.value)}
              placeholder="order_twin.created, lead.scored"
              className={`${field} sm:w-72`}
            />
            <Button size="sm" chevron={false} disabled={busy || url.trim().length < 8} onClick={create}>
              Add endpoint
            </Button>
          </div>
          <p className="mt-2.5 text-[0.75rem] text-ink-subtle">
            Leave the types blank for everything. The URL must be https and reachable from the
            internet — a signed delivery does not leave in the clear.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <div>
            <h2 className="text-[0.875rem] font-medium">Recent deliveries</h2>
            <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
              {summary
                ? `Last run: ${summary.queued} queued, ${summary.delivered} delivered, ${summary.retrying} retrying, ${summary.dead} dead.`
                : "Lipi has no scheduler of its own — a cron calls the same endpoint this button does."}
            </p>
          </div>
          <span className="ml-auto">
            <Button variant="secondary" size="sm" chevron={false} disabled={busy} onClick={deliverNow}>
              Deliver now
            </Button>
          </span>
        </header>

        {deliveries.length === 0 ? (
          <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">Nothing has been sent yet.</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
                <Tag tone={TONE[delivery.status]}>{delivery.status}</Tag>
                <span className="font-mono text-[0.8125rem]">{delivery.eventType}</span>
                <span className="text-[0.75rem] text-ink-subtle">
                  {outcomeOf(delivery)}
                  {delivery.attempts === 1 ? " · 1 attempt" : ` · ${delivery.attempts} attempts`}
                </span>
                <span className="ml-auto flex items-center gap-3">
                  <span className="font-mono text-[0.6875rem] text-ink-subtle">{delivery.eventId}</span>
                  {delivery.status === "pending" ? null : (
                    <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => again(delivery)}>
                      Redeliver
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
