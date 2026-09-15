import { PageHead } from "@/components/dash/ui";
import { ChannelsStep } from "@/app/onboarding/steps/channels-step";

export const metadata = { title: "Channels · Lipi AI" };

export default function ChannelsPage() {
  return (
    <>
      <PageHead title="Channels" blurb="Connect the places where customers already talk to your business." />
      <ChannelsStep />
    </>
  );
}
