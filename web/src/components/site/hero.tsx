import { ButtonLink } from "@/components/ui/button";
import { Showcase } from "./showcase";

export function Hero() {
  return (
    <div id="top" className="relative overflow-hidden">
      <div aria-hidden className="hero-columns pointer-events-none absolute inset-y-0 right-0 w-[70%]" />

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-16 pt-20 md:pb-24 md:pt-28">
        <h1 className="max-w-3xl text-[2.75rem] md:text-display">Your business, mirrored</h1>
        <p className="mt-6 max-w-xl text-base text-ink-muted md:text-lg">
          Every conversation on WhatsApp, Instagram, email or marketplace updates a living twin of
          your customers, products, inventory and orders. Its agents act on it.
        </p>

        <div className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href="/signup">Get started</ButtonLink>
          <ButtonLink href="#platform" variant="secondary">
            See how it works
          </ButtonLink>
        </div>

        <div className="mt-14 md:mt-20">
          <Showcase />
        </div>
      </div>
    </div>
  );
}
