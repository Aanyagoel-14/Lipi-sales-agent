"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CATALOGUE_COLUMNS, CATALOGUE_CSV_EXAMPLE, parseCatalogueCsv } from "@/lib/catalogue-import";
import { apiFetch } from "@/lib/client";

export function DataOnboarding({
  initialProducts = 0,
  compact = false,
  onImported,
}: {
  initialProducts?: number;
  compact?: boolean;
  onImported?: (products: number, source: "csv" | "sample") => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState(initialProducts);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ReturnType<typeof parseCatalogueCsv>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("products")
      .then((res) => res.ok ? res.json() : null)
      .then((body: { products?: unknown[] } | null) => {
        if (body?.products) setProducts(body.products.length);
      })
      .catch(() => {});
  }, []);

  async function choose(file?: File) {
    setError(null);
    setMessage(null);
    setRows([]);
    if (!file) return;
    try {
      const parsed = parseCatalogueCsv(await file.text());
      setFileName(file.name);
      setRows(parsed);
    } catch (e) {
      setFileName(file.name);
      setError((e as Error).message);
    }
  }

  async function importRows() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("catalogue/import", { method: "POST", body: JSON.stringify({ rows }) });
      const body = (await res.json().catch(() => null)) as { error?: string; imported?: { products: number; variants: number } } | null;
      if (!res.ok || !body?.imported) throw new Error(body?.error ?? "Could not import the catalogue");
      setProducts((count) => count + body.imported!.products);
      setMessage(`Imported ${body.imported.products} products and ${body.imported.variants} variants from ${fileName}.`);
      setRows([]);
      onImported?.(body.imported.products, "csv");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadSample() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("catalogue/seed", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string; products?: number } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not load the sample catalogue");
      const count = body?.products ?? 0;
      setProducts(count);
      setMessage(`Loaded ${count} clearly labelled sample products. No customers, orders or activity were created.`);
      onImported?.(count, "sample");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(CATALOGUE_CSV_EXAMPLE)}`;

  return (
    <div className={compact ? "space-y-4" : "grid gap-4 xl:grid-cols-[1.4fr_1fr]"}>
      <section className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="text-[0.9375rem] font-medium">Import your catalogue</h2>
            <p className="mt-1 max-w-xl text-[0.8125rem] text-ink-muted">
              One CSV row per sellable variant. We validate the whole file before writing anything.
            </p>
          </div>
          {products > 0 ? (
            <span className="ml-auto rounded-full bg-teal/10 px-3 py-1 font-mono text-[0.6875rem] text-teal">
              {products} product{products === 1 ? "" : "s"} ready
            </span>
          ) : null}
        </div>

        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only"
          onChange={(event) => void choose(event.target.files?.[0])} />
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" chevron={false} onClick={() => input.current?.click()} disabled={busy}>
            Choose CSV
          </Button>
          <a href={templateHref} download="lipi-catalogue-template.csv"
            className="inline-flex min-h-11 items-center rounded-full px-4 text-[0.8125rem] text-ink-muted underline underline-offset-4 hover:text-ink">
            Download template
          </a>
        </div>

        {fileName ? <p className="mt-3 text-[0.75rem] text-ink-subtle">{fileName}</p> : null}
        {rows.length ? (
          <div className="mt-4 rounded-xl bg-chip/60 p-4">
            <p className="text-[0.8125rem] font-medium">Ready to import {rows.length} variant rows</p>
            <p className="mt-1 text-[0.75rem] text-ink-muted">
              {[...new Set(rows.map((row) => row.product))].length} products · first row: {rows[0]!.product}, {rows[0]!.axisAValue} / {rows[0]!.axisBValue}
            </p>
            <Button className="mt-3" size="sm" onClick={importRows} disabled={busy}>
              {busy ? "Importing…" : "Import catalogue"}
            </Button>
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-[0.8125rem] text-magenta">{error}</p> : null}
        {message ? <p aria-live="polite" className="mt-3 text-[0.8125rem] text-teal">{message}</p> : null}
      </section>

      <aside className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="text-[0.9375rem] font-medium">Start another way</h2>
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-[0.8125rem] font-medium">Start empty</p>
            <p className="mt-1 text-[0.75rem] text-ink-muted">Continue without data. The dashboard will show setup guidance, never invented metrics.</p>
          </div>
          <div className="border-t border-line pt-4">
            <p className="text-[0.8125rem] font-medium">Explore with sample products</p>
            <p className="mt-1 text-[0.75rem] text-ink-muted">Adds catalogue and stock only. Sample data is identified as sample and creates no business activity.</p>
            <Button variant="secondary" chevron={false} size="sm" className="mt-3" onClick={loadSample} disabled={busy || products > 0}>
              Load sample catalogue
            </Button>
          </div>
        </div>
      </aside>

      {!compact ? (
        <section className="rounded-2xl border border-line bg-surface p-5 xl:col-span-2">
          <p className="text-[0.8125rem] font-medium">Required CSV columns</p>
          <p className="mt-2 break-words font-mono text-[0.6875rem] text-ink-muted">{CATALOGUE_COLUMNS.join(" · ")}</p>
        </section>
      ) : null}
    </div>
  );
}
