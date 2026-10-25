import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET must be set (>= 32 chars)");
    return "dev-only-insecure-secret-change-me-0000000000";
  }
  return s;
}

// ── Secrets at rest (MFA) ────────────────────────────────────────────────────

const SECRET_KEY_INFO = "opera:mfa:totp-secret:v1";

/** AES-256-GCM key derived from APP_SECRET with HKDF-SHA256 (a separate key per purpose). */
function secretKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret(), "opera:mfa", SECRET_KEY_INFO, 32));
}

/** Encrypts a small secret (a TOTP seed): `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Decrypts `encryptSecret` output; throws if it was tampered with or the key changed. */
export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
