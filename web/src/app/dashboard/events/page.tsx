import { EmptyState, PageHead } from "@/components/dash/ui";
import { getEvents } from "@/lib/dash";
import { EventLog } from "./event-log";

export const metadata = { title: "Twin events · Lipi AI" };

export default async function EventsPage() {
  // The event log is append-only and grows without bound, so only the first
  // page is fetched here; the rest is pulled on demand.
  const data = await getEvents();

  return (
    <>
      <PageHead
        title="Twin events"
        blurb="Append only. Every twin mutation is replayable back to the message that caused it."
      />
      {data.events.length === 0 ? (
        <EmptyState
          title="No twin events yet"
          body="Every mutation to every twin is appended here, so you can replay exactly what a message changed."
          action={{ href: "/dashboard/train", label: "Send a test message" }}
        />
      ) : (
        <EventLog initial={data.events} nextCursor={data.nextCursor} />
      )}
    </>
  );
}
