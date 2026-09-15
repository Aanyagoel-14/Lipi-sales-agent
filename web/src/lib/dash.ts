import { apiBaseUrl } from "./api";
import { apiHeaders } from "./session";
import type {
  Ageing, Approval, ConversationSummary, Conversation, Customer, Invoice,
  Order, Overview, Paged, Payment, Product, Supplier, TwinEvent,
} from "./dash-types";

/**
 * Every dashboard read goes through here, authenticated and tenant-scoped.
 * Response shapes are the API's; there is no second source to drift from.
 *
 * Row shapes and formatters live in `lib/dash-types` so client components can
 * use them without importing this module, which is server-only.
 */
export * from "./dash-types";
export { channelLabel, channelSlot } from "./channels";

async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.size ? `?${search}` : "";

  const res = await fetch(`${apiBaseUrl}/v1/${path}${qs}`, { headers: await apiHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status} on /v1/${path}`);
  return (await res.json()) as T;
}

export type Cursor = { cursor?: string; limit?: number };

export const getOverview = () => get<Overview>("dashboard/overview");
export const getCustomers = () => get<{ customers: Customer[] }>("customers");
export const getProducts = () => get<{ products: Product[]; suppliers: Supplier[] }>("products");
export const getApprovals = () => get<{ approvals: Approval[] }>("approvals");
export const getInvoices = () => get<{ ageing: Ageing; invoices: Invoice[]; payments: Payment[] }>("invoices");

/* Cursor-paged. The first page is server-rendered and later pages are appended
 * from the browser, so a table that grows forever is never fetched whole. */
export const getConversations = (page: Cursor = {}) =>
  get<Paged<"conversations", ConversationSummary>>("conversations", page);
export const getOrders = (page: Cursor = {}) => get<Paged<"orders", Order>>("orders", page);
export const getEvents = (page: Cursor = {}) => get<Paged<"events", TwinEvent>>("events", page);

/** One thread with its messages. The list endpoint deliberately omits them. */
export const getConversation = (id: string) =>
  get<{ conversation: Conversation }>(`conversations/${encodeURIComponent(id)}`);
