/** Simplified monochrome channel marks — recognisable silhouettes, no brand assets. */
type IconProps = { className?: string };

const wrap = (className = "") => `size-4 shrink-0 ${className}`;

export function WhatsAppIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 2a8 8 0 1 1-4.2 14.8l-.4-.2-2.6.7.7-2.5-.2-.4A8 8 0 0 1 12 4Zm-3.3 4.3c-.2 0-.5.1-.7.3-.3.3-.7.8-.7 1.7 0 1 .7 2 1.9 3.2s2.4 1.8 3.4 2c.9.2 1.5 0 1.9-.3.4-.3.6-.8.6-1.1v-.5l-1.7-.8c-.2-.1-.4 0-.5.1l-.5.6c-.1.2-.3.2-.5.1a6 6 0 0 1-2.6-2.6c-.1-.2 0-.3.1-.5l.5-.5c.1-.2.2-.3.1-.5l-.7-1.6c-.1-.2-.2-.3-.4-.3h-.2Z" />
    </svg>
  );
}

export function InstagramIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TelegramIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="currentColor">
      <path d="M21.5 4.3 2.8 11.4c-.8.3-.8 1.4 0 1.7l4.3 1.5 1.6 4.9c.2.7 1.1.9 1.6.3l2.3-2.6 4.3 3.2c.6.4 1.4.1 1.6-.6l3.3-14.4c.2-.8-.6-1.4-1.3-1.1ZM9.3 14.6l-.3 3-1-3.1 8.7-6.1-7.4 6.2Z" />
    </svg>
  );
}

export function MessengerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="currentColor">
      <path d="M12 2C6.3 2 2 6.2 2 11.4c0 2.9 1.4 5.5 3.6 7.2V22l3-1.6c.9.3 1.9.4 3 .4 5.7 0 10-4.2 10-9.4S17.7 2 12 2Zm.6 12.4-2.4-2.5-4.3 2.5 4.9-5.2 2.4 2.5 4.2-2.5-4.8 5.2Z" />
    </svg>
  );
}

export function MailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 8 8 5 8-5" />
    </svg>
  );
}

export function StoreIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Z" />
      <path d="M3 9l2-4h14l2 4M9 20v-6h6v6" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={wrap(className)} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 12c0 4-3.6 7-8 7-1 0-2-.2-2.9-.5L5 20l1.2-3A6.6 6.6 0 0 1 4 12c0-4 3.6-7 8-7s8 3 8 7Z" />
    </svg>
  );
}

export function LipiMark({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden className={`size-6 ${className}`}>
      <rect x="1" y="1" width="26" height="26" rx="8" fill="var(--color-ink)" />
      <circle cx="10.5" cy="14" r="3.2" fill="none" stroke="white" strokeWidth="1.6" />
      <circle cx="18.5" cy="14" r="3.2" fill="none" stroke="var(--color-violet)" strokeWidth="1.6" />
    </svg>
  );
}
