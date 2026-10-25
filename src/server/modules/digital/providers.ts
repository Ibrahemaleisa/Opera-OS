import { createHmac } from "node:crypto";
import type { Channel } from "@/generated/prisma/enums";
import { safeEqual } from "@/server/auth/crypto";

export interface OutboundMessage {
  to: string;
  subject?: string | null;
  body: string;
  /** stable id of our MessageJob — passed to providers that support client references */
  reference: string;
}

export interface SendResult {
  providerMessageId: string;
  /** SENT when accepted by the provider; delivery receipts arrive later via webhook */
  status: "SENT" | "DELIVERED";
}

export interface ProviderEvent {
  externalId: string; // unique id of the webhook event (idempotency)
  providerMessageId: string;
  status: "DELIVERED" | "READ" | "FAILED";
  error?: string;
}

/**
 * Messaging provider adapter. Live adapters are only used when credentials exist in the
 * environment; otherwise the SimulationProvider is used and every record is marked simulated.
 * WhatsApp is supported exclusively through the official WhatsApp Business Cloud API.
 */
export interface MessageProvider {
  key: string;
  channel: Channel;
  live: boolean;
  send(msg: OutboundMessage): Promise<SendResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

class SimulationProvider implements MessageProvider {
  key = "simulation";
  live = false;
  constructor(public channel: Channel) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    // Deterministic failure hook for testing retry paths: recipients ending in 0000 fail once.
    if (/0000$/.test(msg.to) && !msg.reference.endsWith(":retry")) throw new ProviderError("simulated transient failure", true);
    return { providerMessageId: `sim_${msg.reference}`, status: "SENT" };
  }
}

class SmtpProvider implements MessageProvider {
  key = "smtp";
  channel: Channel = "EMAIL";
  live = true;
  async send(msg: OutboundMessage): Promise<SendResult> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(process.env.SMTP_URL!);
    try {
      const info = await transport.sendMail({ from: process.env.EMAIL_FROM, to: msg.to, subject: msg.subject ?? "", text: msg.body, headers: { "X-Opera-Ref": msg.reference } });
      return { providerMessageId: info.messageId, status: "SENT" };
    } catch (e) {
      throw new ProviderError((e as Error).message, true);
    }
  }
}

/** Unifonic SMS REST API (official Saudi SMS aggregator). */
class UnifonicSmsProvider implements MessageProvider {
  key = "unifonic";
  channel: Channel = "SMS";
  live = true;
  async send(msg: OutboundMessage): Promise<SendResult> {
    const body = new URLSearchParams({ AppSid: process.env.UNIFONIC_APP_SID!, SenderID: process.env.UNIFONIC_SENDER_ID ?? "", Recipient: msg.to.replace(/^\+/, ""), Body: msg.body, CorrelationID: msg.reference });
    const res = await fetch("https://el.cloud.unifonic.com/rest/SMS/messages", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean | string; data?: { MessageID?: string | number }; message?: string };
    if (!res.ok || String(json.success) !== "true") throw new ProviderError(json.message ?? `HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    return { providerMessageId: String(json.data?.MessageID ?? msg.reference), status: "SENT" };
  }
}

/** Official WhatsApp Business Cloud API. Requires a pre-approved template for business-initiated messages. */
class WhatsAppCloudProvider implements MessageProvider {
  key = "whatsapp_cloud";
  channel: Channel = "WHATSAPP";
  live = true;
  async send(msg: OutboundMessage): Promise<SendResult> {
    const template = process.env.WHATSAPP_TEMPLATE_NAME;
    const payload = template
      ? { messaging_product: "whatsapp", to: msg.to.replace(/^\+/, ""), type: "template", template: { name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANG ?? "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: msg.body.slice(0, 1000) }] }] } }
      : null;
    if (!payload) throw new ProviderError("WHATSAPP_TEMPLATE_NAME is required for business-initiated messages", false);
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok || !json.messages?.[0]?.id) throw new ProviderError(json.error?.message ?? `HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    return { providerMessageId: json.messages[0].id, status: "SENT" };
  }
}

export function providerStatus() {
  return {
    EMAIL: process.env.SMTP_URL ? "smtp" : null,
    SMS: process.env.UNIFONIC_APP_SID ? "unifonic" : null,
    WHATSAPP: process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID ? "whatsapp_cloud" : null,
  } as Record<Channel, string | null>;
}

/** Resolves the adapter for a channel. LIVE mode is only honoured when credentials exist. */
export function resolveProvider(channel: Channel, configuredMode: string): MessageProvider {
  const available = providerStatus()[channel];
  if (configuredMode === "LIVE" && available) {
    if (channel === "EMAIL") return new SmtpProvider();
    if (channel === "SMS") return new UnifonicSmsProvider();
    if (channel === "WHATSAPP") return new WhatsAppCloudProvider();
  }
  return new SimulationProvider(channel);
}

// ── Webhook verification ───────────────────────────────────────────────────

function hmac(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Verifies an inbound webhook signature and parses provider events. Returns null if invalid. */
export function verifyAndParseWebhook(provider: string, rawBody: string, headers: Headers): ProviderEvent[] | null {
  if (provider === "simulation") {
    const secret = process.env.WEBHOOK_SECRET_SIMULATION;
    const sig = headers.get("x-opera-signature") ?? "";
    if (!secret || !safeEqual(hmac(secret, rawBody), sig)) return null;
    const j = JSON.parse(rawBody) as { id: string; messageId: string; status: ProviderEvent["status"]; error?: string };
    return [{ externalId: j.id, providerMessageId: j.messageId, status: j.status, error: j.error }];
  }
  if (provider === "whatsapp_cloud") {
    const secret = process.env.WHATSAPP_APP_SECRET;
    const sig = (headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
    if (!secret || !safeEqual(hmac(secret, rawBody), sig)) return null;
    const j = JSON.parse(rawBody) as { entry?: { changes?: { value?: { statuses?: { id: string; status: string; timestamp: string; errors?: { title: string }[] }[] } }[] }[] };
    const out: ProviderEvent[] = [];
    for (const e of j.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
      const status = s.status === "delivered" ? "DELIVERED" : s.status === "read" ? "READ" : s.status === "failed" ? "FAILED" : null;
      if (status) out.push({ externalId: `${s.id}:${s.status}:${s.timestamp}`, providerMessageId: s.id, status, error: s.errors?.[0]?.title });
    }
    return out;
  }
  if (provider === "unifonic") {
    const secret = process.env.WEBHOOK_SECRET_UNIFONIC;
    const sig = headers.get("x-unifonic-signature") ?? "";
    if (!secret || !safeEqual(hmac(secret, rawBody), sig)) return null;
    const j = JSON.parse(rawBody) as { messageId: string; status: string; eventId?: string };
    const status = /deliver/i.test(j.status) ? "DELIVERED" : /fail|undeliver|reject/i.test(j.status) ? "FAILED" : null;
    return status ? [{ externalId: j.eventId ?? `${j.messageId}:${j.status}`, providerMessageId: j.messageId, status }] : [];
  }
  return null;
}

export function signSimulationWebhook(body: string) {
  return hmac(process.env.WEBHOOK_SECRET_SIMULATION ?? "", body);
}
