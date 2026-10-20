"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

/**
 * Getting paid: the workspace's own payment gateway, connected beside its
 * channels. One gateway today (Razorpay), and the shape is the channel
 * card's on purpose — status chip, Connect, Test, Disconnect — because to
 * the operator it is the same kind of thing: a service of theirs that the
 * twin acts through.
 *
 * The one difference is the webhook. Composio holds the key and creates
 * every link, but it has no trigger for payments, so Razorpay has to be
 * told where to send them: the operator pastes the URL shown here into
 * Razorpay's webhook form, picks a secret there, and types the same secret
 * here. That is the only credential Lipi keeps, and it keeps it encrypted.
 */

type Gateway = {
  provider: string;
  label: string;
  status: "disconnected" | "pending" | "connected" | "needs_reconnect" | "error";
  mode: "test" | "live" | null;
  keyId: string | null;
  displayName: string | null;
  lastEventIso: string | null;
  lastError: string | null;
  webhookUrl: string;
  webhookEvents: string[];
  available: boolean;
  unavailableReason: string | null;
};

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

const CHIPS: Record<string, { label: string; tone: string; mark: string }> = {
  connected: { label: "Live", tone: "text-teal", mark: "bg-teal-mark" },
  pending: { label: "Checking", tone: "text-ink-muted", mark: "bg-ink-subtle" },
  needs_reconnect: { label: "Needs reconnecting", tone: "text-amber", mark: "bg-amber-mark" },
  error: { label: "Not working", tone: "text-magenta", mark: "bg-magenta-mark" },
};

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{8,}$/;

