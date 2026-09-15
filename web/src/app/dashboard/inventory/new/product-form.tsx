"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client";

export type Template = {
  vertical: string;
  axes: [string, string];
  suggestedOptionsA: string[];
  suggestedOptionsB: string[];
  categories: string[];
  attributeKeys: string[];
};

const field =
  "h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[0.875rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet";

/**
 * A product is a grid, not a row. The operator picks values on the two axes
 * their trade sells by, and every intersection becomes a sellable variant with
 * its own stock — which is what makes an availability answer possible at all.
 */
export function ProductForm({ template }: { template: Template }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState(template.categories[0] ?? "");
  const [priceInr, setPriceInr] = useState("");
  const [marginPct, setMarginPct] = useState("35");
  const [leadTimeDays, setLeadTimeDays] = useState("7");
  const [optionsA, setOptionsA] = useState<string[]>(template.suggestedOptionsA.slice(0, 3));
  const [optionsB, setOptionsB] = useState<string[]>(template.suggestedOptionsB.slice(0, 2));
  const [stock, setStock] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [axisA, axisB] = template.axes;
  const key = (a: string, b: string) => `${a}|||${b}`;

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const addCustom = (list: string[], set: (v: string[]) => void, raw: string) => {
    const v = raw.trim();
    if (v && !list.includes(v)) set([...list, v]);
  };

  const ready = name.trim().length >= 2 && priceInr !== "" && optionsA.length > 0 && optionsB.length > 0;

  async function save() {
    setBusy(true);
    setError(null);

    const variants = optionsB.flatMap((b) =>
      optionsA.map((a) => ({ optionA: a, optionB: b, stock: Number(stock[key(a, b)] ?? 0) || 0 })),
    );

    try {
      const res = await apiFetch("catalogue/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          category: category.trim() || "Uncategorised",
          axes: template.axes,
          priceInr: Number(priceInr),
          marginPct: Number(marginPct) || 0,
          leadTimeDays: Number(leadTimeDays) || 0,
          supplierId: null,
          attributes: {},
          variants,
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not save the product");

      router.push("/dashboard/inventory");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_18rem]">
      <div className="space-y-6 rounded-2xl border border-line bg-surface p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[0.8125rem] font-medium">Product name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Merino Crew" className={field} autoFocus />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[0.8125rem] font-medium">Category</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={template.categories[0]} className={field} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[0.8125rem] font-medium">Price (₹)</span>
            <input value={priceInr} onChange={(e) => setPriceInr(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="3200" className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[0.8125rem] font-medium">Margin %</span>
              <input value={marginPct} onChange={(e) => setMarginPct(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={field} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[0.8125rem] font-medium">Lead days</span>
              <input value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={field} />
            </label>
          </div>
        </div>

        <AxisPicker label={axisA} options={optionsA} suggestions={template.suggestedOptionsA}
          onToggle={(v) => toggle(optionsA, setOptionsA, v)} onAdd={(v) => addCustom(optionsA, setOptionsA, v)} />

        <AxisPicker label={axisB} options={optionsB} suggestions={template.suggestedOptionsB}
          onToggle={(v) => toggle(optionsB, setOptionsB, v)} onAdd={(v) => addCustom(optionsB, setOptionsB, v)} />

        {optionsA.length && optionsB.length ? (
          <div>
            <p className="text-[0.8125rem] font-medium">
              Stock <span className="ml-2 font-normal text-ink-subtle">{optionsA.length * optionsB.length} variants</span>
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="text-[0.8125rem]">
                <thead>
                  <tr>
                    <th className="pb-2 pr-4 text-left text-[0.6875rem] font-medium text-ink-subtle">{axisB}</th>
                    {optionsA.map((a) => (
                      <th key={a} className="whitespace-nowrap px-1 pb-2 text-center text-[0.6875rem] font-medium text-ink-subtle">{a}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {optionsB.map((b) => (
                    <tr key={b}>
                      <th scope="row" className="whitespace-nowrap py-1 pr-4 text-left font-medium">{b}</th>
                      {optionsA.map((a) => (
                        <td key={a} className="p-0.5">
                          <input
                            value={stock[key(a, b)] ?? ""}
                            onChange={(e) => setStock((s) => ({ ...s, [key(a, b)]: e.target.value.replace(/\D/g, "") }))}
                            inputMode="numeric"
                            placeholder="0"
                            aria-label={`Stock for ${a} ${b}`}
                            className="tabular h-9 w-16 rounded-md border border-line-strong bg-surface text-center text-[0.8125rem] focus-visible:border-violet focus-visible:outline-none"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Button onClick={save} disabled={!ready || busy}>
            {busy ? "Saving…" : "Add product"}
          </Button>
          <p aria-live="polite" className="text-[0.8125rem]">
            {error ? <span className="text-magenta">{error}</span>
             : !ready ? <span className="text-ink-subtle">Name, price and both axes are needed</span>
             : null}
          </p>
        </div>
      </div>

      <aside>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-[0.8125rem] font-medium">Why two axes</p>
          <p className="mt-2 text-[0.8125rem] text-ink-muted">
            Your trade sells on <b>{axisA}</b> and <b>{axisB}</b>. Stock lives at each intersection, so
            the twin can answer “do you have this one” instead of “we stock that product”.
          </p>
          <p className="mt-3 text-[0.75rem] text-ink-subtle">
            {optionsA.length} × {optionsB.length} = {optionsA.length * optionsB.length} sellable things
          </p>
        </div>
      </aside>
    </div>
  );
}

function AxisPicker({
  label, options, suggestions, onToggle, onAdd,
}: {
  label: string; options: string[]; suggestions: string[];
  onToggle: (v: string) => void; onAdd: (v: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <div>
      <p className="text-[0.8125rem] font-medium">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {[...new Set([...suggestions, ...options])].map((v) => {
          const on = options.includes(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => onToggle(v)}
              aria-pressed={on}
              className={`cursor-pointer rounded-full px-3 py-1.5 text-[0.8125rem] transition-colors ${
                on ? "bg-ink text-white" : "bg-chip text-ink-muted hover:text-ink"
              }`}
            >
              {v}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(draft); setDraft(""); } }}
          placeholder={`Add a ${label.toLowerCase()}`}
          className="h-9 flex-1 rounded-full border border-line-strong bg-surface px-4 text-[0.8125rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-none"
        />
        <Button variant="secondary" chevron={false} size="sm" className="h-9" onClick={() => { onAdd(draft); setDraft(""); }}>
          Add
        </Button>
      </div>
    </div>
  );
}
