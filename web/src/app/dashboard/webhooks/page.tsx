import { PageHead } from "@/components/dash/ui";
import { WebhookPanel } from "./webhook-panel";

export const metadata = { title: "Webhooks · Lipi AI" };

export default function WebhooksPage() {
  return (
    <>
      <PageHead
        title="Webhooks"
        blurb="Lipi posts every twin event to your own system as it happens — a CRM that has to hear an order was created, a warehouse that has to hear stock was reserved — so nothing has to poll for it."
      />
      <WebhookPanel />
    </>
  );
}
