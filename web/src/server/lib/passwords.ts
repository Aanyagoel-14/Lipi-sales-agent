import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

const KEY_LEN = 64;

/**
 * scrypt from node:crypto rather than a bcrypt dependency: memory-hard, in the
 * standard library, and no native build to go wrong on a teammate's machine.
 * The salt is stored beside the hash, which is why the format is versioned.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);

  // Constant time: a fast reject leaks whether the prefix matched.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
