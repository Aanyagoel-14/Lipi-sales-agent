import { Section } from "@/components/ui/primitives";
import { WaitlistForm } from "./waitlist";

export function Cta() {
  return (
    <Section id="waitlist" className="relative overflow-hidden">
      <div aria-hidden className="hero-columns pointer-events-none absolute inset-y-0 right-0 w-[55%] opacity-70" />
      <div className="relative">
        <h2 className="max-w-2xl text-3xl md:text-[2.75rem]">
          Bring your channels. We&apos;ll build the twin.
        </h2>
        <p className="mt-5 max-w-lg text-base text-ink-muted">
          We&apos;re onboarding a small number of apparel businesses first. Connect WhatsApp and your
          catalogue, and see your twin populate in an afternoon.
        </p>
        <div className="mt-9">
          <WaitlistForm />
        </div>
      </div>
    </Section>
  );
}
