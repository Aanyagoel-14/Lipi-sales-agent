"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/dash/ui";
import { apiFetch, apiJson } from "@/lib/client";
import { timeOf } from "@/lib/dash-types";

type Connector = {
  id: string; source: string; name: string; status: string; cursor: string | null;
  lastSyncIso: string | null; lastError: string | null;
  appliedCount: number; failedCount: number; mappings: number;
  openExceptions: number; stale: boolean; healthy: boolean;
};

type Coverage = { mappedVariants: number; totalVariants: number; unmappedVariants: number };

type Exception = {
  id: string; kind: string; externalSku: string; detail: string;
  raisedIso: string; connectorId: string; connectorName: string; source: string;
};

type VariantChoice = { id: string; label: string };

const SOURCES = [
  { id: "shopify", label: "Shopify" },
  { id: "woocommerce", label: "WooCommerce" },
  { id: "zoho", label: "Zoho Inventory" },
  { id: "erp", label: "ERP" },
  { id: "pos", label: "POS" },
  { id: "custom", label: "Custom / in-house" },
] as const;

const KIND_LABELS: Record<string, string> = {
  unmapped_sku: "SKU not mapped",
  ambiguous_sku: "Sent twice in one batch",
  unknown_variant: "Variant not in this workspace",
  invalid_quantity: "Not a usable count",
  below_reserved: "Below what is reserved",
};

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

/**
 * The inventory connector, from the operator's side.
 *
 * A connector fails quietly: a token expires, a SKU stops matching, and stock
 * keeps looking plausible while it drifts. So health, staleness, coverage and
 * the exception queue are all on one screen — what is wrong, and what to click
 * to fix it.
 */
