import { VolumeChart, IntentChart } from "@/components/dash/charts";
import { ChannelDot, EmptyState, PageHead, Panel, Status, Tag } from "@/components/dash/ui";
import { channelLabel, channelSlot, getOverview, inr, num, timeOf, type Kpi } from "@/lib/dash";
import { getWorkspace } from "@/lib/train";

export const metadata = { title: "Overview · Lipi AI" };

function KpiTile({ kpi }: { kpi: Kpi }) {
  const value =
    kpi.unit === "inr" ? inr(kpi.value) : kpi.unit === "pct" ? `${kpi.value}%` : num(kpi.value);
  const up = (kpi.deltaPct ?? 0) >= 0;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-[0.75rem] leading-snug text-ink-subtle">{kpi.label}</p>
      <p className="tabular mt-2 text-[1.5rem] leading-none tracking-tight sm:text-[1.75rem]">{value}</p>
      {kpi.deltaPct === null ? (
        <p className="mt-2 text-[0.75rem] text-ink-subtle">no prior week yet</p>
      ) : (
        <p className={`tabular mt-2 text-[0.75rem] ${up ? "text-teal" : "text-magenta"}`}>
          {up ? "▲" : "▼"} {Math.abs(kpi.deltaPct)}% vs last week
        </p>
      )}
    </div>
  );
}

export default async function OverviewPage() {
  const [data, workspace] = await Promise.all([getOverview(), getWorkspace()]);
  const isEmpty = Boolean(workspace && workspace._count.products === 0 && workspace._count.customers === 0);

  // Runs still waiting on a human, then ones that failed: what an operator
  // would act on first, out of the recent runs the overview carries.
  const held = [
    ...data.recentRuns.filter((r) => r.status === "needs_approval"),
    ...data.recentRuns.filter((r) => r.status === "failed"),
  ];

  return (
    <>
      <PageHead
        title="Overview"
        blurb="What the twins learned today, and what the agents did about it."
      />

      {isEmpty ? (
        <div className="space-y-4">
          <EmptyState
            title="Your Twin is ready for its first data"
            body="This workspace contains no products, customers, orders or conversations. Nothing is hidden and no sample activity has been substituted for real data."
            action={{ href: "/dashboard/data", label: "Onboard your data" }}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              ["1", "Add business data", "Import a catalogue CSV or add the first product manually.", "/dashboard/data", "Open data onboarding"],
              ["2", "Train the Twin", "Confirm policies, add reply examples and evaluate safely.", "/dashboard/train", "Start training"],
              ["3", "Connect a channel", "Let real customer conversations begin updating the Twin.", "/dashboard/channels", "Connect a channel"],
            ].map(([number, title, body, href, label]) => (
              <a key={number} href={href} className="rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-line-strong">
                <span className="font-mono text-[0.6875rem] text-violet-ink">STEP {number}</span>
                <h2 className="mt-3 text-[0.9375rem] font-medium">{title}</h2>
                <p className="mt-1 text-[0.8125rem] text-ink-muted">{body}</p>
                <p className="mt-4 text-[0.75rem] font-medium text-ink">{label} →</p>
              </a>
            ))}
          </div>
        </div>
      ) : (
      <>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        {data.kpis.map((kpi) => (
          <KpiTile key={kpi.id} kpi={kpi} />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Conversations per day by channel">
          <VolumeChart days={data.volume.days} series={data.volume.series} />
        </Panel>

        <Panel title="What customers are asking for">
          <IntentChart data={data.intentMix} />
          <p className="mt-4 text-[0.75rem] text-ink-subtle">
            Extracted intent across all channels, last 14 days.
          </p>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr_1fr]">
        <Panel title="Needs your approval" action={<Tag tone="amber">{data.pendingApprovals} waiting</Tag>} bodyClassName="">
          {/* The tag counts every open approval; this list only shows ones among
              the recent runs. An empty box under "1 waiting" reads as broken, so
              it says where the rest are. */}
          {held.length === 0 ? (
            <p className="px-5 py-4 text-[0.8125rem] text-ink-muted">
              {data.pendingApprovals > 0
                ? "Nothing in the last few runs. See the approvals queue for the rest."
                : "Nothing waiting on you."}
            </p>
          ) : (
          <ul className="divide-y divide-line/60">
            {held
              .slice(0, 4)
              .map((run) => (
                <li key={run.id} className="px-5 py-3">
                  <div className="flex items-baseline gap-2">
                    <p className="text-[0.8125rem] font-medium">{run.agent}</p>
                    <span className="ml-auto"><Status status={run.status} /></span>
                  </div>
                  <p className="mt-0.5 text-[0.8125rem] text-ink-muted">{run.action}</p>
                </li>
              ))}
          </ul>
          )}
        </Panel>

        <Panel title="Stock about to run out" bodyClassName="">
          <ul className="divide-y divide-line/60">
            {data.lowStock.slice(0, 6).map((s) => (
              <li key={`${s.product}-${s.variant}`} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="min-w-0 truncate text-[0.8125rem]">{s.product}</p>
                  <p className="text-[0.75rem] text-ink-subtle">{s.variant}</p>
                </div>
                <span className="ml-auto">
                  <Tag tone={s.stock === 0 ? "magenta" : "amber"}>
                    {s.stock === 0 ? "out of stock" : `${s.stock} left`}
                  </Tag>
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Twin events" action={<span className="font-mono text-[0.6875rem] text-ink-subtle">live</span>} bodyClassName="">
          <ul className="divide-y divide-line/60">
            {data.recentEvents.map((e) => (
              <li key={e.id} className="px-5 py-2.5 font-mono text-[0.6875rem]">
                <div className="flex gap-2">
                  <span className="tabular text-ink-subtle">{timeOf(e.atIso)}</span>
                  <span className="text-violet-ink">{e.type}</span>
                </div>
                <p className="mt-0.5 truncate text-ink-muted">{e.payload}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Connected channels">
          {data.channels.length === 0 ? (
            <p className="text-[0.8125rem] text-ink-muted">
              No channel connected yet, so nothing is reaching the twin on its own.
            </p>
          ) : (
          <ul className="flex flex-wrap gap-x-8 gap-y-3">
            {data.channels.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <ChannelDot slot={channelSlot[c.id]} label={channelLabel[c.id]} />
                <span className={`text-[0.6875rem] uppercase tracking-wide ${c.status === "connected" ? "text-teal" : "text-amber"}`}>
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
          )}
        </Panel>
      </div>
      </>
      )}
    </>
  );
}
