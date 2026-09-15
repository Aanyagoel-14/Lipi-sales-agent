import { PageHead, Tag } from "@/components/dash/ui";
import { DEFAULT_VOICE, getTraining, getWorkspace } from "@/lib/train";
import { TestConsole } from "./console";
import { KnowledgePanel } from "./knowledge-panel";
import { VoiceForm } from "./voice-form";
import { PolicyForm } from "./policy-form";

export const metadata = { title: "Train the twin · Lipi AI" };

const policyLabel = {
  everything: "Every reply is held for review",
  money_only: "Anything with money is held for review",
  nothing: "Agents reply without waiting",
} as const;

export default async function TrainPage() {
  const [workspace, training] = await Promise.all([getWorkspace(), getTraining()]);

  const checks = workspace ? [
    { label: "Business data", done: workspace._count.products > 0, href: "/dashboard/data" },
    { label: "Knowledge", done: workspace._count.knowledge > 0, href: "#knowledge" },
    { label: "Reply examples", done: workspace._count.examples > 0, href: "#knowledge" },
    { label: "Channel", done: workspace._count.connections > 0, href: "/dashboard/channels" },
  ] : [];
  const completed = checks.filter((check) => check.done).length;
  const trained = Boolean(workspace && workspace._count.products && workspace._count.knowledge && workspace._count.examples);

  return (
    <>
      <PageHead
        title="Train the twin"
        blurb="Voice governs how it speaks. Knowledge governs what it may claim. They are separate on purpose: sounding right while saying something false is worse than being blunt."
      />

      {workspace ? (
        <div className="mb-6 rounded-2xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[0.875rem] font-medium">Training readiness</span>
            <Tag tone={completed === checks.length ? "teal" : "amber"}>{completed}/{checks.length} ready</Tag>
            <span className="ml-auto text-[0.75rem] text-ink-muted">{policyLabel[workspace.approvalPolicy]}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {checks.map((check, index) => (
              <a key={check.label} href={check.href} className={`rounded-xl p-3 text-[0.75rem] ${check.done ? "bg-teal/10 text-teal" : "bg-chip text-ink-muted"}`}>
                <span className="font-mono">{index + 1}</span> · {check.label}<span className="float-right">{check.done ? "✓" : "→"}</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <section className="mb-6" id="voice">
        <p className="mb-1 font-mono text-[0.6875rem] text-violet-ink">STEP 1</p>
        <h2 className="mb-3 text-[1.0625rem]">Set the voice</h2>
        <VoiceForm initial={workspace?.voice ?? DEFAULT_VOICE} />
      </section>

      <section className="mb-6 scroll-mt-20" id="knowledge">
        <p className="mb-1 font-mono text-[0.6875rem] text-violet-ink">STEP 2</p>
        <h2 className="mb-3 text-[1.0625rem]">Teach facts and examples</h2>
        <KnowledgePanel entries={training.knowledge} examples={training.examples} />
      </section>

      <section className="mb-6">
        <p className="mb-1 font-mono text-[0.6875rem] text-violet-ink">STEP 3</p>
        <h2 className="mb-3 text-[1.0625rem]">Evaluate safely</h2>
        <TestConsole />
      </section>

      {workspace ? (
        <section>
          <p className="mb-1 font-mono text-[0.6875rem] text-violet-ink">STEP 4</p>
          <h2 className="mb-3 text-[1.0625rem]">Choose autonomy</h2>
          <PolicyForm initial={workspace.approvalPolicy} ready={trained} />
        </section>
      ) : null}
    </>
  );
}
