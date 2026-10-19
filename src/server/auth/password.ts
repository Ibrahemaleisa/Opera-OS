import { hash, verify } from "@node-rs/argon2";

// Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string) {
  return hash(password, OPTS);
}

export async function verifyPassword(hashed: string, password: string) {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** Minimal policy: length + not trivially weak. Checked server-side on every password set. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("auth.passwordTooShort");
  if (/^(.)\1+$/.test(password) || /^(?:12345|password|qwerty)/i.test(password)) problems.push("auth.passwordWeak");
  return problems;
}
