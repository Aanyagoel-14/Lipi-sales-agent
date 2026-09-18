import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ComposioWebhookError,
  composio,
  verifyComposioWebhook,
  versionForTool,
} from "@/server/lib/composio";
import { toolkitVersions } from "@/server/channels/registry";
import { fakeComposio } from "./fakes/composio";

const SECRET = "test-webhook-secret";

const event = {
  id: "msg_01",
  timestamp: "2026-09-19T10:00:00.000Z",
  type: "composio.trigger.message",
  metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", connected_account_id: "ca_1" },
  data: { message_id: "m1" },
};

/** A delivery signed the way Composio signs: `v1,` + base64(HMAC("{id}.{ts}.{body}")). */
function signed(options: { secret?: string; body?: string; at?: number; version?: string; id?: string } = {}) {
  const body = options.body ?? JSON.stringify(event);
  const id = options.id ?? "msg_01";
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const key = options.secret ?? SECRET;
  const raw = key.startsWith("whsec_") ? Buffer.from(key.slice(6), "base64") : Buffer.from(key, "utf8");
  const signature = createHmac("sha256", raw).update(`${id}.${at}.${body}`).digest("base64");
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(at),
      "webhook-signature": `v1,${signature}`,
      "x-composio-webhook-version": options.version ?? "V3",
    } as Record<string, string>,
  };
}

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ComposioWebhookError) return error.reason;
    throw error;
  }
  return "accepted";
};

describe("webhook verification", () => {
  it("accepts a correctly signed V3 delivery and returns the event", () => {
    const { body, headers } = signed();
    expect(verifyComposioWebhook(body, headers, SECRET)).toEqual(event);
  });

  it("reads the headers case-insensitively and from a Headers object", () => {
    const { body, headers } = signed();
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verifyComposioWebhook(body, upper, SECRET).id).toBe("msg_01");
    expect(verifyComposioWebhook(body, new Headers(headers), SECRET).id).toBe("msg_01");
  });

  it("rejects a bad signature", () => {
    const { body, headers } = signed();
    headers["webhook-signature"] = "v1," + Buffer.alloc(32).toString("base64");
    expect(reasonOf(() => verifyComposioWebhook(body, headers, SECRET))).toBe("bad_signature");
  });

  it("rejects a body other than the one signed", () => {
    const { headers } = signed();
    const tampered = JSON.stringify({ ...event, data: { message_id: "m2" } });
    expect(reasonOf(() => verifyComposioWebhook(tampered, headers, SECRET))).toBe("bad_signature");
  });

  it("rejects a signature made with a different secret", () => {
    const { body, headers } = signed({ secret: "someone-else" });
    expect(reasonOf(() => verifyComposioWebhook(body, headers, SECRET))).toBe("bad_signature");
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])("rejects a delivery missing %s", (name) => {
    const { body, headers } = signed();
    delete headers[name];
    expect(reasonOf(() => verifyComposioWebhook(body, headers, SECRET))).toBe("missing_header");
  });

  it("rejects a timestamp older than the tolerance window, and one from the future", () => {
    const now = Math.floor(Date.now() / 1000);
    const old = signed({ at: now - 301 });
    expect(reasonOf(() => verifyComposioWebhook(old.body, old.headers, SECRET))).toBe("stale");
    const future = signed({ at: now + 301 });
    expect(reasonOf(() => verifyComposioWebhook(future.body, future.headers, SECRET))).toBe("stale");
    const edge = signed({ at: now - 299 });
    expect(reasonOf(() => verifyComposioWebhook(edge.body, edge.headers, SECRET))).toBe("accepted");
  });

  it("rejects a payload version other than V3", () => {
    const v2 = signed({ version: "V2" });
    expect(reasonOf(() => verifyComposioWebhook(v2.body, v2.headers, SECRET))).toBe("bad_version");
    const none = signed();
    delete none.headers["x-composio-webhook-version"];
    expect(reasonOf(() => verifyComposioWebhook(none.body, none.headers, SECRET))).toBe("bad_version");
  });

  it("verifies with a raw secret and with a whsec_-prefixed one", () => {
    const prefixed = "whsec_" + Buffer.from("thirty-two-byte-secret-material!").toString("base64");
    const spec = signed({ secret: prefixed });
    expect(verifyComposioWebhook(spec.body, spec.headers, prefixed).type).toBe(event.type);

    // The SDK signs with the secret's raw characters, prefix included; that
    // form has to verify too, or the first live delivery would be a 401.
    const sdkStyle = createHmac("sha256", prefixed)
      .update(`${spec.headers["webhook-id"]}.${spec.headers["webhook-timestamp"]}.${spec.body}`)
      .digest("base64");
    spec.headers["webhook-signature"] = `v1,${sdkStyle}`;
    expect(verifyComposioWebhook(spec.body, spec.headers, prefixed).type).toBe(event.type);
  });

  it("accepts a header carrying several signatures when one matches", () => {
    const { body, headers } = signed();
    headers["webhook-signature"] = `v1,${Buffer.alloc(32).toString("base64")} ${headers["webhook-signature"]}`;
    expect(verifyComposioWebhook(body, headers, SECRET).id).toBe("msg_01");
  });

  it("rejects a signed body that is not a V3 event", () => {
    const junk = signed({ body: JSON.stringify({ hello: "world" }) });
    expect(reasonOf(() => verifyComposioWebhook(junk.body, junk.headers, SECRET))).toBe("bad_payload");
    const notJson = signed({ body: "not json" });
    expect(reasonOf(() => verifyComposioWebhook(notJson.body, notJson.headers, SECRET))).toBe("bad_payload");
  });

  it("agrees with the SDK's own verifier on the same vectors", async () => {
    // Same secret, same headers, same body: the two implementations must
    // reach the same verdict, or a delivery the SDK would accept gets a 401.
    const { Composio } = await import("@composio/core");
    const sdk = new Composio({ apiKey: "not-used", allowTracking: false });
    const good = signed();
    const sdkResult = await sdk.triggers.verifyWebhook({
      id: good.headers["webhook-id"]!,
      timestamp: good.headers["webhook-timestamp"]!,
      signature: good.headers["webhook-signature"]!,
      payload: good.body,
      secret: SECRET,
    });
    expect(sdkResult.version).toBe("V3");
    expect(verifyComposioWebhook(good.body, good.headers, SECRET).id).toBe((sdkResult.rawPayload as { id: string }).id);

    const bad = signed({ secret: "wrong" });
    await expect(sdk.triggers.verifyWebhook({
      id: bad.headers["webhook-id"]!,
      timestamp: bad.headers["webhook-timestamp"]!,
      signature: bad.headers["webhook-signature"]!,
      payload: bad.body,
      secret: SECRET,
    })).rejects.toThrow();
    expect(reasonOf(() => verifyComposioWebhook(bad.body, bad.headers, SECRET))).toBe("bad_signature");
  });
});

