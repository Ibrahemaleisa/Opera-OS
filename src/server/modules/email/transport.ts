/**
 * Transactional e-mail transport (notifications and account security mail).
 *
 * SMTP via nodemailer when `SMTP_URL` is set; otherwise every message ends SIMULATED: rendered and
 * recorded, never sent, never reported as sent (BUSINESS_RULES §3.3 rule 4). The campaign transport in
 * digital/providers.ts is separate: this module never touches campaign messages.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** our stable reference (delivery id) — sent as X-Opera-Ref so a duplicate is traceable */
  reference: string;
}

export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }): Promise<{ messageId?: string }>;
}

/** A send failure, classified for the retry policy. */
export class MailError extends Error {
  constructor(
    message: string,
    /** permanent (5xx, invalid address): no retry, DEAD at once */
    public permanent: boolean,
  ) {
    super(message);
    this.name = "MailError";
  }
}

let testTransport: MailTransport | null = null;
let cached: { url: string; transport: MailTransport } | null = null;

/** Tests only: route mail through an in-process transport (e.g. nodemailer's jsonTransport). */
export function setMailTransportForTests(t: MailTransport | null) {
  testTransport = t;
}

/** Whether a real transport exists in this deployment. */
export function smtpConfigured(): boolean {
  return !!testTransport || !!process.env.SMTP_URL;
}

export function mailFrom(): string {
  return process.env.EMAIL_FROM || "Opera <no-reply@localhost>";
}

async function transport(): Promise<MailTransport> {
  if (testTransport) return testTransport;
  const url = process.env.SMTP_URL;
  if (!url) throw new MailError("smtp_not_configured", false);
  if (cached?.url === url) return cached.transport;
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport(url) as unknown as MailTransport;
  cached = { url, transport: t };
  return t;
}

/** Sends one message. Throws MailError (classified) on failure. */
export async function sendMail(msg: MailMessage): Promise<{ providerMessageId: string }> {
  const t = await transport();
  try {
    const info = await t.sendMail({ from: mailFrom(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: { "X-Opera-Ref": msg.reference } });
    return { providerMessageId: info.messageId || msg.reference };
  } catch (e) {
    throw classifyMailError(e);
  }
}

/**
 * Permanent: an SMTP 5xx reply (invalid mailbox, policy rejection) or no valid recipient. Everything
 * else — 4xx replies, connection and timeout errors — is transient and retried with backoff.
 */
export function classifyMailError(e: unknown): MailError {
  if (e instanceof MailError) return e;
  const err = e as { message?: string; responseCode?: number; code?: string; response?: string };
  const code = typeof err.responseCode === "number" ? err.responseCode : null;
  const text = (err.response || err.message || "send failed").toString().replace(/\s+/g, " ").slice(0, 300);
  const permanent = (code !== null && code >= 500 && code < 600) || (err.code === "EENVELOPE" && code === null);
  return new MailError(code && !text.startsWith(String(code)) ? `${code} ${text}`.slice(0, 300) : text, permanent);
}
