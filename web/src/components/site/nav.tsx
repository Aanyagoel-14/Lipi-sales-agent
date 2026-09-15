import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { LipiMark } from "./icons";

const links = [
  { label: "Platform", href: "#platform" },
  { label: "Digital Twins", href: "#twins" },
  { label: "Agents", href: "#agents" },
  { label: "Channels", href: "#channels" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-ground/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-14 w-full max-w-6xl items-center gap-8 px-6">
        <a href="#top" className="flex min-h-11 items-center gap-2 font-medium tracking-tight">
          <LipiMark />
          <span className="text-[0.9375rem]">Lipi AI</span>
        </a>

        <ul className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="text-[0.8125rem] text-ink-muted transition-colors hover:text-ink"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/login"
            className="hidden text-[0.8125rem] text-ink-muted transition-colors hover:text-ink sm:block"
          >
            Sign in
          </Link>
          <ButtonLink href="#waitlist" variant="secondary" size="sm">
            Talk to sales
          </ButtonLink>
          <ButtonLink href="/signup" size="sm">
            Get started
          </ButtonLink>
        </div>
      </nav>
    </header>
  );
}
