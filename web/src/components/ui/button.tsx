import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const base =
  "inline-flex cursor-pointer touch-manipulation items-center gap-1.5 rounded-full font-medium transition-[background-color,transform] duration-200 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink/88",
  secondary: "bg-chip text-ink hover:bg-chip-hover",
  ghost: "text-ink-muted hover:text-ink",
};

const sizes: Record<Size, string> = {
  sm: "h-11 pl-3.5 pr-2.5 text-[0.8125rem] sm:h-9",
  md: "h-11 pl-5 pr-4 text-[0.9375rem]",
};

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0 opacity-70">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

type Props = {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  chevron?: boolean;
  className?: string;
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  chevron = true,
  className = "",
  ...rest
}: Props & Omit<ComponentProps<"button">, keyof Props>) {
  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {children}
      {chevron ? <Chevron /> : null}
    </button>
  );
}

export function ButtonLink({
  children,
  variant = "primary",
  size = "md",
  chevron = true,
  className = "",
  ...rest
}: Props & ComponentProps<typeof Link>) {
  return (
    <Link className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {children}
      {chevron ? <Chevron /> : null}
    </Link>
  );
}
