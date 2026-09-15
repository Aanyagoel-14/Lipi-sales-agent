"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DataOnboarding } from "@/components/data-onboarding";
import { apiFetch } from "@/lib/client";
import { createWorkspace, WORKSPACE_COOKIE, WORKSPACE_ID_COOKIE, type Provisioned, type Vertical, type WorkspaceDraft } from "@/lib/onboarding";
import { DEFAULT_VOICE, type Voice } from "@/lib/twin-types";
import { policies, stepTitles, verticals } from "./steps";
import { ChannelsStep } from "./steps/channels-step";
import { KnowledgeStep } from "./steps/knowledge-step";
import { VoiceStep } from "./steps/voice-step";
import { TwinPreview } from "./twin-preview";

const LAST = stepTitles.length - 1;
/** The workspace must exist before its real data or channels can be attached. */
const CREATE_AFTER = 1;

const option =
  "w-full cursor-pointer rounded-2xl border p-5 text-left transition-[border-color,background-color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet";
const on = "border-violet bg-violet-soft/40";
const off = "border-line bg-surface hover:border-line-strong";

export function Wizard({ resuming }: { resuming: boolean }) {
  const router = useRouter();

  // Resuming means the workspace already exists, so setup picks up at the
  // first step that configures it rather than asking for the name again.
  const [step, setStep] = useState(resuming ? CREATE_AFTER + 1 : 0);
  const [created, setCreated] = useState(resuming);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Provisioned | null>(null);
  const [connected, setConnected] = useState(0);
  const [dataProducts, setDataProducts] = useState(0);
  const [dataSource, setDataSource] = useState<"empty" | "csv" | "sample">("empty");

  const [draft, setDraft] = useState<WorkspaceDraft>({
    name: "", vertical: "apparel", channels: ["whatsapp"],
    approvalPolicy: "money_only", seedCatalogue: false,
  });
  const [voice, setVoice] = useState<Voice>(DEFAULT_VOICE);

  const set = <K extends keyof WorkspaceDraft>(key: K, value: WorkspaceDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const blocker = step === 0 && draft.name.trim().length < 2 ? "Give the workspace a name first" : null;

  /** Creating the workspace early is what lets later steps configure something real. */
  async function ensureWorkspace() {
    if (created) return true;
    setBusy(true);
    setError(null);
    try {
      const { workspace, provisioned } = await createWorkspace(draft);
      const year = "path=/; max-age=31536000; samesite=lax";
      document.cookie = `${WORKSPACE_ID_COOKIE}=${workspace.id}; ${year}`;
      document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(workspace.name)}; ${year}`;
      setBuilt(provisioned);
      setCreated(true);
      setVoice((v) => ({ ...v, signOff: `— ${workspace.name}` }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (step === CREATE_AFTER && !(await ensureWorkspace())) return;
    if (step === 4) await apiFetch("twin/voice", { method: "PUT", body: JSON.stringify(voice) }).catch(() => {});
    setStep((s) => s + 1);
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      if (!(await ensureWorkspace())) return;
      await apiFetch("workspaces/current", {
        method: "PATCH",
        body: JSON.stringify({ approvalPolicy: draft.approvalPolicy }),
      });
      const res = await apiFetch("workspaces/complete", { method: "POST" });
      if (!res.ok) throw new Error("Could not finish setup");
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[1fr_20rem] lg:gap-14">
      <div>
        <div className="mb-9">
          <p className="text-[0.75rem] text-ink-subtle">
            Step {step + 1} of {stepTitles.length} · {stepTitles[step]}
          </p>
          <ol className="mt-2.5 flex gap-1.5" aria-hidden>
            {stepTitles.map((title, i) => (
              <li key={title} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                i < step ? "bg-teal-mark" : i === step ? "bg-ink" : "bg-line"
              }`} />
            ))}
          </ol>
        </div>

        {step === 0 ? (
          <section>
            <h1 className="max-w-[18ch] text-[1.875rem] tracking-tight">What should we call your workspace?</h1>
            <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
              Usually the business name. It shows on every twin and every agent action.
            </p>
            <label htmlFor="ws-name" className="mb-1.5 mt-8 block text-[0.8125rem] text-ink-muted">Workspace name</label>
            <input id="ws-name" autoFocus value={draft.name} onChange={(e) => set("name", e.target.value)}
              placeholder="Nair Apparel"
              className="h-11 w-full max-w-sm rounded-full border border-line-strong bg-surface px-5 text-[0.9375rem] placeholder:text-ink-subtle focus-visible:border-violet focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet" />
          </section>
        ) : null}

        {step === 1 ? (
          <section>
            <h1 className="max-w-[18ch] text-[1.875rem] tracking-tight">What do you sell?</h1>
            <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
              This builds the product twin. The fields on each card are what it will actually create.
            </p>
            <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {verticals.map((v) => (
                <button key={v.id} type="button" onClick={() => set("vertical", v.id as Vertical)}
                  aria-pressed={draft.vertical === v.id} className={`${option} ${draft.vertical === v.id ? on : off}`}>
                  <span className="text-[0.9375rem] font-medium">{v.label}</span>
                  <span className="mt-1 block text-[0.8125rem] text-ink-muted">{v.blurb}</span>
                  <span className="mt-3 flex flex-wrap gap-1">
                    {v.twinFields.slice(0, 4).map((f) => (
                      <span key={f} className="rounded-full bg-chip px-2 py-0.5 font-mono text-[0.625rem] text-ink-muted">{f}</span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">Bring in your business data</h1>
            <p className="mb-7 mt-2.5 max-w-xl text-[0.9375rem] text-ink-muted">
              Start with your real catalogue, use sample products, or continue empty. Lipi will never create fake customers or activity.
            </p>
            <DataOnboarding compact initialProducts={dataProducts}
              onImported={(count, source) => { setDataProducts((n) => n + count); setDataSource(source); set("seedCatalogue", source === "sample"); }} />
          </section>
        ) : null}

        {step === 3 ? <ChannelsStep onConnected={() => setConnected((c) => c + 1)} /> : null}
        {step === 4 ? <VoiceStep voice={voice} onChange={setVoice} /> : null}
        {step === 5 ? <KnowledgeStep /> : null}

        {step === 6 ? (
          <section>
            <h1 className="max-w-[20ch] text-[1.875rem] tracking-tight">How much can agents do alone?</h1>
            <p className="mt-2.5 max-w-md text-[0.9375rem] text-ink-muted">
              Start strict. Loosen it once you have watched them work for a week.
            </p>
            <div className="mt-8 space-y-2.5">
              {policies.map((p) => (
                <button key={p.id} type="button" onClick={() => set("approvalPolicy", p.id)}
                  aria-pressed={draft.approvalPolicy === p.id}
                  className={`${option} ${draft.approvalPolicy === p.id ? on : off}`}>
                  <span className="text-[0.9375rem] font-medium">{p.label}</span>
                  <span className="mt-1 block text-[0.8125rem] text-ink-muted">{p.blurb}</span>
                  <span className="mt-2 block font-mono text-[0.6875rem] text-ink-subtle">{p.consequence}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-10 flex flex-wrap items-center gap-3">
          {step > 0 && !(resuming && step === CREATE_AFTER + 1) ? (
            <Button variant="secondary" chevron={false} onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</Button>
          ) : null}

          {step < LAST ? (
            <Button onClick={next} disabled={Boolean(blocker) || busy}>
              {busy ? "Working…" : step === CREATE_AFTER ? "Create workspace" : "Continue"}
            </Button>
          ) : (
            <Button onClick={finish} disabled={busy}>{busy ? "Finishing…" : "Open the dashboard"}</Button>
          )}

          {/* Everything past the name has a sensible default. */}
          {step > 0 && step < LAST ? (
            <button type="button" onClick={finish} disabled={busy}
              className="inline-flex min-h-11 cursor-pointer items-center text-[0.8125rem] text-ink-subtle underline underline-offset-4 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:opacity-50">
              Skip the rest, use defaults
            </button>
          ) : null}

          <p aria-live="polite" className="text-[0.8125rem]">
            {error ? <span className="text-magenta">{error}</span>
             : blocker ? <span className="text-ink-subtle">{blocker}</span>
             : built && step === CREATE_AFTER + 1
               ? <span className="text-teal">Built {built.products} products, {built.variants} variants.</span>
               : null}
          </p>
        </div>
      </div>

      <TwinPreview draft={draft} step={step + 1} connected={connected} dataProducts={dataProducts} dataSource={dataSource} />
    </div>
  );
}
