"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiJson } from "@/lib/client";
import { dayOf } from "@/lib/dash-types";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ("read" | "write")[];
  createdIso: string;
  lastUsedIso: string | null;
  expiresIso: string | null;
  revokedIso: string | null;
};

const SCOPES = [
  { id: "read", label: "Read only", note: "GET requests. Nothing it sends can change a row." },
  { id: "write", label: "Read and write", note: "Everything the dashboard can do, except managing keys." },
] as const;

const EXPIRIES = [
  { days: 0, label: "No expiry" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "One year" },
] as const;

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

/** Live, expired and revoked are three different answers to "can I call with this". */
function statusOf(key: ApiKey): { label: string; tone: "teal" | "amber" | "neutral" } {
  if (key.revokedIso) return { label: "revoked", tone: "neutral" };
  if (key.expiresIso && new Date(key.expiresIso) <= new Date()) return { label: "expired", tone: "amber" };
  return { label: "live", tone: "teal" };
}

/**
 * API keys, from the operator's side.
 *
 * The one thing this screen has to get right is the moment of creation: the
 * secret exists in this response and nowhere else afterwards, because only its
 * hash is stored. So it is shown once, in full, next to the request that uses
 * it — and the operator has to dismiss it deliberately.
 */
export function ApiKeyPanel({ baseUrl }: { baseUrl: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [expiryDays, setExpiryDays] = useState(0);
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    apiJson<{ keys: ApiKey[] }>("api-keys")
      .then((body) => setKeys(body.keys))
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
      const body = await apiJson<{ key: ApiKey; secret: string }>("api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          scopes: [scope],
          ...(expiryDays ? { expiresInDays: expiryDays } : {}),
        }),
      });
      setIssued({ secret: body.secret, name: body.key.name });
      setName("");
    });

  const revoke = (key: ApiKey) =>
    act(async () => {
      await apiJson(`api-keys/${key.id}`, { method: "DELETE" });
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
          <h2 className="text-[0.875rem] font-medium">Copy “{issued.name}” now</h2>
          <p className="mt-1 text-[0.8125rem] text-ink-muted">
            This is the only time the key is shown. Lipi stores a hash of it, so nobody — including
            us — can read it back. If it is lost, revoke it and make another.
          </p>
          <p className="mt-4 break-all rounded-xl bg-surface px-4 py-3 font-mono text-[0.8125rem]">
            {issued.secret}
          </p>
          <div className="mt-4">
            <p className="text-[0.6875rem] text-ink-subtle">Send it on every request</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[0.75rem] text-ink-muted">{`curl ${baseUrl}/v1/products \\
  -H "Authorization: Bearer ${issued.secret}"`}</pre>
          </div>
          <p className="mt-3 text-[0.75rem] text-ink-subtle">
            Send the key or a signed-in browser session, never both in one request — a call
            carrying both is refused rather than guessed at.
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
          <h2 className="text-[0.875rem] font-medium">Keys</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
            A key reaches only this workspace, and only the scope it was made with. Revoked keys
            stay listed: what called with them, and until when, is worth keeping.
          </p>
        </header>

        {keys.length === 0 ? (
          <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">
            No keys yet. Everything calling Lipi today is doing it from a signed-in browser.
          </p>
        ) : (
          <ul className="divide-y divide-line/60">
            {keys.map((key) => {
              const status = statusOf(key);
              const writes = key.scopes.includes("write");
              return (
                <li key={key.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="text-[0.875rem] font-medium">{key.name}</p>
                    <span className="font-mono text-[0.75rem] text-ink-subtle">{key.prefix}…</span>
                    <span className="ml-auto flex flex-wrap items-center gap-2">
                      <Tag tone={writes ? "violet" : "neutral"}>{writes ? "read + write" : "read"}</Tag>
                      <Tag tone={status.tone}>{status.label}</Tag>
                    </span>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-y-2 sm:grid-cols-4">
                    {[
                      ["Created", dayOf(key.createdIso)],
                      ["Last used", key.lastUsedIso ? dayOf(key.lastUsedIso) : "never"],
                      ["Expires", key.expiresIso ? dayOf(key.expiresIso) : "never"],
                      ["Revoked", key.revokedIso ? dayOf(key.revokedIso) : "—"],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[0.6875rem] text-ink-subtle">{k}</dt>
                        <dd className="min-w-0 truncate font-mono text-[0.75rem]">{v}</dd>
                      </div>
                    ))}
                  </dl>

                  {key.revokedIso ? null : (
                    <div className="mt-3.5">
                      <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => revoke(key)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-t border-line px-5 py-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="key-name" className="sr-only">What will use this key</label>
            <input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Storefront backend"
              className={field}
            />
            <label htmlFor="key-scope" className="sr-only">Scope</label>
            <select
              id="key-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "read" | "write")}
              className={`${field} sm:w-48`}
            >
              {SCOPES.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="key-expiry" className="sr-only">Expiry</label>
            <select
              id="key-expiry"
              value={expiryDays}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
              className={`${field} sm:w-40`}
            >
              {EXPIRIES.map((expiry) => (
                <option key={expiry.days} value={expiry.days}>{expiry.label}</option>
              ))}
            </select>
            <Button size="sm" chevron={false} disabled={busy || name.trim().length < 2} onClick={create}>
              Create key
            </Button>
          </div>
          <p className="mt-2.5 text-[0.75rem] text-ink-subtle">
            {SCOPES.find((s) => s.id === scope)!.note}
          </p>
        </div>
      </section>
    </div>
  );
}
