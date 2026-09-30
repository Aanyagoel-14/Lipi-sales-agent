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
function fakeServer(options: { sessionFails?: boolean; contactFails?: boolean; asks?: (string | null)[] } = {}) {
  const calls: Call[] = [];
  let sessionFails = options.sessionFails ?? false;

  // What the server wants next, handed out one answer at a time: the first
  // to `/message`, the rest to each `/contact` save. Empty means it is not
  // asking for anything, which is every case written before #16.
  const asks = [...(options.asks ?? [])];
  const nextAsk = () => (asks.length ? asks.shift()! : null);

  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : {} });

    if (url.endsWith("/session")) {
      if (sessionFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({ sessionId: "vst_1", greeting: GREETING }) };
    }
    if (url.endsWith("/message")) {
      return {
        ok: true, status: 201,
        json: async () => ({ conversationId: "cnv_1", reply: REPLY, held: false, contactAsk: nextAsk() }),
      };
    }
    if (url.endsWith("/contact")) {
      if (options.contactFails) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true, status: 200,
        json: async () => ({ captured: ["x"], duplicateEmail: false, contactAsk: nextAsk() }),
      };
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
    const server = fakeServer();
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
    const server = fakeServer();
    const page = loadWidget({ fetch: server.fetch });

    await page.settle();

    expect(server.calls).toEqual([]);
    expect(page.launcher()).toBeUndefined();
  });

  it("holds the greeting until the visitor opens the panel", async () => {
    const server = fakeServer();
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
    const server = fakeServer();
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();

    expect(server.to("/session")).toHaveLength(1);
    expect(page.messages()).toEqual([GREETING]);
  });

  it("greets once, however many times the panel is opened and closed", async () => {
    const server = fakeServer();
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
    const server = fakeServer();
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
    const server = fakeServer();
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
    const server = fakeServer({ sessionFails: true });
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
    const server = fakeServer({ sessionFails: true });
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
    const server = fakeServer({ sessionFails: true });
    const page = loadWidget({ fetch: server.fetch });

    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();

    expect(page.messages()).toEqual(["Sorry, chat isn't available right now."]);
  });

  // The host page is somebody else's: our failures belong in our own logs.
  it("never warns a workspace's own site about a call of ours", async () => {
    const server = fakeServer({ sessionFails: true });
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
    const server = fakeServer();
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
    const server = fakeServer();
    const page = loadWidget({ fetch: server.fetch, workspaceId: null });

    page.domContentLoaded();
    await page.settle();

    expect(server.calls).toEqual([]);
    expect(page.launcher()).toBeUndefined();
    expect(page.warnings).toHaveLength(1);
  });

  it("takes the API origin from its own src, not from the host page", async () => {
    const server = fakeServer();
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

/**
 * Progressive contact capture, the client half (#16).
 *
 * The twin asks in words — the server decides when, from the lead score —
 * and this is the box those words point at. It is inline and it is never a
 * gate: the message composer stays live beside it, exactly as the header
 * comment on widget.js requires.
 */
describe("the field the twin asks for a contact detail with", () => {
  /** Load, open, and say something that draws the twin's reply. */
  async function chatting(server: ReturnType<typeof fakeServer>) {
    const page = loadWidget({ fetch: server.fetch });
    page.domContentLoaded();
    await page.settle();
    page.openPanel();
    await page.settle();
    page.type("I need 2 blue XL polos");
    await page.settle();
    return page;
  }

  it("shows no field while the reply asks for nothing", async () => {
    const page = await chatting(fakeServer());

    expect(page.contactAsk()).toBeNull();
  });

  it("puts one box on screen for exactly what the reply asked for", async () => {
    const page = await chatting(fakeServer({ asks: ["email"] }));

    expect(page.contactAsk()).toBe("email");
    expect(page.contactPlaceholder()).toBe("you@example.com");
  });

  // Saving a detail is not sending a message: it goes to its own endpoint,
  // and nothing about it appears in the transcript.
  it("sends what was typed to its own endpoint, not into the conversation", async () => {
    const server = fakeServer({ asks: ["name"] });
    const page = await chatting(server);

    page.typeContact("Priya Sharma");
    await page.settle();

    const [save] = server.to("/contact");
    expect(save!.method).toBe("POST");
    expect(save!.body.field).toBe("name");
    expect(save!.body.value).toBe("Priya Sharma");
    expect(save!.body.visitorId).toBe(server.to("/session")[0]!.body.visitorId);
    expect(server.to("/message")).toHaveLength(1);
    expect(page.messages()).toEqual([GREETING, "I need 2 blue XL polos", REPLY]);
  });

  it("moves to the one the server names next, rather than deciding for itself", async () => {
    const page = await chatting(fakeServer({ asks: ["name", "email"] }));

    page.typeContact("Priya Sharma");
    await page.settle();

    expect(page.contactAsk()).toBe("email");
    expect(page.contactPlaceholder()).toBe("you@example.com");
  });

  it("takes the box away once there is nothing left to ask", async () => {
    const page = await chatting(fakeServer({ asks: ["name"] }));

    page.typeContact("Priya Sharma");
    await page.settle();

    expect(page.contactAsk()).toBeNull();
  });

  // The server asks again on every turn until it has the thing; re-rendering
  // the box each time would wipe whatever they were part-way through typing.
  it("leaves a half-typed answer alone when the next reply asks the same thing", async () => {
    const page = await chatting(fakeServer({ asks: ["name", "name"] }));

    page.fillContact("Priya Sh");
    page.type("and 2 in olive");
    await page.settle();

    expect(page.contactAsk()).toBe("name");
    expect(page.contactValue()).toBe("Priya Sh");
  });

  it("saves nothing for an empty box", async () => {
    const server = fakeServer({ asks: ["name"] });
    const page = await chatting(server);

    page.typeContact("   ");
    await page.settle();

    expect(server.to("/contact")).toEqual([]);
    expect(page.contactAsk()).toBe("name");
  });

  // Not a gate: waving it away costs the visitor nothing, and it does not
  // come back at them for the rest of the visit.
  it("lets the visitor wave it away, and does not ask again this visit", async () => {
    const server = fakeServer({ asks: ["name", "email"] });
    const page = await chatting(server);

    page.skipContact();
    expect(page.contactAsk()).toBeNull();

    page.type("and 2 in olive");
    await page.settle();

    expect(page.contactAsk()).toBeNull();
    expect(server.to("/contact")).toEqual([]);
  });

  it("leaves the chat working when the save fails, and says nothing about it", async () => {
    const server = fakeServer({ contactFails: true, asks: ["name"] });
    const page = await chatting(server);

    page.typeContact("Priya Sharma");
    await page.settle();

    // Still on screen with what they typed, so one more press is the retry.
    expect(page.contactAsk()).toBe("name");
    expect(page.messages()).toEqual([GREETING, "I need 2 blue XL polos", REPLY]);
    expect(page.warnings).toEqual([]);

    page.type("are they in stock");
    await page.settle();
    expect(server.to("/message")).toHaveLength(2);
  });
});
