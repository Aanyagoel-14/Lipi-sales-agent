import { EmptyState, PageHead, Panel, Tag } from "@/components/dash/ui";
import { getModelSpend, num, type ModelPurpose } from "@/lib/dash";

export const metadata = { title: "Model spend · Lipi AI" };

/** What the purposes are called in the product, rather than in the schema. */
const PURPOSE_LABELS: Record<ModelPurpose, string> = {
  extract: "Reading customer intent",
  sell: "Voicing the salesperson",
  twin_chat: "Ask the twin",
};

function Meter({ label, used, ceiling }: { label: string; used: number; ceiling: number }) {
  // A ceiling of zero is the kill switch, not a division: nothing is left.
  const filled = ceiling > 0 ? Math.min(100, Math.round((used / ceiling) * 100)) : 100;
  const spent = used >= ceiling;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
        <span>{label}</span>
        <span className="ml-auto font-mono text-ink-muted">
          {num(used)} / {num(ceiling)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-chip">
        <div className={`h-full ${spent ? "bg-critical" : "bg-ink"}`} style={{ width: `${filled}%` }} />
      </div>
    </div>
  );
}

export default async function UsagePage() {
  const spend = await getModelSpend();

  return (
    <>
      <PageHead
        title="Model spend"
        blurb="Every language-model call this workspace makes, metered. Past a ceiling the twin keeps answering — from the verified template rather than from the model."
        action={spend.exhausted ? <Tag tone="critical">Budget spent</Tag> : <Tag tone="teal">Within budget</Tag>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={`Today, ${spend.day} UTC`}>
          <div className="grid gap-4">
            <Meter label="Calls" used={spend.today.calls} ceiling={spend.ceilings.dailyCalls} />
            <Meter label="Tokens" used={spend.today.tokens} ceiling={spend.ceilings.dailyTokens} />
            <p className="text-[0.8125rem] text-ink-muted">
              {spend.today.failed === 0
                ? "No call failed today."
                : `${num(spend.today.failed)} of those calls failed and were charged anyway — a call that times out still costs.`}{" "}
              One conversation may take {num(spend.ceilings.conversationCalls)} calls of the day&apos;s budget.
            </p>
          </div>
        </Panel>

        <Panel title="Where it went">
          {spend.byPurpose.length === 0 ? (
            <EmptyState
              title="Nothing spent today"
              body="The twin has not called a language model since midnight UTC."
              action={{ href: "/dashboard/storefront", label: "Send a test message" }}
            />
          ) : (
            <ul className="grid gap-3">
              {spend.byPurpose.map((row) => (
                <li key={row.purpose} className="flex flex-wrap items-baseline gap-x-3 text-[0.8125rem]">
                  <span>{PURPOSE_LABELS[row.purpose] ?? row.purpose}</span>
                  <span className="ml-auto font-mono text-ink-muted">
                    {num(row.calls)} calls · {num(row.tokens)} tokens
                    {row.failed > 0 ? ` · ${num(row.failed)} failed` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
