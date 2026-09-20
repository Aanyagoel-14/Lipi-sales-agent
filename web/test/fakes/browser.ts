/**
 * Just enough browser to run `public/static/widget.js`.
 *
 * The widget is the one piece of this codebase that is not TypeScript, is
 * not imported by anything, and never runs on this server: it is a
 * dependency-free script served to a third-party page. There is no jsdom in
 * this project and adding one for a single file is a heavier dependency
 * than the file itself, so the script is evaluated with `new Function` over
 * stubs for the six host objects it reaches for — `window`, `document`,
 * `fetch`, `console`, `URL`, `URLSearchParams`. They are parameters, so a
 * widget that started reaching for a seventh host object would find this
 * realm's own and quietly escape the fake: add the stub here when it does.
 * Everything else the script uses (`Date`, `JSON`, `Math`, `Promise`) is a
 * language built-in, so this realm's own is the right one to give it.
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

/** The listener bookkeeping an element and the document share. */
class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  /** What a real click, submit or DOMContentLoaded ends up doing: the
   *  widget's own handlers, with the `preventDefault` a submit calls. */
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => {} });
  }
}

/** The subset of `Element` the widget sets, reads or listens on. */
export class FakeElement extends FakeEventTarget {
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
  private readonly classes = new Set<string>();

  constructor(readonly tagName: string) { super(); }

  readonly classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
}

class FakeDocument extends FakeEventTarget {
  readyState = "loading";
  readonly head = new FakeElement("head");
  readonly body = new FakeElement("body");
  currentScript: FakeElement | null = null;
  referrer = "";

  createElement(tagName: string) { return new FakeElement(tagName); }
}

/** localStorage/sessionStorage, in memory. Passing one in across two page
 *  loads is how a returning visitor keeps their visitorId. */
export const fakeStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

export type FakeStorage = ReturnType<typeof fakeStorage>;

export type PageOptions = {
  fetch: (url: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  /** The address bar, including whatever the ad platform put on it. */
  url?: string;
  referrer?: string;
  /** Explicit `null` means a `<script>` tag carrying no `data-workspace`
   *  at all; omitted means the default one. */
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
  const timers: (() => void)[] = [];

  let minted = 0;
  const window = {
    crypto: { randomUUID: () => `11111111-2222-3333-4444-${String(++minted).padStart(12, "0")}` },
    localStorage: options.localStorage ?? fakeStorage(),
    sessionStorage: fakeStorage(),
    location: { href, search: new URL(href).search },
    // The poll timer is collected rather than run: a test that wants a tick
    // calls `poll()` itself, so no case depends on wall-clock time.
    setInterval: (fn: () => void) => timers.push(fn),
  };

  const warnings: string[] = [];
  const console = { warn: (message: string) => void warnings.push(message), error: () => {} };

  new Function("window", "document", "fetch", "console", "URL", "URLSearchParams", WIDGET_SOURCE)(
    window, document, options.fetch, console, URL, URLSearchParams,
  );

  /** `getElementById` over the tree the widget appended to the body. */
  const byId = (id: string): FakeElement | undefined => {
    const search = (el: FakeElement): FakeElement | undefined => {
      if (el.id === id) return el;
      for (const child of el.children) {
        const found = search(child);
        if (found) return found;
      }
      return undefined;
    };
    return search(document.body);
  };

  const launcher = () => byId("lipi-widget-launcher");
  const panel = () => byId("lipi-widget-panel");

  /** Type into the contact box without pressing Save. */
  const fillContact = (value: string) => {
    const input = byId("lipi-widget-contact-input");
    if (input) input.value = value;
  };

  return {
    window, document, warnings, launcher, panel,
    domContentLoaded: () => {
      document.readyState = "complete";
      document.dispatch("DOMContentLoaded");
    },
    /** What the visitor can read in the panel, oldest first. */
    messages: () => (byId("lipi-widget-messages")?.children ?? []).map((m) => m.textContent),
    isOpen: () => panel()?.classList.contains("lipi-open") ?? false,
    openPanel: () => launcher()?.dispatch("click"),
    type: (text: string) => {
      const input = byId("lipi-widget-input");
      if (input) input.value = text;
      byId("lipi-widget-form")?.dispatch("submit");
    },
    /** The field the widget is showing for a contact detail, named by what
     *  it is asking for — null when there is no box on screen. */
    contactAsk: () => {
      const row = byId("lipi-widget-contact");
      return row?.classList.contains("lipi-shown") ? row.getAttribute("data-field") : null;
    },
    contactPlaceholder: () => byId("lipi-widget-contact-input")?.placeholder ?? null,
    contactValue: () => byId("lipi-widget-contact-input")?.value ?? null,
    fillContact,
    /** Type into the contact box and press Save. */
    typeContact: (value: string) => {
      fillContact(value);
      byId("lipi-widget-contact")?.dispatch("submit");
    },
    skipContact: () => byId("lipi-widget-contact-skip")?.dispatch("click"),
    poll: () => timers.forEach((fn) => fn()),
    /** Let every promise the widget has in flight settle. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}
