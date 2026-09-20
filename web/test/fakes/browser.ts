/**
 * Just enough browser to run `public/static/widget.js`.
 *
 * The widget is the one piece of this codebase that is not TypeScript, is
 * not imported by anything, and never runs on this server: it is a
 * dependency-free script served to a third-party page. There is no jsdom in
 * this project and adding one for a single file is a heavier dependency
 * than the file itself, so the script is evaluated with `new Function` over
 * the globals it actually reaches for — `document`, `window`, `fetch`,
 * `console`, `URL`, `URLSearchParams` — and nothing else. A widget that
 * started touching a seventh global would fail here, which is the point:
 * the header comment promises it depends on nothing.
 *
 * Running it through `new Function` rather than a vm context keeps promises
 * in this realm, so a test can simply await them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WIDGET_SOURCE = readFileSync(
  fileURLToPath(new URL("../../public/static/widget.js", import.meta.url)),
  "utf8",
);

type Listener = (event: { preventDefault: () => void }) => void;

/** The subset of `Element` the widget sets, reads or listens on. */
export class FakeElement {
  id = "";
  src = "";
  className = "";
  textContent = "";
  type = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  private readonly classes = new Set<string>();

  constructor(readonly tagName: string) {}

  readonly classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }

  addEventListener(type: string, fn: Listener) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, fn]);
  }

  /** What a real click or submit ends up doing: the widget's own handler,
   *  with the `preventDefault` it calls on a form submit. */
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => {} });
  }
}

class FakeDocument {
  readyState = "loading";
  readonly head = new FakeElement("head");
  readonly body = new FakeElement("body");
  currentScript: FakeElement | null = null;
  referrer = "";
  private readonly listeners = new Map<string, Listener[]>();

  createElement(tagName: string) { return new FakeElement(tagName); }

  addEventListener(type: string, fn: Listener) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, fn]);
  }

  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => {} });
  }
}

/** localStorage/sessionStorage, in memory. Passing one in across two page
 *  loads is how a returning visitor keeps their visitorId. */
export const fakeStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    entries: () => Object.fromEntries(values),
  };
};

export type FakeStorage = ReturnType<typeof fakeStorage>;

export type PageOptions = {
  fetch: (url: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  /** The address bar, including whatever the ad platform put on it. */
  url?: string;
  referrer?: string;
  /** Omitted or null means a `<script>` tag with no `data-workspace`. */
  workspaceId?: string | null;
  localStorage?: FakeStorage;
  scriptSrc?: string;
};

/**
 * Evaluate widget.js against a fresh page. The script tag is loaded but the
 * page is still parsing, exactly as an `async` script on a real page is —
 * call `domContentLoaded()` to finish the load.
 */
export function loadWidget(options: PageOptions) {
  const document = new FakeDocument();
  document.referrer = options.referrer ?? "";

  const script = new FakeElement("script");
  script.src = options.scriptSrc ?? "https://app.lipi.test/static/widget.js";
  if (options.workspaceId !== null) {
    script.setAttribute("data-workspace", options.workspaceId ?? "wsp_test");
  }
  document.currentScript = script;

  const href = options.url ?? "https://shop.test/polos";
  const location = new URL(href);
  const timers: (() => void)[] = [];

  let minted = 0;
  const window = {
    crypto: { randomUUID: () => `11111111-2222-3333-4444-${String(++minted).padStart(12, "0")}` },
    localStorage: options.localStorage ?? fakeStorage(),
    sessionStorage: fakeStorage(),
    location: { href, search: location.search },
    // The poll timer is collected rather than run: a test that wants a tick
    // calls `poll()` itself, so no case depends on wall-clock time.
    setInterval: (fn: () => void) => timers.push(fn),
  };

  const warnings: string[] = [];
  const console = { warn: (message: string) => void warnings.push(message), error: () => {} };

  new Function("window", "document", "fetch", "console", "URL", "URLSearchParams", WIDGET_SOURCE)(
    window, document, options.fetch, console, URL, URLSearchParams,
  );

  const byId = (id: string): FakeElement | undefined => {
    const search = (el: FakeElement): FakeElement | undefined =>
      el.id === id ? el : el.children.map(search).find(Boolean);
    return search(document.body);
  };

  return {
    window, document, warnings,
    domContentLoaded: () => {
      document.readyState = "complete";
      document.dispatch("DOMContentLoaded");
    },
    byId,
    launcher: () => byId("lipi-widget-launcher"),
    panel: () => byId("lipi-widget-panel"),
    /** What the visitor can read in the panel, oldest first. */
    messages: () => (byId("lipi-widget-messages")?.children ?? []).map((m) => m.textContent),
    isOpen: () => byId("lipi-widget-panel")?.classList.contains("lipi-open") ?? false,
    openPanel: () => byId("lipi-widget-launcher")?.dispatch("click"),
    type: (text: string) => {
      const input = byId("lipi-widget-input");
      if (input) input.value = text;
      byId("lipi-widget-form")?.dispatch("submit");
    },
    poll: () => timers.forEach((fn) => fn()),
    /** Let every promise the widget has in flight settle. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}
