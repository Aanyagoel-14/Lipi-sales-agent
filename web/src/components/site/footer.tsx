import { LipiMark } from "./icons";

const groups = [
  {
    heading: "Platform",
    links: ["Unified inbox", "Conversation intelligence", "Digital twins", "AI agents", "Approval queue"],
  },
  { heading: "Channels", links: ["WhatsApp", "Telegram", "Email", "Website chat", "Instagram DM"] },
  { heading: "Industries", links: ["Apparel", "Auto parts", "Marine", "Wholesale"] },
  { heading: "Company", links: ["About", "Careers", "Contact sales", "Security"] },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-surface px-6 py-14">
      <div className="mx-auto w-full max-w-6xl">
        <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
          <div>
            <a href="#top" className="flex items-center gap-2 font-medium tracking-tight">
              <LipiMark />
              <span>Lipi AI</span>
            </a>
            <p className="mt-4 max-w-xs text-[0.875rem] text-ink-muted">
              The digital twin layer for conversational commerce.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-4">
            {groups.map((group) => (
              <div key={group.heading}>
                <p className="eyebrow mb-3">{group.heading}</p>
                <ul>
                  {group.links.map((link) => (
                    <li key={link}>
                      <a
                        href="#top"
                        className="inline-flex min-h-9 items-center text-[0.8125rem] text-ink-muted transition-colors hover:text-ink"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-x-6 border-t border-line pt-4 text-[0.75rem] text-ink-subtle">
          <span className="inline-flex min-h-9 items-center">© {new Date().getFullYear()} Lipi AI</span>
          <a href="#top" className="inline-flex min-h-9 items-center hover:text-ink">
            Privacy
          </a>
          <a href="#top" className="inline-flex min-h-9 items-center hover:text-ink">
            Terms
          </a>
        </div>
      </div>
    </footer>
  );
}
