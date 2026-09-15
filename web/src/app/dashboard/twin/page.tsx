import { PageHead } from "@/components/dash/ui";
import { TwinChat } from "./chat";

export const metadata = { title: "Ask the twin · Lipi AI" };

export default function TwinPage() {
  return (
    <>
      <PageHead
        title="Ask the twin"
        blurb="Your side of the twin. It answers from the same rows the dashboard renders — stock, orders, customers, policies — so a number here is a number you can act on. It reads; it never writes."
      />
      <TwinChat />
    </>
  );
}
