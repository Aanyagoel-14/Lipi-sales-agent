import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { decrypt, encrypt, newWebhookSecret, secretsMatch, verifyMetaSignature } from "@/server/lib/crypto";

describe("credential encryption", () => {
  it("round-trips a secret", () => {
    const token = "1234567890:AAExampleBotToken";
    expect(decrypt(encrypt(token))).toBe(token);
  });

  it("produces different ciphertext each time", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("refuses a tampered payload instead of returning garbage", () => {
    const cipher = encrypt("secret");
    const parts = cipher.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(decrypt(parts.join("."))).toBeNull();
  });

  it("returns null for nonsense rather than throwing", () => {
    expect(decrypt("not-a-cipher")).toBeNull();
  });
});

describe("webhook authenticity", () => {
  const secret = "app-secret";
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct Meta signature", () => {
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a forged signature", () => {
    expect(verifyMetaSignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a signature over different bytes", () => {
    expect(verifyMetaSignature(Buffer.from("other"), signature, secret)).toBe(false);
  });

  it("compares shared secrets without leaking length mismatches", () => {
    const s = newWebhookSecret();
    expect(secretsMatch(s, s)).toBe(true);
    expect(secretsMatch(s, "short")).toBe(false);
  });
});
