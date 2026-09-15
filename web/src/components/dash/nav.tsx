"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/twin", label: "Ask the twin" },
  { href: "/dashboard/storefront", label: "Storefront" },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/customers", label: "Customers" },
  { href: "/dashboard/inventory", label: "Inventory" },
  { href: "/dashboard/inventory/connectors", label: "Stock connectors" },
  { href: "/dashboard/orders", label: "Orders" },
  { href: "/dashboard/invoices", label: "Invoices" },
  { href: "/dashboard/data", label: "Data onboarding" },
  { href: "/dashboard/channels", label: "Channels" },
  { href: "/dashboard/train", label: "Train the twin" },
  { href: "/dashboard/events", label: "Twin events" },
];

/**
 * One set of destinations, two shapes.
 *
 * `sidebar` is the column on large screens. `bar` is the small-screen form: a
 * single horizontally scrolling row of pills directly under the header, rather
 * than the same vertical list stacked at the foot of the page — fourteen
 * full-width rows below the content is half a screen of dead space on every
 * page, and it puts navigation behind however long the page happens to be.
 *
 * Only one of the two renders at a time, so there is a single `nav` landmark
 * in the accessibility tree instead of two competing ones.
 */
export function DashNav({ variant = "sidebar" }: { variant?: "sidebar" | "bar" }) {
  const pathname = usePathname();

  // `/dashboard` would otherwise match nothing but itself while a nested route
  // leaves every item looking inactive.
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  if (variant === "bar") {
    return (
      <nav aria-label="Dashboard" className="border-b border-line bg-surface">
        {/* Edge-to-edge scroll with the page gutter as padding, so the first and
            last pill sit flush with the content above and below. */}
        <ul className="flex snap-x gap-1.5 overflow-x-auto px-6 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href} className="snap-start">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[0.8125rem] transition-colors ${
                    active ? "bg-ink font-medium text-white" : "bg-chip text-ink-muted"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="Dashboard" className="px-3">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-9 items-center gap-2 rounded-lg px-3 text-[0.8125rem] transition-colors ${
                  active ? "bg-chip font-medium text-ink" : "text-ink-muted hover:bg-chip/60 hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
