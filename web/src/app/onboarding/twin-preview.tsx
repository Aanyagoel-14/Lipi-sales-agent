import type { WorkspaceDraft } from "@/lib/onboarding";
import { policies, verticals } from "./steps";

/**
 * The signature of this flow: the twin assembling itself as the operator
 * answers. It reuses the mono event-trail device from the dashboard rather
 * than inventing a new one, so onboarding reads as the same product.
 */
export function TwinPreview({ draft, step, connected, dataProducts, dataSource }: {
  draft: WorkspaceDraft; step: number; connected: number; dataProducts: number;
  dataSource: "empty" | "csv" | "sample";
}) {
  const vertical = verticals.find((v) => v.id === draft.vertical)!;
  const policy = policies.find((p) => p.id === draft.approvalPolicy)!;
  const named = draft.name.trim().length >= 2;

  const trail = [
    named ? ["workspace.created", `name="${draft.name.trim()}"`] : null,
    step >= 2 ? ["twin.shaped", `vertical=${draft.vertical} fields=${vertical.twinFields.length}`] : null,
    step >= 3 ? ["catalogue.ready", dataProducts ? `${dataProducts} products source=${dataSource}` : "empty, awaiting data"] : null,
    connected > 0 ? ["channel.connected", `${connected} live`] : null,
    step >= 5 ? ["voice.set", "phrasing configured"] : null,
    step >= 6 ? ["knowledge.opened", "only confirmed facts are learned"] : null,
    step >= 7 ? ["policy.set", draft.approvalPolicy] : null,
  ].filter(Boolean) as [string, string][];

  return (
    <aside className="lg:sticky lg:top-8">
      <div className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[0.875rem] font-medium">Your twin, so far</h2>
          <span className="ml-auto font-mono text-[0.6875rem] text-ink-subtle">
            {trail.length}/7
          </span>
        </div>

        <dl className="mt-5 space-y-4">
          <Field label="Workspace" filled={named}>
            {named ? draft.name.trim() : "Not named yet"}
          </Field>

          <Field label="Product twin" filled={step >= 2}>
            {step >= 2 ? (
              <>
                <span className="block">{vertical.label}</span>
                <span className="mt-2 flex flex-wrap gap-1">
                  {vertical.twinFields.map((f) => (
                    <span key={f} className="rounded-full bg-violet-soft px-2 py-0.5 font-mono text-[0.6875rem] text-violet-ink">
                      {f}
                    </span>
                  ))}
                </span>
              </>
            ) : (
              "Waiting on a vertical"
            )}
          </Field>

          <Field label="Business data" filled={dataProducts > 0}>
            {dataProducts > 0
              ? `${dataProducts} product${dataProducts === 1 ? "" : "s"} · ${dataSource === "csv" ? "imported" : "sample"}`
              : step >= 3 ? "Empty by choice" : "Not reached yet"}
          </Field>

          <Field label="Channels" filled={connected > 0}>
            {connected > 0
              ? `${connected} connected and receiving`
              : step >= 4
                ? "None connected yet"
                : "Not reached yet"}
          </Field>

          <Field label="Voice" filled={step >= 5}>
            {step >= 5 ? "Configured" : "Not set"}
          </Field>

          <Field label="Approvals" filled={step >= 7}>
            {step >= 7 ? policy.label : "Not set"}
          </Field>
        </dl>
      </div>

      {trail.length ? (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-5">
          <p className="mb-3 font-mono text-[0.6875rem] text-ink-subtle">twin_events</p>
          <ul className="space-y-1.5 font-mono text-[0.6875rem]">
            {trail.map(([type, payload]) => (
              <li key={type} className="flex gap-2">
                <span className="text-violet-ink">{type}</span>
                <span className="min-w-0 truncate text-ink-muted">{payload}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

function Field({ label, filled, children }: { label: string; filled: boolean; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.6875rem] text-ink-subtle">{label}</dt>
      <dd className={`mt-0.5 text-[0.8125rem] ${filled ? "text-ink" : "text-ink-subtle italic"}`}>{children}</dd>
    </div>
  );
}
