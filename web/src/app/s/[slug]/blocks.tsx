import Link from "next/link";
import { toRupees } from "@/server/lib/money";
import type { ResolvedBlock } from "@/server/sites/generate";
import { ContactForm } from "./contact-form";
import { QuoteCalculator } from "./quote-calculator";

/**
 * The blocks a generated site is made of.
 *
 * Server components, so the catalogue a visitor sees is fetched on the server
 * from live rows and arrives in the HTML — nothing about the business's stock
 * or prices is a client fetch, and nothing about its pricing maths is shipped
 * to the browser at all. The client components are the quote calculator,
 * which collects numbers and asks the server what they cost, and the contact
 * form, which saves through the widget's own endpoints.
 *
 * Styling is the theme tokens from `sites/theme.ts` and nothing else, so
 * `theme_mode` changes the site's appearance without changing its markup.
 */

type Props = {
  blocks: ResolvedBlock[];
  slug: string;
  pages: { path: string; title: string }[];
  assistant: { embedded: boolean; channel: string };
  workspaceId: string;
};

const href = (slug: string, path: string) => (path === "/" ? `/s/${slug}` : `/s/${slug}${path}`);

export function SiteBlocks({ blocks, slug, pages, assistant, workspaceId }: Props) {
  return (
    <>
      <header className="border-b border-[var(--site-border)]">
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-4 sm:px-6">
          {pages.map((page) => (
            <Link
              key={page.path}
              href={href(slug, page.path)}
              className="min-h-11 inline-flex items-center rounded-full px-3 text-[0.9375rem] text-[var(--site-ink-muted)] hover:text-[var(--site-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--site-primary)]"
            >
              {page.path === "/" ? "Home" : page.title.split("—").pop()?.trim() || page.path}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        {blocks.map((block) => (
          <Block key={block.id} block={block} slug={slug} workspaceId={workspaceId} />
        ))}
      </main>

      {assistant.embedded ? <Assistant workspaceId={workspaceId} /> : null}
    </>
  );
}

function Block({ block, slug, workspaceId }: { block: ResolvedBlock; slug: string; workspaceId: string }) {
  switch (block.type) {
    case "hero":
      return (
        <section className="py-12">
          <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">{block.heading}</h1>
          {block.body ? <p className="mt-4 max-w-2xl text-[var(--site-ink-muted)]">{block.body}</p> : null}
        </section>
      );

    case "catalogue":
      return (
        <Section heading={block.heading}>
          <Catalogue products={(block.data.products ?? []) as CatalogueProduct[]} />
        </Section>
      );

    case "quote_calculator":
      return (
        <Section heading={block.heading}>
          <QuoteCalculator slug={slug} variables={(block.data.variables ?? []) as string[]} />
        </Section>
      );

    case "reviews":
      return (
        <Section heading={block.heading}>
          {/* No reviews connector exists, and inventing testimonials for a
              real business is not a placeholder, it is a lie about people who
              did not say anything. The absence is stated instead. */}
          <p className="text-[var(--site-ink-muted)]">
            {(block.data.unavailable as string) ?? "No reviews yet."}
          </p>
        </Section>
      );

    case "booking":
      return (
        <Section heading={block.heading}>
          <p className="text-[var(--site-ink-muted)]">
            Ask in the chat and we will find a time that works.
          </p>
        </Section>
      );

    case "contact_form":
    case "phone_cta":
      return (
        <Section heading={block.heading}>
          <ContactForm workspaceId={workspaceId} />
        </Section>
      );

    case "features":
    case "faq":
      return block.body ? (
        <Section heading={block.heading}>
          <p className="max-w-2xl text-[var(--site-ink-muted)]">{block.body}</p>
        </Section>
      ) : null;

    case "footer":
      return (
        <footer className="mt-12 border-t border-[var(--site-border)] pt-6 text-[0.8125rem] text-[var(--site-ink-muted)]">
          {block.heading}
        </footer>
      );

    case "assistant":
      return null;

    default:
      return null;
  }
}

const Section = ({ heading, children }: { heading: string; children: React.ReactNode }) => (
  <section className="border-t border-[var(--site-border)] py-10">
    <h2 className="text-2xl font-medium tracking-tight">{heading}</h2>
    <div className="mt-6">{children}</div>
  </section>
);

type CatalogueProduct = {
  id: string;
  name: string;
  category: string;
  priceMinorUnits: number;
  leadTimeDays: number;
  available: number;
};

/**
 * Live stock, from the twin.
 *
 * `available` is stock minus what is already reserved, so a site never offers
 * something that is spoken for. A product with none left says so rather than
 * being hidden — a visitor who came for it is owed the answer.
 */
function Catalogue({ products }: { products: CatalogueProduct[] }) {
  if (!products.length) {
    return <p className="text-[var(--site-ink-muted)]">The catalogue is empty.</p>;
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => (
        <li
          key={product.id}
          className="rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] p-5"
        >
          <p className="text-[0.6875rem] uppercase tracking-wider text-[var(--site-ink-muted)]">
            {product.category}
          </p>
          <h3 className="mt-1 text-lg font-medium">{product.name}</h3>
          <p className="mt-3 font-mono text-[0.9375rem] tabular-nums">
            {toRupees(product.priceMinorUnits).toLocaleString("en-IN")}
          </p>
          <p className="mt-1 text-[0.8125rem]">
            {product.available > 0 ? (
              <span style={{ color: "var(--site-success)" }}>{product.available} available</span>
            ) : (
              <span style={{ color: "var(--site-alert)" }}>
                Out of stock · {product.leadTimeDays} day lead time
              </span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** The embedded assistant — the same widget every other site embeds. */
const Assistant = ({ workspaceId }: { workspaceId: string }) => (
  <script async src="/static/widget.js" data-lipi-workspace={workspaceId} />
);
