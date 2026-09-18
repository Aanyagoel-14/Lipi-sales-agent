"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

type PhoneNumber = { id: string; display?: string; verifiedName?: string };

type ChannelRow = {
  channel: string;
  label: string;
  connectKind: "link" | "api_key" | "none";
  inbound: { kind: string; reason?: string };
  available: boolean;
  unavailableReason: string | null;
  status: "disconnected" | "pending" | "connected" | "needs_reconnect" | "error";
  displayName: string | null;
  externalId: string | null;
  config: { phoneNumbers?: PhoneNumber[]; phoneNumberId?: string } | null;
  lastError: string | null;
  installSnippet: string | null;
};

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

const CHIPS: Record<string, { label: string; tone: string; mark: string }> = {
  connected: { label: "Live", tone: "text-teal", mark: "bg-teal-mark" },
  pending: { label: "Finishing on the provider", tone: "text-ink-muted", mark: "bg-ink-subtle" },
  needs_reconnect: { label: "Needs reconnecting", tone: "text-amber", mark: "bg-amber-mark" },
  error: { label: "Not working", tone: "text-magenta", mark: "bg-magenta-mark" },
};

/** What this channel will actually do once it is connected. */
function capability(row: ChannelRow): string {
  if (!row.available) return row.unavailableReason ?? "Not configured for this deployment";
  switch (row.inbound.kind) {
    case "webchat":
      return "A chat bubble for your own website. Paste one script tag, nothing to authenticate.";
    case "none":
      return row.inbound.reason ?? "Replies only";
    case "composio_trigger":
      return "New mail becomes a conversation, checked every few minutes";
    default:
      return "Customer messages become conversations, and the twin answers in the same thread";
  }
}

/**
 * Connecting a channel.
 *
 * There is nothing to paste here for most channels, and that is the point:
 * the operator presses Connect, finishes on the provider's own consent
 * screen, and comes back to a status that was checked rather than assumed.
 * Lipi stores no provider credential, so there is no token field, no webhook
 * URL to copy and no verify token to keep — the three things this step used
 * to ask for and could never show again afterwards.
 */
