import { Reveal } from "@/components/ui/reveal";
import { Pill, Section } from "@/components/ui/primitives";
import { ChatIcon, InstagramIcon, MailIcon, MessengerIcon, StoreIcon, TelegramIcon, WhatsAppIcon } from "./icons";

/* ============================ 1. channels: marquee ========================== */

const channels = [
  { label: "WhatsApp", icon: <WhatsAppIcon />, status: "live" },
  { label: "Telegram", icon: <TelegramIcon />, status: "live" },
  { label: "Email", icon: <MailIcon />, status: "live" },
  { label: "Website chat", icon: <ChatIcon />, status: "live" },
  { label: "Instagram DM", icon: <InstagramIcon />, status: "beta" },
  { label: "Messenger", icon: <MessengerIcon />, status: "beta" },
  { label: "Marketplaces", icon: <StoreIcon />, status: "soon" },
];

const statusColour = {
  live: "text-teal",
  beta: "text-amber",
  soon: "text-ink-subtle",
} as const;

function ChannelChip({ channel }: { channel: (typeof channels)[number] }) {
  return (
    <span className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-[0.8125rem]">
      <span className="text-ink-subtle">{channel.icon}</span>
      {channel.label}
      <span
        className={`text-[0.625rem] uppercase tracking-wide ${
          statusColour[channel.status as keyof typeof statusColour]
        }`}
      >
        {channel.status}
      </span>
    </span>
  );
}

