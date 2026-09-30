import type { AgentTemplate } from "@/generated/prisma/client";
import type { Guardrails } from "./guardrails";

/**
 * The four agents a business can start from (PRD §2 Step 01).
 *
 * A template is data, not code: a name, a description, the skills it holds
 * and the guardrails it holds them under. Picking one is the same operation as
 * assembling an agent by hand — the builder fills the form in for you — which
 * is why there is no separate "instantiate a template" path that could drift
 * from the one deploy uses.
 *
 * The guardrail defaults differ on purpose, and the differences are the whole
 * argument for per-agent guardrails: an SDR that may never move a price is
 * useless, and a support agent that may is a liability.
 */
export type AgentTemplateSpec = {
  key: Exclude<AgentTemplate, "custom">;
  label: string;
  description: string;
  skills: string[];
  guardrails: Partial<Guardrails>;
};

export const agentTemplates: AgentTemplateSpec[] = [
  {
    key: "customer_support",
    label: "Customer Support",
    description:
      "Answers questions from the catalogue and the workspace's own policies, checks stock, and hands anything about money to a person.",
    skills: ["Inventory_Lookup", "Lead_Scoring"],
    guardrails: {
      // Support answers; it does not negotiate. A discount allowance here
      // would be an allowance nobody asked support to have.
      maxAutonomousDiscountPct: 0,
      humanEscalationTriggers: ["DISPUTE", "REFUND", "CHARGEBACK", "COMPLAINT"],
    },
  },
  {
    key: "sdr",
    label: "SDR",
    description:
      "Qualifies inbound interest, scores the lead after every turn, prices within an allowance, and raises the invoice when the sale closes.",
    skills: ["Inventory_Lookup", "Discount_Calculator", "Stripe_Invoice", "Lead_Scoring"],
    guardrails: {
      // The PRD's own figure for an autonomous discount (§8.1).
      maxAutonomousDiscountPct: 0.12,
      // And the margin floor from the Customer Twin's rules (§5).
      minMarginPct: 18,
      humanEscalationTriggers: ["DISPUTE", "REFUND_OVER_500", "LEGAL"],
    },
  },
  {
    key: "calendar_pa",
    label: "Calendar PA",
    description:
      "Negotiates meeting times against the owner's working hours, focus blocks, buffers and daily ceiling, then books the agreed slot.",
    skills: ["Calendar_Negotiation"],
    guardrails: {
      // A PA moves no money, so the money ceilings are irrelevant; what it
      // must escalate is a request to break the owner's own rules.
      maxAutonomousDiscountPct: 0,
      humanEscalationTriggers: ["URGENT", "CANCEL ALL", "DOUBLE BOOK"],
      escalateOnPastDueInvoices: false,
    },
  },
  {
    key: "inbound_reception",
    label: "Inbound Reception",
    description:
      "Answers the first question a caller or visitor asks, checks availability, and books an appointment on the right calendar.",
    skills: ["Inventory_Lookup", "Calendar_Negotiation", "Lead_Scoring"],
    guardrails: {
      maxAutonomousDiscountPct: 0,
      humanEscalationTriggers: ["EMERGENCY", "COMPLAINT", "DISPUTE"],
      escalateOnPastDueInvoices: false,
    },
  },
];

export const templateFor = (key: string): AgentTemplateSpec | undefined =>
  agentTemplates.find((template) => template.key === key);
