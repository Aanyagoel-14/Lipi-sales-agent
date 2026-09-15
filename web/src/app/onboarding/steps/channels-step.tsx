"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

type ChannelRow = {
  channel: string;
  supported: boolean;
  credentialLabel: string | null;
  status: string;
  displayName: string | null;
  hasCredentials: boolean;
  installSnippet: string | null;
};

const LABELS: Record<string, string> = {
  whatsapp: "WhatsApp", telegram: "Telegram", email: "Email",
  webchat: "Website chat", instagram: "Instagram DM",
};

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

/**
 * Connecting for real, during setup.
 *
 * Credentials are checked against the provider before they are stored, so the
 * operator finds out here that a token is wrong rather than when a customer
 * messages and nothing happens.
 */
export function ChannelsStep({ onConnected }: { onConnected?: () => void }) {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copySnippet(snippet: string) {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or unavailable (e.g. non-HTTPS local
      // testing) — the snippet is still visible and selectable by hand.
    }
  }

  const load = () =>
    apiFetch("channels")
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((d: { channels: ChannelRow[] }) => setRows(d.channels))
      .catch(() => setRows([]));

  useEffect(() => { void load(); }, []);

  async function connect(channel: string) {
    setBusy(true);
    setError(null);
    setNote(null);

    try {
      const res = await apiFetch(`channels/${channel}/connect`, {
        method: "POST",
        body: JSON.stringify({
          secret,
          config: channel === "whatsapp" ? { phoneNumberId } : {},
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; webhookNote?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not connect");

      setSecret("");
      setPhoneNumberId("");
      setOpen(null);
      setNote(body?.webhookNote ?? null);
      await load();
      onConnected?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">Connect a channel</h1>
      <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
        This is what turns the twin on. Until a channel is connected, nothing reaches it except your own tests.
      </p>

      <ul className="mt-8 space-y-2.5">
        {rows.map((row) => {
          // Webchat needs no secret and is never "disconnected" — the widget
          // IS the transport, so it works the instant the workspace exists.
          // What the operator needs here is the install snippet, not a
          // credential form, so this channel gets its own card body below
          // instead of falling into the connect/secret flow the rest use.
          if (row.channel === "webchat") {
            return (
              <li key={row.channel} className="rounded-2xl border border-line bg-surface">
                <div className="flex flex-wrap items-center gap-3 p-5">
                  <div className="min-w-0">
                    <p className="text-[0.9375rem] font-medium">{LABELS.webchat}</p>
                    <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                      A chat bubble for your own website. Paste one script tag, nothing to authenticate.
                    </p>
                  </div>
                  <span className="ml-auto inline-flex items-center gap-2 text-[0.75rem] text-teal">
                    <span className="size-1.5 rounded-full bg-teal-mark" aria-hidden />
                    Ready
                  </span>
                </div>
                <div className="space-y-2.5 border-t border-line p-5">
                  <label htmlFor="webchat-snippet" className="text-[0.75rem] text-ink-subtle">
                    Paste this before <code>&lt;/body&gt;</code> on your site:
                  </label>
                  <textarea
                    id="webchat-snippet"
                    readOnly
                    value={row.installSnippet ?? ""}
                    rows={2}
                    onFocus={(e) => e.currentTarget.select()}
                    className={`${field} h-auto resize-none rounded-2xl py-3 font-mono text-[0.75rem] leading-relaxed`}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    chevron={false}
                    onClick={() => row.installSnippet && copySnippet(row.installSnippet)}
                  >
                    {copied ? "Copied" : "Copy snippet"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    The workspace id in that URL is meant to be public — it is how the widget knows which
                    twin to talk to, the same way a Stripe publishable key works.
                  </p>
                </div>
              </li>
            );
          }

          const connected = row.status === "connected";
          return (
            <li key={row.channel} className="rounded-2xl border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-3 p-5">
                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-medium">{LABELS[row.channel] ?? row.channel}</p>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                    {connected
                      ? `Connected as ${row.displayName ?? "…"}`
                      : row.supported
                        ? row.credentialLabel
                        : "No integration yet. You can still pick it later."}
                  </p>
                </div>

                <span className="ml-auto">
                  {connected ? (
                    <span className="inline-flex items-center gap-2 text-[0.75rem] text-teal">
                      <span className="size-1.5 rounded-full bg-teal-mark" aria-hidden />
                      Live
                    </span>
                  ) : row.supported ? (
                    <Button size="sm" variant="secondary" chevron={false}
                      onClick={() => { setOpen(open === row.channel ? null : row.channel); setError(null); }}>
                      {open === row.channel ? "Cancel" : "Connect"}
                    </Button>
                  ) : (
                    <span className="text-[0.6875rem] uppercase tracking-wide text-ink-subtle">soon</span>
                  )}
                </span>
              </div>

              {open === row.channel ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <input
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={row.credentialLabel ?? "Token"}
                    autoComplete="off"
                    spellCheck={false}
                    className={field}
                  />
                  {row.channel === "whatsapp" ? (
                    <input
                      value={phoneNumberId}
                      onChange={(e) => setPhoneNumberId(e.target.value)}
                      placeholder="Phone number ID"
                      autoComplete="off"
                      spellCheck={false}
                      className={field}
                    />
                  ) : null}
                  <Button size="sm" disabled={busy || secret.trim().length < 8} onClick={() => connect(row.channel)}>
                    {busy ? "Checking…" : "Check and connect"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    We verify this with {LABELS[row.channel]} before saving it, and store it encrypted.
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