export function ConnectorPanel({ variants }: { variants: VariantChoice[] }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [source, setSource] = useState<string>(SOURCES[0].id);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ secret: string; pushUrl: string } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Health and the queue are one read as far as the operator is concerned:
   * a connector is not fine because it returned 200 if rows are piling up. */
  const load = () =>
    Promise.all([
      apiJson<{ connectors: Connector[]; coverage: Coverage }>("inventory/connectors"),
      apiJson<{ exceptions: Exception[] }>("inventory/exceptions"),
    ])
      .then(([health, queue]) => {
        setConnectors(health.connectors);
        setCoverage(health.coverage);
        setExceptions(queue.exceptions);
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
      const body = await apiJson<{ secret: string; connector: { pushUrl: string } }>(
        "inventory/connectors",
        { method: "POST", body: JSON.stringify({ source, name: name.trim() }) },
      );
      // Shown once, because the token is only ever stored hashed.
      setIssued({ secret: body.secret, pushUrl: body.connector.pushUrl });
      setName("");
    });

  const rotate = (id: string) =>
    act(async () => {
      const body = await apiJson<{ secret: string; connector: { pushUrl: string } }>(
        `inventory/connectors/${id}/rotate`,
        { method: "POST" },
      );
      setIssued({ secret: body.secret, pushUrl: body.connector.pushUrl });
    });

  const disconnect = (id: string) =>
    act(async () => {
      const res = await apiFetch(`inventory/connectors/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("Could not remove that connector");
    });

  const resolve = (exception: Exception, action: "map" | "dismiss") =>
    act(async () => {
      await apiJson(`inventory/exceptions/${exception.id}/resolve`, {
        method: "POST",
        body: JSON.stringify(
          action === "map" ? { action, variantId: choice[exception.id] } : { action },
        ),
      });
    });

  const taken = new Set(connectors.map((c) => c.source));
  const available = SOURCES.filter((s) => !taken.has(s.id));

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-xl bg-magenta/10 px-4 py-2.5 text-[0.8125rem] text-magenta">
          {error}
        </p>
      ) : null}

      {coverage ? (
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-[0.875rem] font-medium">Coverage</h2>
          <p className="mt-1 text-[0.8125rem] text-ink-muted">
            {coverage.mappedVariants} of {coverage.totalVariants} variants are mapped to a live feed.
          </p>
          {coverage.unmappedVariants > 0 ? (
            <p className="mt-2.5 text-[0.8125rem] text-amber">
              {coverage.unmappedVariants} variant{coverage.unmappedVariants === 1 ? "" : "s"} still
              hold their import-day figure. They never appear in a sync, so they never look broken —
              the twin quotes them as if that number were current.
            </p>
          ) : (
            <p className="mt-2.5 text-[0.8125rem] text-teal">Every variant is covered by a connector.</p>
          )}
        </section>
      ) : null}

      {issued ? (
        <section className="rounded-2xl border border-violet bg-violet-soft/40 p-5">
          <h2 className="text-[0.875rem] font-medium">Point your system here</h2>
          <p className="mt-1 text-[0.8125rem] text-ink-muted">
            This token is shown once and stored only as a hash. If you lose it, rotate for a new one.
          </p>
          <dl className="mt-4 space-y-3">
            <div>
              <dt className="text-[0.6875rem] text-ink-subtle">POST to</dt>
              <dd className="mt-0.5 break-all font-mono text-[0.75rem]">{issued.pushUrl}</dd>
            </div>
            <div>
              <dt className="text-[0.6875rem] text-ink-subtle">Authorization header</dt>
              <dd className="mt-0.5 break-all font-mono text-[0.75rem]">Bearer {issued.secret}</dd>
            </div>
            <div>
              <dt className="text-[0.6875rem] text-ink-subtle">Body</dt>
              <dd className="mt-0.5 overflow-x-auto">
                <pre className="whitespace-pre font-mono text-[0.75rem] text-ink-muted">{`{
  "idempotencyKey": "<your batch id, retried verbatim>",
  "cursor": "<your position, handed back to you>",
  "rows": [{ "sku": "ACME-1", "stock": 12 }]
}`}</pre>
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[0.75rem] text-ink-subtle">
            Send absolute on-hand counts, not deltas: a re-sent absolute value corrects itself, a
            re-sent delta doubles.
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
          <h2 className="text-[0.875rem] font-medium">Connectors</h2>
        </header>

        {connectors.length === 0 ? (
          <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">
            No live feed yet. Stock is whatever the last import or manual correction said.
          </p>
        ) : (
          <ul className="divide-y divide-line/60">
            {connectors.map((c) => (
              <li key={c.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-[0.875rem] font-medium">{c.name}</p>
                  <span className="text-[0.75rem] text-ink-subtle">{c.source}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {c.healthy ? <Tag tone="teal">healthy</Tag> : null}
                    {c.stale ? <Tag tone="amber">{c.lastSyncIso ? "stale" : "never synced"}</Tag> : null}
                    {c.openExceptions > 0 ? (
                      <Tag tone="magenta">{c.openExceptions} needing attention</Tag>
                    ) : null}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-y-2 sm:grid-cols-4">
                  {[
                    ["Last sync", c.lastSyncIso ? timeOf(c.lastSyncIso) : "never"],
                    ["Cursor", c.cursor ?? "—"],
                    ["Corrections applied", String(c.appliedCount)],
                    ["Rows rejected", String(c.failedCount)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-[0.6875rem] text-ink-subtle">{k}</dt>
                      <dd className="min-w-0 truncate font-mono text-[0.75rem]">{v}</dd>
                    </div>
                  ))}
                </dl>

                {c.lastError ? <p className="mt-2.5 text-[0.75rem] text-amber">{c.lastError}</p> : null}

                <div className="mt-3.5 flex gap-2">
                  <Button variant="secondary" size="sm" chevron={false} disabled={busy} onClick={() => rotate(c.id)}>
                    Rotate token
                  </Button>
                  <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => disconnect(c.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {available.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-line px-5 py-4 sm:flex-row">
            <label htmlFor="inv-source" className="sr-only">Source system</label>
            <select
              id="inv-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={`${field} sm:w-52`}
            >
              {available.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <label htmlFor="inv-name" className="sr-only">Connector name</label>
            <input
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main store"
              className={field}
            />
            <Button size="sm" chevron={false} disabled={busy || name.trim().length < 2} onClick={create}>
              Add connector
            </Button>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-5 py-3">
          <h2 className="text-[0.875rem] font-medium">Exceptions</h2>
          <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
            Rows a connector could not apply. Until these are cleared, the stock they refer to is
            whatever it was before.
          </p>
        </header>

        {exceptions.length === 0 ? (
          <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">
            Nothing rejected. Every row the connectors sent was applied.
          </p>
        ) : (
          <ul className="divide-y divide-line/60">
            {exceptions.map((e) => (
              <li key={e.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="font-mono text-[0.8125rem] font-medium">{e.externalSku}</p>
                  <Tag tone="amber">{KIND_LABELS[e.kind] ?? e.kind}</Tag>
                  <span className="tabular ml-auto text-[0.6875rem] text-ink-subtle">
                    {timeOf(e.raisedIso)} · {e.connectorName}
                  </span>
                </div>
                <p className="mt-1 text-[0.8125rem] text-ink-muted">{e.detail}</p>

                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <label htmlFor={`map-${e.id}`} className="sr-only">
                    Variant for {e.externalSku}
                  </label>
                  <select
                    id={`map-${e.id}`}
                    value={choice[e.id] ?? ""}
                    onChange={(ev) => setChoice((c) => ({ ...c, [e.id]: ev.target.value }))}
                    className={`${field} sm:max-w-sm`}
                  >
                    <option value="">Map this SKU to…</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    chevron={false}
                    disabled={busy || !choice[e.id]}
                    onClick={() => resolve(e, "map")}
                  >
                    Map and resolve
                  </Button>
                  <Button variant="ghost" size="sm" chevron={false} disabled={busy} onClick={() => resolve(e, "dismiss")}>
                    Not something we sell
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