export function Channels() {
  return (
    <section id="channels" className="overflow-hidden border-y border-line bg-surface py-14">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <p className="max-w-2xl text-lg text-ink-muted">
            Your customers keep using the channel they already use.{" "}
            <span className="text-ink">Lipi becomes the operational brain behind it.</span>
          </p>
        </Reveal>
      </div>

      <div
        className="relative mt-10 flex"
        style={{
          maskImage: "linear-gradient(to right, transparent, #000 6%, #000 94%, transparent)",
        }}
      >
        <div className="marquee-track flex w-max gap-3 pr-3">
          {[...channels, ...channels].map((channel, i) => (
            <ChannelChip key={`${channel.label}-${i}`} channel={channel} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ======================= 2. pipeline: timeline + artifacts ================== */

const steps = [
  {
    n: "01",
    title: "A message arrives",
    body: "Any channel, normalised into one canonical shape by a thin adapter.",
    artifact: [
      ["channel", "whatsapp"],
      ["from", "+91 98 ··· 4410"],
      ["text", '"4 blue XL polos by Friday"'],
    ],
  },
  {
    n: "02",
    title: "Intent is extracted",
    body: "Not filed as a chat log. Parsed into intent, entities, quantities and urgency.",
    artifact: [
      ["intent", "buy"],
      ["qty · size · colour", "4 · XL · cobalt"],
      ["deadline", "2026-08-28"],
    ],
  },
  {
    n: "03",
    title: "Twins are updated",
    body: "Customer, product, inventory and order twins upsert, and an immutable event is appended.",
    artifact: [
      ["customer_twin", "bulk_buyer = true"],
      ["inventory_twin", "reserved 4, remaining 0"],
      ["order_twin", "ord_2318 quoted"],
    ],
  },
  {
    n: "04",
    title: "Agents act on it",
    body: "Sales quotes, procurement drafts the restock, finance raises the invoice.",
    artifact: [
      ["sales", "quote sent, 1.2s"],
      ["procurement", "PO draft, needs approval"],
      ["finance", "INV-4482 issued"],
    ],
  },
];

export function Pipeline() {
  return (
    <Section id="platform">
      <Reveal className="max-w-2xl">
        <p className="eyebrow mb-4">How it works</p>
        <h2 className="text-3xl md:text-[2.75rem]">
          Conversations stop being chat logs and start being state
        </h2>
      </Reveal>

      <ol className="mt-16 space-y-4">
        {steps.map((step, i) => (
          <Reveal as="li" key={step.n} index={i}>
            <div className="group relative grid gap-6 rounded-2xl border border-line bg-surface p-6 transition-colors hover:border-line-strong md:grid-cols-[3.5rem_1fr_22rem] md:items-start md:gap-8 md:p-7">
              <div className="flex items-center gap-3 md:block">
                <span className="font-mono text-[0.8125rem] text-violet">{step.n}</span>
                {i < steps.length - 1 ? (
                  <span
                    aria-hidden
                    className="hidden md:mt-3 md:block md:h-full md:w-px md:bg-linear-to-b md:from-violet/40 md:to-transparent"
                  />
                ) : null}
              </div>

              <div className="max-w-md">
                <h3 className="text-[1.125rem]">{step.title}</h3>
                <p className="mt-2 text-[0.9375rem] text-ink-muted">{step.body}</p>
              </div>

              <dl className="overflow-hidden rounded-xl bg-black/[0.025] p-4 font-mono text-[0.75rem]">
                {step.artifact.map(([key, value]) => (
                  <div key={key} className="flex min-w-0 gap-3 py-0.5">
                    <dt className="w-24 shrink-0 truncate text-ink-subtle sm:w-40">{key}</dt>
                    <dd className="min-w-0 flex-1 truncate text-violet-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}

/* ========================= 3. twins: asymmetric bento ====================== */

const heatGrid = [
  [12, 26, 18, 4, 0],
  [8, 14, 22, 11, 3],
  [0, 6, 9, 2, 0],
];

function heatTone(n: number) {
  if (n === 0) return "bg-magenta/10 text-magenta";
  if (n < 6) return "bg-amber-wash text-amber";
  if (n < 15) return "bg-violet/10 text-violet-ink";
  return "bg-violet/20 text-violet-ink";
}

function Cell({
  title,
  body,
  className = "",
  visual,
}: {
  title: string;
  body: string;
  className?: string;
  visual?: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col rounded-2xl border border-line bg-surface p-6 ${className}`}>
      <h3 className="text-[1.0625rem]">{title}</h3>
      <p className="mt-2 text-[0.875rem] text-ink-muted">{body}</p>
      {visual ? <div className="mt-6 flex-1">{visual}</div> : null}
    </div>
  );
}

export function Twins() {
  return (
    <Section id="twins" className="border-y border-line bg-surface">
      <Reveal className="max-w-2xl">
        <h2 className="text-3xl md:text-[2.75rem]">A living model, not a database of rows</h2>
        <p className="mt-5 text-base text-ink-muted">
          Each twin evolves continuously and links to the others. That is what lets an agent answer
          &ldquo;4 blue XL polos before Friday&rdquo; with a real reservation instead of a plausible
          sentence.
        </p>
      </Reveal>

      <div className="mt-16 grid gap-4 md:grid-cols-3">
        <Reveal className="md:col-span-2">
          <Cell
            className="violet-wash h-full"
            title="Customer Twin"
            body="Buying history, size profile, negotiation style, price sensitivity, payment terms, return reasons and predicted next purchase."
            visual={
              <div>
                <div className="flex flex-wrap gap-1.5">
                  <Pill tone="violet">shirt: XL</Pill>
                  <Pill tone="violet">waist: 34</Pill>
                  <Pill>fit: regular</Pill>
                  <Pill>fabric: cotton, linen</Pill>
                  <Pill>avoids: polyester</Pill>
                  <Pill tone="magenta">palette: cobalt, olive</Pill>
                </div>
                <div className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
                  {[
                    ["Lifetime value", "₹1,84,200"],
                    ["Orders", "27"],
                    ["Return rate", "4.1%"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="stat-label">{label}</p>
                      <p className="tabular mt-0.5 text-[1.375rem] tracking-tight">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            }
          />
        </Reveal>

        <Reveal index={1} className="md:row-span-2">
          <Cell
            className="h-full"
            title="Product Twin"
            body="Variant-native, not a flat SKU list. Size by colour, with per-variant stock, margin and a cross-sell graph."
            visual={
              <div>
                <div className="grid grid-cols-5 gap-1.5">
                  {heatGrid.flat().map((n, i) => (
                    <span
                      key={i}
                      className={`tabular flex h-8 items-center justify-center rounded-md font-mono text-[0.75rem] ${heatTone(n)}`}
                    >
                      {n}
                    </span>
                  ))}
                </div>
                <p className="mt-3 font-mono text-[0.6875rem] text-ink-subtle">
                  S · M · L · XL · XXL by cobalt / olive / white
                </p>
                <div className="mt-5 flex flex-wrap gap-1.5">
                  <Pill>margin: 41%</Pill>
                  <Pill tone="teal">lead: 6d</Pill>
                </div>
              </div>
            }
          />
        </Reveal>

        <Reveal index={2}>
          <Cell
            className="h-full"
            title="Inventory Twin"
            body="Live stock across warehouses, reserved units, incoming shipments and forecast shortages."
            visual={
              <ul className="space-y-2.5">
                {[
                  ["Mumbai", 74, "text-violet"],
                  ["Surat", 41, "text-violet/60"],
                  ["In transit", 18, "text-amber"],
                ].map(([label, pct, tone]) => (
                  <li key={label as string}>
                    <div className="flex justify-between text-[0.75rem] text-ink-muted">
                      <span>{label}</span>
                      <span className="tabular font-mono">{pct}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-chip">
                      <div
                        className={`h-full rounded-full bg-current ${tone}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            }
          />
        </Reveal>

        <Reveal index={3}>
          <Cell
            className="h-full"
            title="Order Twin"
            body="One object from conversation to quote, payment, packing, delivery and returns."
            visual={
              <ol className="space-y-0">
                {["Quoted", "Paid", "Packed", "Shipped", "Delivered"].map((stage, i) => (
                  <li key={stage} className="flex items-center gap-3">
                    <span className="flex flex-col items-center">
                      <span
                        className={`size-2 rounded-full ${i < 3 ? "bg-violet" : "bg-line-strong"}`}
                      />
                      {i < 4 ? (
                        <span className={`h-5 w-px ${i < 2 ? "bg-violet/40" : "bg-line"}`} />
                      ) : null}
                    </span>
                    <span
                      className={`-mt-5 text-[0.8125rem] ${i < 3 ? "text-ink" : "text-ink-subtle"}`}
                    >
                      {stage}
                    </span>
                  </li>
                ))}
              </ol>
            }
          />
        </Reveal>

        <Reveal index={4} className="md:col-span-3">
          <Cell
            className="h-full"
            title="Supplier and Knowledge Twins"
            body="Response time, lead time, defect rate and MOQ on one side. Policies, warranty terms and sizing charts on the other, so agents answer from your rules rather than from guesswork."
            visual={
              <div className="flex flex-wrap gap-x-10 gap-y-4">
                {[
                  ["On-time", "96%"],
                  ["Avg. lead", "6d"],
                  ["Defect rate", "0.8%"],
                  ["Policies indexed", "34"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="stat-label">{label}</p>
                    <p className="tabular mt-0.5 text-[1.375rem] tracking-tight">{value}</p>
                  </div>
                ))}
              </div>
            }
          />
        </Reveal>
      </div>
    </Section>
  );
}

/* ======================= 4. agents: grouped clusters ======================= */

const clusters = [
  {
    group: "Revenue",
    agents: [
      ["Sales", "Quoting, negotiation, cross-sell"],
      ["Marketing", "Campaigns, abandoned-cart recovery"],
      ["Analytics", "Forecasting, KPIs, customer insight"],
    ],
  },
  {
    group: "Operations",
    agents: [
      ["Inventory", "Availability, reservations, replenishment"],
      ["Procurement", "Supplier quotes, purchase orders"],
      ["Logistics", "Shipping, tracking, delivery updates"],
    ],
  },
  {
    group: "Trust",
    agents: [
      ["Support", "Complaints, returns, warranty"],
      ["Finance", "Invoices, reminders, reconciliation"],
      ["Compliance", "Policy checks, audit trails, approvals"],
    ],
  },
];

export function Agents() {
  return (
    <Section id="agents">
      <Reveal className="max-w-2xl">
        <h2 className="text-3xl md:text-[2.75rem]">Nine specialists, one source of truth</h2>
        <p className="mt-5 text-base text-ink-muted">
          Agents do not pass messages to each other. They read and write the same twins, which is why
          their actions stay consistent and why every one of them is traceable back to an event.
        </p>
      </Reveal>

      <div className="mt-16 grid gap-x-12 gap-y-10 md:grid-cols-3">
        {clusters.map((cluster, i) => (
          <Reveal key={cluster.group} index={i}>
            <h3 className="text-[1.0625rem] text-violet-ink">{cluster.group}</h3>
            <div className="mt-5 space-y-5 border-t border-line pt-5">
              {cluster.agents.map(([name, responsibility]) => (
                <div key={name}>
                  <p className="text-[0.9375rem] font-medium">{name}</p>
                  <p className="mt-0.5 text-[0.875rem] text-ink-muted">{responsibility}</p>
                </div>
              ))}
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal index={4}>
        <div className="mt-14 flex flex-col gap-4 rounded-2xl bg-ink p-6 text-white sm:flex-row sm:items-center sm:gap-8 md:p-7">
          <p className="text-[1.0625rem] sm:max-w-xs">Nothing reaches a customer unapproved.</p>
          <p className="text-[0.9375rem] text-white/65">
            Every agent action lands in a queue until you trust it. Approve individually, approve a
            whole action type, or let an agent run unattended once it has earned it.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

/* ========================== 5. compare: contrast =========================== */

const comparison = [
  ["What a message is", "A row in a thread", "An event that mutates state"],
  ["What the AI reads", "The last few messages", "The full twin, plus your catalogue"],
  ["Stock promises", "Whatever the model infers", "A real reservation, or nothing"],
  ["Adding a channel", "Another inbox to staff", "One adapter, same twins"],
  ["When it is wrong", "You find out from the customer", "You replay the event log"],
];

export function Compare() {
  return (
    <Section className="violet-wash border-y border-line bg-surface">
      <Reveal className="max-w-2xl">
        <p className="eyebrow mb-4">Why a twin</p>
        <h2 className="text-3xl md:text-[2.75rem]">The difference is what the AI is standing on</h2>
      </Reveal>

      <Reveal index={1}>
        <div className="mt-14 overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-[1fr_1fr_1.2fr] sm:divide-x sm:divide-y-0">
            <div className="px-6 py-4" />
            <div className="px-6 py-4">
              <p className="text-[0.8125rem] font-medium text-ink-subtle">Another omnichannel inbox</p>
            </div>
            <div className="bg-violet-soft/45 px-6 py-4">
              <p className="text-[0.8125rem] font-medium text-violet-ink">Lipi AI</p>
            </div>
          </div>

          {comparison.map(([dimension, them, us]) => (
            <div
              key={dimension}
              className="grid grid-cols-1 border-t border-line sm:grid-cols-[1fr_1fr_1.2fr]"
            >
              <div className="px-6 pb-1 pt-4 text-[0.875rem] font-medium sm:border-r sm:border-line sm:py-5">
                {dimension}
              </div>
              <div className="px-6 pb-2 text-[0.875rem] text-ink-subtle sm:border-r sm:border-line sm:py-5">
                {them}
              </div>
              <div className="bg-violet-soft/25 px-6 py-4 text-[0.875rem] sm:py-5">{us}</div>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
