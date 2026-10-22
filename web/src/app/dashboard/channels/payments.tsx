"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

/**
 * Getting paid: the workspace's own payment gateway, connected beside its
 * channels. One gateway today (Stripe), and the shape is the channel card's
 * on purpose — status chip, Connect, Test, Disconnect — because to the
 * operator it is the same kind of thing: a service of theirs that the twin
 * acts through.
 *
 * There is one field to paste, the secret key, and nothing to copy back:
 * Composio holds the key, makes every payment link, and registers Stripe's
 * payment notifications itself. Lipi keeps no credential for it.
 */

type Gateway = {
  provider: string;
  label: string;
  status: "disconnected" | "pending" | "connected" | "needs_reconnect" | "error";
  mode: "test" | "live" | null;
  accountId: string | null;
  displayName: string | null;
  lastEventIso: string | null;
  lastError: string | null;
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

const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;

export function PaymentsSection() {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
    const res = await apiFetch(`payments/${gateway.provider}/connect`, { method: "POST", body: JSON.stringify({ secretKey }) });
    if (!res.ok) throw await failed(res, "Could not connect");
    const data = (await res.json()) as { gateway?: { displayName?: string | null } };
    setSecretKey("");
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

  const ready = SECRET_KEY.test(secretKey.trim());

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
                        : "Payment links in the chat, paid by card, UPI or wallet on Stripe's page."}
                  </p>
                  {connected && gateway.mode === "test" ? (
                    <p className="mt-1 text-[0.75rem] text-amber">
                      Test mode: links are real pages but no money moves. Reconnect with a live key when you are ready.
                    </p>
                  ) : null}
                  {connected && gateway.lastEventIso ? (
                    <p className="mt-1 text-[0.75rem] text-ink-subtle">
                      Last payment event {new Date(gateway.lastEventIso).toLocaleString()}
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
                        onClick={() => { setOpen(!open); setSecretKey(""); setError(null); }}>
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

              {open && gateway.available && !connected ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <p className="text-[0.75rem] text-ink-subtle">
                    From Stripe → Developers → API keys, copy the <strong>secret key</strong>. A test-mode key
                    (<code>sk_test_…</code>) lets you try the whole flow with Stripe&apos;s test cards and no money moving.
                  </p>
                  <div className="space-y-1">
                    <label htmlFor="stripe-secret-key" className="text-[0.75rem] text-ink-subtle">Secret key</label>
                    <input id="stripe-secret-key" type="password" value={secretKey} placeholder="sk_test_…"
                      onChange={(e) => setSecretKey(e.target.value)}
                      autoComplete="off" spellCheck={false} className={field} />
                  </div>
                  <Button size="sm" disabled={busy || !ready} onClick={() => connect(gateway)}>
                    {busy ? "Checking…" : "Check and connect"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    The key goes straight to our connection provider, which also sets up Stripe&apos;s payment
                    notifications for you. Lipi does not keep a copy.
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
