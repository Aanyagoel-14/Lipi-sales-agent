"use client";

import { useState, type ReactNode } from "react";
import { Pill } from "@/components/ui/primitives";
import { InstagramIcon, MailIcon, StoreIcon, TelegramIcon, WhatsAppIcon } from "./icons";

const tabs = [
  { id: "inbox", label: "Unified Inbox" },
  { id: "customer", label: "Customer Twin" },
  { id: "product", label: "Product Twin" },
  { id: "agents", label: "Agent Runs" },
  { id: "events", label: "Twin Events" },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function Showcase() {
  const [active, setActive] = useState<TabId>("inbox");

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04),0_24px_60px_-32px_rgba(31,32,35,0.28)]">
      <div role="tablist" aria-label="Product views" className="flex overflow-x-auto border-b border-line">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={`min-h-11 shrink-0 cursor-pointer touch-manipulation border-r border-line px-5 text-[0.8125rem] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet ${
                isActive
                  ? "bg-surface font-medium text-ink"
                  : "bg-black/[0.015] text-ink-subtle hover:text-ink-muted"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
        className="min-h-[26rem] bg-black/[0.012] p-4 md:p-6"
      >
        {active === "inbox" ? <InboxPanel /> : null}
        {active === "customer" ? <CustomerPanel /> : null}
        {active === "product" ? <ProductPanel /> : null}
        {active === "agents" ? <AgentsPanel /> : null}
        {active === "events" ? <EventsPanel /> : null}
      </div>
    </div>
  );
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface ${className}`}>{children}</div>;
}

function PanelHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[0.75rem] font-medium text-ink-muted">
      {children}
    </div>
  );
}

/* ---------------------------------- inbox --------------------------------- */

const conversations = [
  {
    name: "Priya Nair",
    channel: <WhatsAppIcon className="text-teal" />,
    snippet: "Need 4 blue XL polos before Friday",
    time: "2m",
    unread: true,
  },
  { name: "@arjun.styles", channel: <InstagramIcon className="text-magenta" />, snippet: "Is the linen shirt back in stock?", time: "14m", unread: true },
  { name: "XYZ Uniforms Co.", channel: <MailIcon className="text-ink-subtle" />, snippet: "PO #4471 · 120 units, net 30", time: "1h", unread: false },
  { name: "Rahul M.", channel: <TelegramIcon className="text-violet" />, snippet: "Exchange size M → L, order 2291", time: "3h", unread: false },
  { name: "Fabrico Mills", channel: <StoreIcon className="text-amber" />, snippet: "Lead time now 11 days on cotton", time: "5h", unread: false },
];

function InboxPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
      <Panel className="overflow-hidden">
        <PanelHead>
          All channels
          <span className="ml-auto rounded-full bg-violet px-1.5 text-[0.625rem] font-semibold text-white">2</span>
        </PanelHead>
        <ul>
          {conversations.map((c, i) => (
            <li
              key={c.name}
              className={`flex gap-3 border-b border-line/60 px-4 py-3 last:border-0 ${
                i === 0 ? "bg-violet-soft/60" : ""
              }`}
            >
              <span className="mt-0.5">{c.channel}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 truncate text-[0.8125rem] font-medium">{c.name}</p>
                  <span className="ml-auto shrink-0 text-[0.6875rem] text-ink-subtle">{c.time}</span>
                </div>
                <p className="truncate text-[0.75rem] text-ink-subtle">{c.snippet}</p>
              </div>
              {c.unread ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet" /> : null}
            </li>
          ))}
        </ul>
      </Panel>

      <div className="space-y-4">
        <Panel>
          <PanelHead>
            <WhatsAppIcon className="text-teal" /> Priya Nair
            <span className="text-ink-subtle">· +91 ·98 ··· 4410</span>
            <span className="ml-auto"><Pill tone="violet">returning customer</Pill></span>
          </PanelHead>
          <div className="space-y-3 p-4">
            <Bubble>Hi! Need 4 blue XL polos before Friday for our store opening.</Bubble>
            <Bubble side="out">
              I have <b>4 × Polo Classic in Cobalt, XL</b> reserved for you. ₹1,196 each, ₹4,784 total.
              Dispatch today, delivered Thursday. Want the invoice?
            </Bubble>
            <Bubble>Yes please. Do you have matching chinos?</Bubble>
          </div>
        </Panel>

        <Panel>
          <PanelHead>Extracted by the conversation intelligence layer</PanelHead>
          <div className="flex flex-wrap gap-1.5 p-4">
            <Pill tone="violet">intent: buy</Pill>
            <Pill>quantity: 4</Pill>
            <Pill>colour: cobalt</Pill>
            <Pill>size: XL</Pill>
            <Pill>category: polo</Pill>
            <Pill tone="amber">deadline: fri 2026-08-28</Pill>
            <Pill tone="magenta">priority: high</Pill>
            <Pill tone="teal">cross_sell: chinos</Pill>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Bubble({ children, side = "in" }: { children: ReactNode; side?: "in" | "out" }) {
  const out = side === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <p
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[0.8125rem] leading-relaxed ${
          out ? "bg-ink text-white" : "bg-chip text-ink"
        }`}
      >
        {children}
      </p>
    </div>
  );
}

/* -------------------------------- customer -------------------------------- */

function CustomerPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <Panel>
        <PanelHead>
          Customer Twin <span className="font-mono text-[0.6875rem] text-ink-subtle">cus_8f21a</span>
          <span className="ml-auto"><Pill tone="teal">updated 2m ago</Pill></span>
        </PanelHead>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 sm:grid-cols-3">
          <Field label="Name" value="Priya Nair" />
          <Field label="Lifetime value" value="₹1,84,200" />
          <Field label="Orders" value="27" />
          <Field label="Avg. order" value="₹6,822" />
          <Field label="Negotiation style" value="Bundle-seeking" />
          <Field label="Price sensitivity" value="Medium" />
          <Field label="Payment method" value="UPI · net 15" />
          <Field label="Return rate" value="4.1%" />
          <Field label="Predicted next" value="Chinos, 32W" />
        </div>
        <div className="border-t border-line px-4 py-4">
          <p className="eyebrow mb-2.5">Size profile</p>
          <div className="flex flex-wrap gap-1.5">
            <Pill tone="violet">shirt: XL</Pill>
            <Pill tone="violet">waist: 34</Pill>
            <Pill>fit: regular</Pill>
            <Pill>fabric: cotton, linen</Pill>
            <Pill>avoids: polyester</Pill>
            <Pill tone="magenta">palette: cobalt, olive, white</Pill>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHead>Signals</PanelHead>
        <ul className="divide-y divide-line/60">
          {[
            ["Store opening mentioned", "bulk buyer signal", "2m"],
            ["Asked for matching chinos", "cross-sell open", "2m"],
            ["Exchanged M → L twice", "size drift up", "12d"],
            ["Abandoned cart recovered", "responds to nudges", "26d"],
          ].map(([title, meta, time]) => (
            <li key={title} className="px-4 py-3">
              <p className="text-[0.8125rem]">{title}</p>
              <p className="text-[0.75rem] text-ink-subtle">
                {meta} · {time}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow mb-1">{label}</p>
      <p className="text-[0.875rem]">{value}</p>
    </div>
  );
}

/* --------------------------------- product -------------------------------- */

const sizes = ["S", "M", "L", "XL", "XXL"];
const colours = [
  { name: "Cobalt", stock: [12, 26, 18, 4, 0] },
  { name: "Olive", stock: [8, 14, 22, 11, 3] },
  { name: "White", stock: [0, 6, 9, 2, 0] },
];

function ProductPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <Panel>
        <PanelHead>
          Product Twin · Polo Classic
          <span className="font-mono text-[0.6875rem] text-ink-subtle">prd_polo_01</span>
          <span className="ml-auto"><Pill tone="amber">2 variants low</Pill></span>
        </PanelHead>
        <div className="overflow-x-auto p-4">
          <table className="tabular w-full text-[0.8125rem]">
            <thead>
              <tr className="text-left">
                <th className="eyebrow pb-2 font-medium">Colour</th>
                {sizes.map((s) => (
                  <th key={s} className="eyebrow pb-2 text-center font-medium">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {colours.map((c) => (
                <tr key={c.name} className="border-t border-line/60">
                  <td className="py-2.5 pr-4 font-medium">{c.name}</td>
                  {c.stock.map((n, i) => (
                    <td key={`${c.name}-${sizes[i]}`} className="py-2.5 text-center">
                      <span
                        className={`inline-flex min-w-8 justify-center rounded-md px-1.5 py-0.5 font-mono text-[0.75rem] ${
                          n === 0
                            ? "bg-magenta/10 text-magenta"
                            : n < 6
                              ? "bg-amber-wash text-amber"
                              : "bg-chip text-ink-muted"
                        }`}
                      >
                        {n}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-4 py-4">
          <p className="eyebrow mb-2.5">Attributes the agents can reason over</p>
          <div className="flex flex-wrap gap-1.5">
            <Pill>fabric: pique cotton</Pill>
            <Pill>season: SS26</Pill>
            <Pill>fit: regular</Pill>
            <Pill>margin: 41%</Pill>
            <Pill tone="teal">lead time: 6d</Pill>
            <Pill tone="violet">cross-sell: chinos, belt, loafers</Pill>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHead>Linked twins</PanelHead>
        <ul className="divide-y divide-line/60">
          {[
            ["Inventory Twin", "3 warehouses · 4 reserved"],
            ["Supplier Twin", "Fabrico Mills · 96% on-time"],
            ["Order Twin", "12 open · 2 awaiting stock"],
            ["Demand forecast", "XL cobalt out in 3 days"],
          ].map(([title, meta]) => (
            <li key={title} className="px-4 py-3">
              <p className="text-[0.8125rem]">{title}</p>
              <p className="text-[0.75rem] text-ink-subtle">{meta}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* --------------------------------- agents --------------------------------- */

const runs = [
  ["Sales Agent", "Quoted 4 × Polo Classic XL cobalt, reserved stock", "done", "1.2s"],
  ["Inventory Agent", "Reserved 4 units, flagged XL cobalt below reorder point", "done", "0.4s"],
  ["Procurement Agent", "Drafted PO to Fabrico Mills, 60 units XL", "needs approval", "2.1s"],
  ["Finance Agent", "Generated invoice INV-4482, ₹4,784", "done", "0.9s"],
  ["Logistics Agent", "Booked pickup, ETA Thu 28 Aug", "done", "1.5s"],
  ["Marketing Agent", "Queued cross-sell: chinos 32W", "scheduled", "0.3s"],
];

const toneFor = (status: string) =>
  status === "done" ? "teal" : status === "needs approval" ? "amber" : "violet";

function AgentsPanel() {
  return (
    <Panel>
      <PanelHead>
        Agent runs for conversation <span className="font-mono text-[0.6875rem] text-ink-subtle">cnv_7731</span>
        <span className="ml-auto"><Pill tone="teal">6 steps · 6.4s</Pill></span>
      </PanelHead>
      <ul className="divide-y divide-line/60">
        {runs.map(([agent, action, status, duration]) => (
          <li key={agent} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <span className="w-40 shrink-0 text-[0.8125rem] font-medium">{agent}</span>
            <span className="min-w-0 flex-1 text-[0.8125rem] text-ink-muted">{action}</span>
            <Pill tone={toneFor(status!) as "teal" | "amber" | "violet"}>{status}</Pill>
            <span className="w-10 text-right font-mono text-[0.6875rem] text-ink-subtle">{duration}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* --------------------------------- events --------------------------------- */

const events = [
  ["10:42:03", "message.received", "channel=whatsapp conversation=cnv_7731"],
  ["10:42:03", "intent.extracted", "intent=buy qty=4 size=XL colour=cobalt deadline=2026-08-28"],
  ["10:42:04", "customer_twin.updated", "cus_8f21a bulk_buyer=true predicted_next=chinos"],
  ["10:42:04", "product_twin.matched", "prd_polo_01 variant=XL/cobalt confidence=0.94"],
  ["10:42:04", "inventory_twin.reserved", "sku=POLO-XL-COB qty=4 remaining=0"],
  ["10:42:05", "inventory_twin.threshold_breached", "sku=POLO-XL-COB reorder_point=6"],
  ["10:42:05", "order_twin.created", "ord_2318 status=quoted value=4784"],
  ["10:42:06", "agent.dispatched", "procurement → draft_po supplier=fabrico_mills"],
];

function EventsPanel() {
  return (
    <Panel>
      <PanelHead>
        twin_events · append only
        <span className="ml-auto font-mono text-[0.6875rem] text-ink-subtle">tail -f</span>
      </PanelHead>
      <div className="overflow-x-auto p-4">
        <table className="tabular w-full font-mono text-[0.75rem]">
          <tbody>
            {events.map(([time, type, payload]) => (
              <tr key={`${time}-${type}`} className="align-top">
                <td className="whitespace-nowrap py-1 pr-4 text-ink-subtle">{time}</td>
                <td className="whitespace-nowrap py-1 pr-4 text-violet-ink">{type}</td>
                <td className="py-1 text-ink-muted">{payload}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