export function ChannelsStep({ onConnected }: { onConnected?: () => void }) {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scrolled = useRef(false);

  const load = () =>
    apiFetch("channels")
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((d: { channels: ChannelRow[] }) => setRows(d.channels))
      .catch(() => setRows([]));

  useEffect(() => { void load(); }, []);

  // The callback route returns the browser to `?channel=…`. Bring that card
  // into view, once, so a connection that failed is not missed below the fold.
  useEffect(() => {
    if (scrolled.current || !rows.length) return;
    const wanted = new URLSearchParams(window.location.search).get("channel");
    if (!wanted) return;
    scrolled.current = true;
    document.getElementById(`channel-${wanted}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [rows]);

  async function act<T>(channel: string, work: () => Promise<T>) {
    setBusy(channel);
    setError(null);
    setNote(null);
    try {
      return await work();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const failed = async (res: Response, fallback: string) => {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return new Error(payload?.error ?? fallback);
  };

  async function connect(row: ChannelRow) {
    await act(row.channel, async () => {
      const res = await apiFetch(`channels/${row.channel}/connect`, {
        method: "POST",
        ...(row.connectKind === "api_key" ? { body: JSON.stringify({ token }) } : {}),
      });
      if (!res.ok) throw await failed(res, "Could not start the connection");
      const data = (await res.json()) as { redirectUrl: string | null };

      // The provider's consent screen is the next step, and it is a full page
      // navigation: the operator comes back through /v1/channels/callback.
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
        return;
      }
      setToken("");
      setOpen(null);
      await load();
      onConnected?.();
    });
  }

  async function disconnect(channel: string) {
    await act(channel, async () => {
      const res = await apiFetch(`channels/${channel}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw await failed(res, "Could not disconnect");
      await load();
    });
  }

  async function check(channel: string) {
    await act(channel, async () => {
      const res = await apiFetch(`channels/${channel}/test`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        { ok?: boolean; displayName?: string; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error ?? "That connection did not answer");
      setNote(`Answered as ${data.displayName}`);
      await load();
    });
  }

  async function pickNumber(channel: string, phoneNumberId: string) {
    await act(channel, async () => {
      const res = await apiFetch(`channels/${channel}`, {
        method: "PATCH",
        body: JSON.stringify({ phoneNumberId }),
      });
      if (!res.ok) throw await failed(res, "Could not save that number");
      await load();
    });
  }

  return (
    <section>
      <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">Connect a channel</h1>
      <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
        This is what turns the twin on. Until a channel is connected, nothing reaches it except your own tests.
      </p>

      <ul className="mt-8 space-y-2.5">
        {rows.map((row) => {
          const chip = CHIPS[row.status];
          const numbers = row.config?.phoneNumbers ?? [];
          const mustPickNumber = row.status === "connected" && numbers.length > 1;
          const working = busy === row.channel;

          return (
            <li key={row.channel} id={`channel-${row.channel}`} className="rounded-2xl border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-3 p-5">
                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-medium">{row.label}</p>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                    {row.status === "connected" && row.displayName
                      ? `Connected as ${row.displayName}`
                      : capability(row)}
                  </p>
                  {row.lastError ? (
                    <p className="mt-1 text-[0.75rem] text-magenta">{row.lastError}</p>
                  ) : null}
                </div>

                <span className="ml-auto flex items-center gap-2">
                  {chip ? (
                    <span className={`inline-flex items-center gap-2 text-[0.75rem] ${chip.tone}`}>
                      <span className={`size-1.5 rounded-full ${chip.mark}`} aria-hidden />
                      {chip.label}
                    </span>
                  ) : null}

                  {row.connectKind === "none" || !row.available ? null : row.status === "connected" ? (
                    <>
                      <Button size="sm" variant="ghost" chevron={false} disabled={working}
                        onClick={() => check(row.channel)}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" chevron={false} disabled={working}
                        onClick={() => disconnect(row.channel)}>
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" chevron={false} disabled={working}
                        onClick={() => {
                          if (row.connectKind === "api_key") {
                            setOpen(open === row.channel ? null : row.channel);
                            setError(null);
                          } else {
                            void connect(row);
                          }
                        }}>
                        {working ? "Working…"
                          : open === row.channel ? "Cancel"
                            : row.status === "disconnected" ? "Connect" : "Reconnect"}
                      </Button>
                      {row.status === "disconnected" ? null : (
                        <Button size="sm" variant="ghost" chevron={false} disabled={working}
                          onClick={() => disconnect(row.channel)}>
                          Disconnect
                        </Button>
                      )}
                    </>
                  )}
                </span>
              </div>

              {row.installSnippet ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <label htmlFor="webchat-snippet" className="text-[0.75rem] text-ink-subtle">
                    Paste this before <code>&lt;/body&gt;</code> on your site:
                  </label>
                  <textarea
                    id="webchat-snippet"
                    readOnly
                    value={row.installSnippet}
                    rows={2}
                    onFocus={(e) => e.currentTarget.select()}
                    className={`${field} h-auto resize-none rounded-2xl py-3 font-mono text-[0.75rem] leading-relaxed`}
                  />
                  <Button size="sm" variant="secondary" chevron={false}
                    onClick={() => copy(row.installSnippet!, setCopied)}>
                    {copied ? "Copied" : "Copy snippet"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    The workspace id in that URL is meant to be public — it is how the widget knows which
                    twin to talk to, the same way a Stripe publishable key works.
                  </p>
                </div>
              ) : null}

              {open === row.channel && row.connectKind === "api_key" ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Bot token from @BotFather"
                    autoComplete="off"
                    spellCheck={false}
                    className={field}
                  />
                  <Button size="sm" disabled={working || token.trim().length < 20}
                    onClick={() => connect(row)}>
                    {working ? "Checking…" : "Check and connect"}
                  </Button>
                  <p className="text-[0.75rem] text-ink-subtle">
                    The token goes straight to our connection provider. Lipi does not keep a copy.
                  </p>
                </div>
              ) : null}

              {mustPickNumber ? (
                <div className="space-y-2.5 border-t border-line p-5">
                  <label htmlFor={`number-${row.channel}`} className="text-[0.75rem] text-ink-subtle">
                    This account has more than one number. Which one do customers message?
                  </label>
                  <select
                    id={`number-${row.channel}`}
                    value={row.config?.phoneNumberId ?? ""}
                    disabled={working}
                    onChange={(e) => pickNumber(row.channel, e.target.value)}
                    className={field}
                  >
                    <option value="" disabled>Choose a number</option>
                    {numbers.map((number) => (
                      <option key={number.id} value={number.id}>
                        {number.display || number.id}{number.verifiedName ? ` — ${number.verifiedName}` : ""}
                      </option>
                    ))}
                  </select>
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

async function copy(snippet: string, setCopied: (value: boolean) => void) {
  try {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  } catch {
    // Clipboard permission denied or unavailable (e.g. non-HTTPS local
    // testing) — the snippet is still visible and selectable by hand.
  }
}
