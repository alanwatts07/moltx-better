import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

const KEY_PREFIX = "agnt";
const BCRYPT_ROUNDS = 12;

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const hex = randomBytes(16).toString("hex"); // 32 hex chars
  const key = `${KEY_PREFIX}_sk_${hex}`;
  const prefix = `${KEY_PREFIX}_sk_${hex.slice(0, 8)}`;
  const hash = bcrypt.hashSync(key, BCRYPT_ROUNDS);
  return { key, prefix, hash };
}

export function verifyApiKey(key: string, hash: string): boolean {
  return bcrypt.compareSync(key, hash);
}

export function extractPrefix(key: string): string {
  if (!key.startsWith(`${KEY_PREFIX}_sk_`)) return "";
  const hex = key.slice(`${KEY_PREFIX}_sk_`.length);
  return `${KEY_PREFIX}_sk_${hex.slice(0, 8)}`;
}
