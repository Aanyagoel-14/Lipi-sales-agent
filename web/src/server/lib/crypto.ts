import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { env } from "../env";

/**
 * Channel credentials are secrets belonging to someone else's business, so
 * they are encrypted at rest rather than stored as plain columns. AES-256-GCM
 * gives us authentication too: a tampered ciphertext fails to decrypt instead
 * of yielding garbage we might then send to a provider.
 *
 * The key is derived from APP_SECRET. Rotating that secret invalidates stored
 * credentials by design — they must be re-entered, not silently mis-decrypted.
 */
const key = createHash("sha256").update(env.APP_SECRET).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function decrypt(payload: string): string | null {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered payload. Never guess.
    return null;
  }
}

/** Meta signs webhook bodies with the app secret; the raw body is what is signed. */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const newWebhookSecret = () => randomBytes(24).toString("base64url");

/** Constant-time compare for shared secrets that arrive in a header. */
export function secretsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
