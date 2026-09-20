import { describe, expect, it } from "vitest";
import { fakeStorage, loadWidget } from "./fakes/browser";

/**
 * The client half of the webchat channel, run as a browser runs it (see
 * fakes/browser.ts for how, and why there is no jsdom here).
 *
 * The subject of these cases is when the widget speaks to the server and
 * when it speaks to the visitor, which are no longer the same moment: the
 * session is created at page load, because that is where the `utm_*`
 * parameters still are and because a visitor who never clicks the launcher
 * is still a visitor; the greeting waits for the launcher, because a panel
 * that opens itself at someone who did not ask is a different feature with
 * its own controls.
 */

const GREETING = "Hi! How can we help?";
const REPLY = "We have those in olive — shall I show you the sizes?";
const PAID_URL = "https://shop.test/polos?utm_source=google&utm_medium=cpc&utm_campaign=polos-aw&gclid=abc123";

type Call = { url: string; method: string; body: Record<string, unknown> };

/** The endpoints the widget calls, and what they answer. `sessionFails`
 *  stands in for an offline visitor or a 500, both of which the widget must
 *  swallow rather than throw into the host page. */
function api(options: { sessionFails?: boolean } = {}) {
  const calls: Call[] = [];
  let sessionFails = options.sessionFails ?? false;

  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : {} });

    if (url.endsWith("/session")) {
      if (sessionFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({ sessionId: "vst_1", greeting: GREETING }) };
    }
    if (url.endsWith("/message")) {
      return { ok: true, status: 201, json: async () => ({ conversationId: "cnv_1", reply: REPLY, held: false }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  };

  return {
    fetch, calls,
    to: (endpoint: string) => calls.filter((call) => call.url.includes(endpoint)),
    comesBack: () => { sessionFails = false; },
  };
}

describe("what the widget does on page load", () => {
  it("creates the session before the visitor has touched anything", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch, url: PAID_URL, referrer: "https://www.google.com/" });

    page.domContentLoaded();
    await page.settle();

    expect(server.to("/session")).toHaveLength(1);
    const [session] = server.to("/session");
    expect(session!.method).toBe("POST");
    expect(session!.url).toBe("https://app.lipi.test/v1/webchat/wsp_test/session");
    expect(session!.body.touch).toEqual({
      utmSource: "google", utmMedium: "cpc", utmCampaign: "polos-aw",
      utmTerm: null, utmContent: null, adClickId: "abc123",
      landingPage: PAID_URL, referrer: "https://www.google.com/",
    });
    expect(session!.body.visitorId).toEqual(expect.any(String));

    // Nothing was clicked, so nothing is open and nobody has been spoken to.
    expect(page.isOpen()).toBe(false);
    expect(page.messages()).toEqual([]);
  });

  // The launcher and the panel exist from load, but the call that records
  // the visit waits for the page to finish parsing, exactly as before.
  it("calls nothing until the page has loaded", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    await page.settle();

    expect(server.calls).toEqual([]);
    expect(page.launcher()).toBeUndefined();
  });

  it("holds the greeting until the visitor opens the panel", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    expect(page.messages()).toEqual([]);

    page.openPanel();
    await page.settle();

    expect(page.isOpen()).toBe(true);
    expect(page.messages()).toEqual([GREETING]);
  });

  it("does not record a second visit when the panel opens", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();

    expect(server.to("/session")).toHaveLength(1);
    expect(page.messages()).toEqual([GREETING]);
  });

  it("greets once, however many times the panel is opened and closed", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();
    page.openPanel(); // the launcher toggles: this one closes it
    page.openPanel();
    await page.settle();

    expect(page.messages()).toEqual([GREETING]);
  });

  // The second page view of the same browser is the same visitor, so the
  // server sees one row whose lastSeenAt moves — not a second visitor.
  it("sends the visitorId it minted on the first page view again on the second", async () => {
    const server = api();
    const storage = fakeStorage();

    const first = loadWidget({ fetch: server.fetch, localStorage: storage, url: PAID_URL });
    first.domContentLoaded();
    await first.settle();

    const second = loadWidget({ fetch: server.fetch, localStorage: storage, url: "https://shop.test/checkout" });
    second.domContentLoaded();
    await second.settle();

    const [one, two] = server.to("/session");
    expect(two!.body.visitorId).toBe(one!.body.visitorId);
    // Second page, no campaign on the URL: the server keeps the first touch,
    // and the widget does not pretend this one carried one.
    expect((two!.body.touch as { utmSource: string | null }).utmSource).toBeNull();
  });

  it("starts polling only once the panel is open", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.poll();
    await page.settle();
    expect(server.to("/updates")).toHaveLength(0);

    page.openPanel();
    await page.settle();
    page.type("do you have olive polos");
    await page.settle();
    page.poll();
    await page.settle();

    expect(server.to("/updates")).toHaveLength(1);
  });
});

describe("when the session call fails", () => {
  it("says nothing to a visitor who never opened the panel", async () => {
    const server = api({ sessionFails: true });
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();

    expect(server.to("/session")).toHaveLength(1);
    expect(page.messages()).toEqual([]);
    expect(page.warnings).toEqual([]);
  });

  // A page load that hits a blip must not cost this visitor the chat: the
  // retry happens at the moment they actually ask for it.
  it("tries again when the panel opens, and greets on the second answer", async () => {
    const server = api({ sessionFails: true });
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    server.comesBack();

    page.openPanel();
    await page.settle();

    expect(server.to("/session")).toHaveLength(2);
    expect(page.messages()).toEqual([GREETING]);
  });

  it("tells the visitor once when the retry fails too", async () => {
    const server = api({ sessionFails: true });
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();

    expect(page.messages()).toEqual(["Sorry, chat isn't available right now."]);
  });

  // The host page is somebody else's: our failures belong in our own logs.
  it("never warns a workspace's own site about a call of ours", async () => {
    const server = api({ sessionFails: true });
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();
    page.type("hello");
    await page.settle();

    expect(page.warnings).toEqual([]);
  });
});

describe("the visitor who does talk", () => {
  it("sends the message and shows the reply", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();
    page.type("do you have olive polos");
    await page.settle();

    const [message] = server.to("/message");
    expect(message!.body.text).toBe("do you have olive polos");
    expect(message!.body.visitorId).toBe(server.to("/session")[0]!.body.visitorId);
    expect(page.messages()).toEqual([GREETING, "do you have olive polos", REPLY]);
  });
});

describe("the script tag itself", () => {
  it("does nothing at all without a data-workspace attribute", async () => {
    const server = api();
    const page = loadWidget({ fetch: server.fetch, workspaceId: null });

    page.domContentLoaded();
    await page.settle();

    expect(server.calls).toEqual([]);
    expect(page.launcher()).toBeUndefined();
    expect(page.warnings).toHaveLength(1);
  });

  it("takes the API origin from its own src, not from the host page", async () => {
    const server = api();
    const page = loadWidget({
      fetch: server.fetch,
      scriptSrc: "https://lipi.example.com/static/widget.js",
      workspaceId: "wsp_other",
    });

    page.domContentLoaded();
    await page.settle();

    expect(server.calls[0]!.url).toBe("https://lipi.example.com/v1/webchat/wsp_other/session");
  });
});
