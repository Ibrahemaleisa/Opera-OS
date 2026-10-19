import { randomBytes } from "node:crypto";

/** Collision-resistant, URL-safe, sortable-ish id (time prefix + randomness), cuid-compatible length. */
export function createId(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(10).toString("base64url").replace(/[-_]/g, "x").toLowerCase();
  return `c${time}${rand}`.slice(0, 25);
}

/** Short human-friendly code segment, uppercase base32 without ambiguous chars. */
export function shortCode(len = 6): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
