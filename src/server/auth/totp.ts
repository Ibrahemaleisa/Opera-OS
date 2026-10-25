import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) on HOTP (RFC 4226) with node:crypto only: HMAC-SHA-1, 6 digits, 30-second steps,
 * ±1 step accepted. Replay protection is the caller's: a matched step must be greater than the last
 * accepted one (`User.mfaLastStep`), written with a compare-and-set.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP value for a counter. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(at: Date | number = Date.now()): number {
  const ms = at instanceof Date ? at.getTime() : at;
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretB32: string, at: Date | number = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(at));
}

/**
 * Returns the matched time step, or null. Steps at or below `lastStep` are refused (replay), so the
 * same code — or an older one — never works twice.
 */
export function verifyTotp(secretB32: string, code: string, at: Date | number = Date.now(), lastStep: number | null = null): number | null {
  const digits = (code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(at);
  let matched: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    // compare every candidate (constant work), keep the latest match
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(digits)) && (lastStep === null || s > lastStep)) matched = s;
  }
  return matched;
}

/** otpauth:// URI for QR enrolment. The label is the account e-mail under the issuer "Opera". */
export function otpauthUri(secretB32: string, account: string, issuer = "Opera"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
