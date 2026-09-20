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

/**
 * Shopify signs a webhook body with the *app's* API secret, base64 rather
 * than hex, and the deployment has one app — so this is the Meta story again
 * and the same rule applies: the raw bytes are what was signed, so the body
 * must never be parsed and re-serialised before it gets here.
 */
export function verifyShopifyWebhook(raw: Buffer, header: string | undefined, apiSecret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", apiSecret).update(raw).digest("base64");
  return secretsMatch(expected, header);
}

/**
 * X signs an Account Activity delivery with the *app's* consumer secret —
 * Meta's story again, and the same rule about the raw bytes — but the digest
 * is base64 and the header is `x-twitter-webhooks-signature`. A verifier that
 * compared hex here would refuse every genuine delivery.
 */
export function verifyXSignature(raw: Buffer, header: string | undefined, consumerSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", consumerSecret).update(raw).digest("base64");
  return secretsMatch(expected, header.slice("sha256=".length));
}

/**
 * The answer to X's Challenge-Response Check: the HMAC of the token X sent,
 * keyed by the same consumer secret, base64 and prefixed the same way.
 *
 * X makes this GET on registration, after every manual re-validation and
 * once an hour thereafter; a webhook that stops answering it is marked
 * invalid and stops receiving events, so this is not a one-off setup step.
 */
export function crcResponseToken(crcToken: string, consumerSecret: string): string {
  return `sha256=${createHmac("sha256", consumerSecret).update(crcToken).digest("base64")}`;
}

/**
 * The OAuth callback is signed differently: Shopify HMACs the query string
 * itself, with `hmac` removed, the remaining parameters sorted by key and
 * joined as `key=value&…`, and the digest in hex. `signature` is dropped too
 * — it belongs to the retired app-proxy scheme and Shopify excludes it.
 *
 * This proves the redirect came from Shopify. It does not prove the operator
 * meant to start it, which is what `installState` is for.
 */
export function verifyShopifyCallback(search: string, apiSecret: string): boolean {
  const given = new URLSearchParams(search).get("hmac");
  if (!given) return false;

  // Over the pairs exactly as they arrived, percent-encoding included —
  // decoding first would sign a different string than Shopify signed for any
  // value carrying a reserved character (`host` is base64 and routinely does).
  const message = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair && !/^(hmac|signature)=/.test(pair))
    .sort()
    .join("&");

  return secretsMatch(createHmac("sha256", apiSecret).update(message).digest("hex"), given);
}

export const newWebhookSecret = () => randomBytes(24).toString("base64url");

/**
 * The signature Lipi puts on a webhook it *sends*.
 *
 * Meta and Shopify both sign the raw bytes with a shared secret and hand over
 * the digest in a header, and `verifyMetaSignature` above is how we check
 * theirs — so outbound is the same convention turned around rather than a
 * second one. Two differences, both deliberate:
 *
 * The timestamp is inside the signed message, not only beside it. Signing the
 * body alone makes every delivery replayable for ever by anyone who once saw
 * one; signing `<timestamp>.<body>` lets the subscriber refuse anything older
 * than its own tolerance, and it cannot be moved without breaking the digest.
 *
 * The digest is hex and prefixed `sha256=`, which is Meta's spelling, so a
 * subscriber who has already written a Meta verifier changes only the secret.
 */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Constant-time compare for shared secrets that arrive in a header. */
export function secretsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
