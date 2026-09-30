/**
 * Theme tokens for a generated site (PRD §3.1 `theme_mode`, §8.1 palette).
 *
 * The PRD names one mode outright — `DARK_SLATE_PREMIUM` — and gives the
 * palette in §8.1: Dark Slate Canvas `#0B0F19`, Card Surface `#111827`, Indigo
 * Primary `#6366F1`, Active Emerald `#10B981`, Alert Coral `#EF4444`. Those
 * exact values are the dark mode below.
 *
 * Emitted as CSS custom properties on the page rather than as Tailwind
 * classes, because a generated site's theme is chosen per site at request time
 * and Tailwind's classes are decided at build time. The blocks use the tokens;
 * changing `theme_mode` changes the values and nothing else.
 */

export type ThemeTokens = {
  canvas: string;
  surface: string;
  border: string;
  ink: string;
  inkMuted: string;
  primary: string;
  primaryInk: string;
  success: string;
  alert: string;
};

/** PRD §8.1, verbatim. */
export const DARK_SLATE_PREMIUM: ThemeTokens = {
  canvas: "#0B0F19",
  surface: "#111827",
  border: "#1F2937",
  ink: "#F9FAFB",
  inkMuted: "#9CA3AF",
  primary: "#6366F1",
  primaryInk: "#FFFFFF",
  success: "#10B981",
  alert: "#EF4444",
};

const LIGHT_MINIMAL: ThemeTokens = {
  canvas: "#FFFFFF",
  surface: "#F9FAFB",
  border: "#E5E7EB",
  ink: "#111827",
  inkMuted: "#4B5563",
  primary: "#4F46E5",
  primaryInk: "#FFFFFF",
  success: "#047857",
  alert: "#B91C1C",
};

/**
 * Black on white with the PRD's hues darkened to clear 7:1 against it. Offered
 * because a quote calculator and a booking form are exactly the surfaces where
 * a visitor with low vision is most likely to give up.
 */
const HIGH_CONTRAST: ThemeTokens = {
  canvas: "#FFFFFF",
  surface: "#FFFFFF",
  border: "#000000",
  ink: "#000000",
  inkMuted: "#1F2937",
  primary: "#3730A3",
  primaryInk: "#FFFFFF",
  success: "#065F46",
  alert: "#991B1B",
};

export const THEMES = {
  DARK_SLATE_PREMIUM,
  LIGHT_MINIMAL,
  HIGH_CONTRAST,
} as const;

export const themeFor = (mode: string): ThemeTokens =>
  THEMES[mode as keyof typeof THEMES] ?? DARK_SLATE_PREMIUM;

/** The tokens as inline CSS custom properties for the page's root element. */
export const themeStyle = (tokens: ThemeTokens): Record<string, string> => ({
  "--site-canvas": tokens.canvas,
  "--site-surface": tokens.surface,
  "--site-border": tokens.border,
  "--site-ink": tokens.ink,
  "--site-ink-muted": tokens.inkMuted,
  "--site-primary": tokens.primary,
  "--site-primary-ink": tokens.primaryInk,
  "--site-success": tokens.success,
  "--site-alert": tokens.alert,
});