export function PaymentsSection() {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState({ keyId: "", keySecret: "", webhookSecret: "" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    apiFetch("payments")
      .then((r) => (r.ok ? r.json() : { gateways: [] }))
      .then((d: { gateways: Gateway[] }) => setGateways(d.gateways))
      .catch(() => setGateways([]));

  useEffect(() => { void load(); }, []);

  const failed = async (res: Response, fallback: string) => {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return new Error(payload?.error ?? fallback);
  };

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connect = (gateway: Gateway) => act(async () => {
    const res = await apiFetch(`payments/${gateway.provider}/connect`, { method: "POST", body: JSON.stringify(values) });
    if (!res.ok) throw await failed(res, "Could not connect");
    const data = (await res.json()) as { gateway?: { displayName?: string | null } };
    setValues({ keyId: "", keySecret: "", webhookSecret: "" });
    setOpen(false);
    setNote(`${gateway.label} connected${data.gateway?.displayName ? ` as ${data.gateway.displayName}` : ""}`);
    await load();
  });

  const check = (gateway: Gateway) => act(async () => {
    const res = await apiFetch(`payments/${gateway.provider}/test`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; displayName?: string; error?: string } | null;
    if (!data?.ok) throw new Error(data?.error ?? "That connection did not answer");
    setNote(`Answered as ${data.displayName}`);
    await load();
  });

  const disconnect = (gateway: Gateway) => act(async () => {
    const res = await apiFetch(`payments/${gateway.provider}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw await failed(res, "Could not disconnect");
    await load();
  });

  const ready = KEY_ID.test(values.keyId.trim()) && values.keySecret.trim().length >= 10 && values.webhookSecret.trim().length >= 8;

  return (
    <section className="mt-12">
      <h2 className="max-w-[20ch] text-[1.5rem] tracking-tight">Get paid</h2>
      <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
        Connect your own payment gateway and the twin sends a real payment link with every quote. The order is
        confirmed, and the stock set aside, the moment the gateway says it is paid.
      </p>

      <ul className="mt-8 space-y-2.5">
        {gateways.map((gateway) => {
          const chip = CHIPS[gateway.status];
          const connected = gateway.status === "connected";

          return (
            <li key={gateway.provider} id={`payments-${gateway.provider}`} className="rounded-2xl border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-3 p-5">
                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-medium">{gateway.label}</p>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                    {!gateway.available
                      ? gateway.unavailableReason ?? "Not configured for this deployment"
                      : connected && gateway.displayName
                        ? `Connected as ${gateway.displayName}`
                        : "Payment links in the chat, paid by UPI, card, netbanking or wallet on Razorpay's page."}
                  </p>
                  {connected && gateway.mode === "test" ? (
                    <p className="mt-1 text-[0.75rem] text-amber">
                      Test mode: links are real pages but no money moves. Reconnect with a live key when you are ready.
                    </p>
                  ) : null}
                  {gateway.lastError ? <p className="mt-1 text-[0.75rem] text-magenta">{gateway.lastError}</p> : null}
                </div>

                <span className="ml-auto flex items-center gap-2">
                  {chip ? (
                    <span className={`inline-flex items-center gap-2 text-[0.75rem] ${chip.tone}`}>
                      <span className={`size-1.5 rounded-full ${chip.mark}`} aria-hidden />
                      {chip.label}
                    </span>
                  ) : null}

                  {!gateway.available ? null : connected ? (
                    <>
                      <Button size="sm" variant="ghost" chevron={false} disabled={busy} onClick={() => check(gateway)}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" chevron={false} disabled={busy} onClick={() => disconnect(gateway)}>
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" chevron={false} disabled={busy}
                        onClick={() => { setOpen(!open); setError(null); }}>
                        {busy ? "Working…" : open ? "Cancel" : gateway.status === "disconnected" ? "Connect" : "Reconnect"}
                      </Button>
                      {gateway.status === "disconnected" ? null : (
                        <Button size="sm" variant="ghost" chevron={false} disabled={busy} onClick={() => disconnect(gateway)}>
                          Disconnect
                        </Button>
                      )}
                    </>
                  )}
                </span>
              </div>

              {(open && gateway.available) || connected ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <label htmlFor={`${gateway.provider}-webhook`} className="text-[0.75rem] text-ink-subtle">
                    {connected
                      ? "Razorpay sends payment events here. If you ever remove the webhook in Razorpay, add it back with this URL."
                      : "1. In Razorpay → Account & Settings → Webhooks → Add New Webhook, paste this URL, choose a secret of your own, and tick " +
                        gateway.webhookEvents.join(", ") + "."}
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`${gateway.provider}-webhook`}
                      readOnly
                      value={gateway.webhookUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className={`${field} font-mono text-[0.75rem]`}
                    />
                    <Button size="sm" variant="secondary" chevron={false} onClick={() => copy(gateway.webhookUrl, setCopied)}>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  {gateway.lastEventIso ? (
                    <p className="text-[0.75rem] text-ink-subtle">Last event from Razorpay: {new Date(gateway.lastEventIso).toLocaleString()}</p>
                  ) : connected ? (
                    <p className="text-[0.75rem] text-ink-subtle">No event from Razorpay yet. A test payment will show one.</p>
                  ) : null}
                </div>
              ) : null}

              {open && gateway.available && !connected ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <p className="text-[0.75rem] text-ink-subtle">
                    2. From Razorpay → Account & Settings → API Keys, generate a key pair. A test-mode key
                    (<code>rzp_test_…</code>) lets you try the whole flow without money moving.
                  </p>
                  <div className="space-y-1">
                    <label htmlFor="razorpay-key-id" className="text-[0.75rem] text-ink-subtle">Key ID</label>
                    <input id="razorpay-key-id" value={values.keyId} placeholder="rzp_test_…"
                      onChange={(e) => setValues((v) => ({ ...v, keyId: e.target.value }))}
                      autoComplete="off" spellCheck={false} className={field} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="razorpay-key-secret" className="text-[0.75rem] text-ink-subtle">Key Secret</label>
                    <input id="razorpay-key-secret" type="password" value={values.keySecret} placeholder="Shown once when the key is generated"
                      onChange={(e) => setValues((v) => ({ ...v, keySecret: e.target.value }))}
                      autoComplete="off" className={field} />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="razorpay-webhook-secret" className="text-[0.75rem] text-ink-subtle">Webhook secret</label>
                    <input id="razorpay-webhook-secret" type="password" value={values.webhookSecret} placeholder="The secret you chose for the webhook in step 1"
                      onChange={(e) => setValues((v) => ({ ...v, webhookSecret: e.target.value }))}
                      autoComplete="off" className={field} />
                  </div>
                  <Button size="sm" disabled={busy || !ready} onClick={() => connect(gateway)}>
                    {busy ? "Checking…" : "Check and connect"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    The key goes straight to our connection provider; Lipi does not keep a copy. Only the webhook
                    secret is kept, encrypted, to check that each payment notice really came from Razorpay.
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p aria-live="polite" className="mt-4 text-[0.8125rem]">
        {error ? <span className="text-magenta">{error}</span> : null}
        {note ? <span className="text-ink-muted">{note}</span> : null}
      </p>
    </section>
  );
}

async function copy(text: string, setCopied: (value: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    // Clipboard unavailable (plain-http local testing): the URL is still
    // visible and selectable by hand.
  }
}