describe("the client under test", () => {
  it("is the fake, and the fake verifies with its own secret", () => {
    expect(composio()).toBe(fakeComposio);
    const { body, headers } = fakeComposio.sign({ type: "composio.trigger.disabled", data: { id: "ti_1" } });
    expect(composio().verifyWebhook(body, headers).data).toEqual({ id: "ti_1" });
  });

  it("records calls and answers from scripts", async () => {
    fakeComposio.execute.respond("TELEGRAM_SEND_MESSAGE", { successful: false, data: {}, error: "Forbidden: bot was blocked" });
    const result = await composio().execute("TELEGRAM_SEND_MESSAGE", {
      userId: "ws_1", connectedAccountId: "ca_1", arguments: { chat_id: "555", text: "hi" },
    });
    expect(result.successful).toBe(false);
    expect(fakeComposio.calls.execute).toEqual([
      { slug: "TELEGRAM_SEND_MESSAGE", userId: "ws_1", connectedAccountId: "ca_1", arguments: { chat_id: "555", text: "hi" } },
    ]);
    // Reset between tests: a script never leaks into the next one.
    expect(fakeComposio.calls.link).toEqual([]);
  });
});

describe("toolkit versions", () => {
  it("resolves a tool's version from its toolkit prefix", () => {
    expect(versionForTool("WHATSAPP_SEND_MESSAGE")).toBe(toolkitVersions().whatsapp);
    expect(versionForTool("GMAIL_REPLY_TO_THREAD")).toBe(toolkitVersions().gmail);
  });

  it("refuses a toolkit the registry has not pinned rather than falling back to latest", () => {
    expect(() => versionForTool("GITHUB_GET_REPOS")).toThrow(/No pinned toolkit version/);
  });
});

describe("composio:subscribe", () => {
  it("exits non-zero without COMPOSIO_API_KEY, before touching the network", () => {
    // An empty string counts as set to dotenv, so a developer's real key in
    // .env cannot leak into this run.
    let status = 0;
    let output = "";
    try {
      execFileSync("npx", ["tsx", "scripts/composio-subscribe.ts"], {
        env: { ...process.env, COMPOSIO_API_KEY: "" },
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (error) {
      const failed = error as { status?: number; stderr?: Buffer };
      status = failed.status ?? -1;
      output = failed.stderr?.toString() ?? "";
    }
    expect(status).toBe(1);
    expect(output).toContain("COMPOSIO_API_KEY is not set");
  }, 60_000);
});
