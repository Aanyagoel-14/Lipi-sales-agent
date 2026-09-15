import type { ChannelKey, Policy, Vertical } from "@/lib/onboarding";

/**
 * The vertical is not a label, it decides the shape of the product twin. Each
 * option carries the fields it would actually create, so the choice teaches
 * what it costs rather than asking the operator to guess.
 */
export const verticals: { id: Vertical; label: string; blurb: string; twinFields: string[] }[] = [
  {
    id: "apparel", label: "Apparel",
    blurb: "Variants are the whole problem: one product, thirty sellable things.",
    twinFields: ["size", "colour", "fabric", "fit", "season", "exchange history"],
  },
  {
    id: "auto_parts", label: "Auto parts",
    blurb: "A part is only real in relation to a vehicle.",
    twinFields: ["vehicle fitment", "OEM ref", "aftermarket ref", "VIN", "warranty"],
  },
  {
    id: "marine", label: "Marine",
    blurb: "Few units, long conversations, heavy paperwork.",
    twinFields: ["hull ID", "survey history", "port", "hours", "ownership"],
  },
  {
    id: "wholesale", label: "Wholesale",
    blurb: "Price depends on volume and who is asking.",
    twinFields: ["bulk tiers", "MOQ", "payment terms", "PO refs", "credit limit"],
  },
];

export const channels: { id: ChannelKey; label: string; status: "live" | "beta"; note: string }[] = [
  { id: "whatsapp", label: "WhatsApp", status: "live", note: "Cloud API test number, no review needed" },
  { id: "telegram", label: "Telegram", status: "live", note: "Bot token, ready in two minutes" },
  { id: "email", label: "Email", status: "live", note: "Forward an address or connect a mailbox" },
  { id: "webchat", label: "Website chat", status: "live", note: "One script tag on your site" },
  { id: "instagram", label: "Instagram DM", status: "beta", note: "Needs a Business account and Meta review" },
];

export const policies: { id: Policy; label: string; blurb: string; consequence: string }[] = [
  {
    id: "everything", label: "Review everything",
    blurb: "Nothing reaches a customer until you approve it.",
    consequence: "Every reply queues. Safest, slowest.",
  },
  {
    id: "money_only", label: "Review anything with money",
    blurb: "Quotes, discounts and purchase orders wait for you.",
    consequence: "Stock checks and status replies go out unattended.",
  },
  {
    id: "nothing", label: "Let agents run",
    blurb: "Agents act without waiting.",
    consequence: "Every action is still in the event log, after the fact.",
  },
];

export const stepTitles = ["Workspace", "Vertical", "Catalogue", "Channels", "Voice", "Knowledge", "Approvals"] as const;
