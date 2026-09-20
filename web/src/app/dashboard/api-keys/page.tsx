import { PageHead } from "@/components/dash/ui";
import { apiBaseUrl } from "@/lib/api";
import { ApiKeyPanel } from "./api-key-panel";

export const metadata = { title: "API keys · Lipi AI" };

export default function ApiKeysPage() {
  return (
    <>
      <PageHead
        title="API keys"
        blurb="A key lets your own backend, plugin or app call Lipi where a browser session cannot — your storefront's server, a WordPress site, an internal tool."
      />
      {/* The example has to name a real host, and only the server knows it. */}
      <ApiKeyPanel baseUrl={apiBaseUrl} />
    </>
  );
}
