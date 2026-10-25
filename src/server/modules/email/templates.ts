import { getMessages, translateKey, type Locale } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";
import type { NotificationEmailParams } from "@/server/modules/notifications/notify";
import type { DigestEmailParams, DigestItem } from "@/server/modules/notifications/digest";

/**
 * Bilingual transactional templates. Each message renders in the recipient's locale (Arabic RTL or
 * English LTR) as HTML + plain text. Content is limited to the notice title (code + title), a count
 * and a deep link: never VIP contact data, protocol notes or amounts (BUSINESS_RULES §3.1 rule 5).
 * Signed "Opera" (§10); a workspace e-mail never claims that Opera runs the customer's event.
 */

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export type SystemTemplate = "password_reset" | "password_changed" | "mfa_enabled" | "mfa_disabled" | "mfa_reset" | "recovery_code_used";

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Shared shell: one column, inline styles only (mail clients drop <style>), dir + lang on the root. */
function layout(locale: Locale, o: { heading: string; lines: string[]; button?: { label: string; href: string }; footer: string; preheader?: string }): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  const align = locale === "ar" ? "right" : "left";
  const font = locale === "ar" ? "'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif" : "Jost,'Segoe UI',Arial,sans-serif";
  const btn = o.button
    ? `<tr><td style="padding:8px 0 4px"><a href="${esc(o.button.href)}" style="display:inline-block;background:#64228A;color:#ffffff;text-decoration:none;border-radius:8px;padding:10px 18px;font-weight:600">${esc(o.button.label)}</a></td></tr>
<tr><td style="padding:8px 0 0;font-size:12px;color:#6b6475;direction:ltr;text-align:${align};word-break:break-all"><bdi>${esc(o.button.href)}</bdi></td></tr>`
    : "";
  return `<!doctype html>
<html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f3f7">
${o.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(o.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e7e2ec;font-family:${font};color:#1f1a24;text-align:${align}">
<tr><td style="padding:20px 24px 0;font-size:15px;font-weight:700;letter-spacing:.04em;color:#64228A">Opera</td></tr>
<tr><td style="padding:12px 24px 0;font-size:18px;font-weight:600;line-height:1.5">${esc(o.heading)}</td></tr>
<tr><td style="padding:8px 24px 16px;font-size:14px;line-height:1.7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${o.lines.map((l) => `<tr><td style="padding:4px 0">${esc(l)}</td></tr>`).join("\n")}
${btn}
</table></td></tr>
<tr><td style="padding:14px 24px 20px;border-top:1px solid #efebf2;font-size:12px;line-height:1.6;color:#6b6475">${esc(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

function textBody(o: { heading: string; lines: string[]; button?: { label: string; href: string }; footer: string }): string {
  return [o.heading, "", ...o.lines, ...(o.button ? ["", `${o.button.label}: ${o.button.href}`] : []), "", "—", o.footer].join("\n");
}

function render(locale: Locale, subject: string, body: { heading: string; lines: string[]; button?: { label: string; href: string }; footer: string; preheader?: string }): RenderedMail {
  return { subject, html: layout(locale, body), text: textBody(body) };
}

/** Deep link for a recipient's surface (the stored link is relative to the agency workspace). */
export function deepLink(orgSlug: string, p: Pick<NotificationEmailParams, "link" | "surface">): string {
  const base = appUrl();
  if (p.surface === "o") return `${base}/o/${orgSlug}${p.link ?? "/notifications"}`;
  if (p.surface === "portal") {
    const proj = p.link?.match(/^\/projects\/([^/?#]+)/)?.[1];
    return proj ? `${base}/portal/${orgSlug}/projects/${proj}` : `${base}/portal/${orgSlug}`;
  }
  return `${base}/${p.surface}/${orgSlug}`;
}

/** The e-mail for an in-app notice. */
export function renderNotificationEmail(locale: Locale, p: NotificationEmailParams, ctx: { orgSlug: string; orgName: string }): RenderedMail {
  const m = getMessages(locale);
  const t = (k: string, v?: Record<string, string | number | null | undefined>) => translateKey(m, k, v);
  const title = t(p.titleKey, p.params);
  const lines: string[] = [];
  if (p.escalationLevel >= 2) lines.push(t("notif.email.escalationLine", { level: p.escalationLevel }));
  if (p.priority === "CRITICAL") lines.push(t("notif.email.critical"));
  lines.push(t("notif.email.openHint"));
  const subject = `Opera — ${title}`;
  return render(locale, subject.length > 180 ? `${subject.slice(0, 177)}…` : subject, {
    heading: title,
    preheader: title,
    lines,
    button: { label: t("notif.email.open"), href: deepLink(ctx.orgSlug, p) },
    footer: t("notif.email.footer", { org: ctx.orgName }),
  });
}

/** Account security mail (global, no organisation). `secret` carries the reset link: rendered, never stored. */
export function renderSystemEmail(locale: Locale, template: SystemTemplate, params: Record<string, string | number | null>, secret?: { link?: string }): RenderedMail {
  const m = getMessages(locale);
  const t = (k: string, v?: Record<string, string | number | null | undefined>) => translateKey(m, k, v);
  const when = params.at ? formatDateTime(String(params.at), { locale }) : "";
  const footer = t("auth.mail.footer");
  const ipLine = params.ip ? t("auth.mail.ipLine", { ip: String(params.ip), time: when }) : t("auth.mail.timeLine", { time: when });
  switch (template) {
    case "password_reset":
      // bilingual subject so it is recognisable whatever the mailbox language (UX note 5)
      return render(locale, "Opera — رابط استعادة كلمة المرور / Password reset link", {
        heading: t("auth.mail.resetHeading"),
        lines: [t("auth.mail.resetBody"), ipLine, t("auth.mail.resetIgnore")],
        button: secret?.link ? { label: t("auth.mail.resetButton"), href: secret.link } : undefined,
        footer,
      });
    case "password_changed":
      return render(locale, `Opera — ${t("auth.mail.changedHeading")}`, { heading: t("auth.mail.changedHeading"), lines: [t("auth.mail.changedBody"), ipLine, t("auth.mail.notYou")], footer });
    case "mfa_enabled":
      return render(locale, `Opera — ${t("auth.mail.mfaEnabledHeading")}`, { heading: t("auth.mail.mfaEnabledHeading"), lines: [t("auth.mail.mfaEnabledBody"), ipLine, t("auth.mail.notYou")], footer });
    case "mfa_disabled":
      return render(locale, `Opera — ${t("auth.mail.mfaDisabledHeading")}`, { heading: t("auth.mail.mfaDisabledHeading"), lines: [t("auth.mail.mfaDisabledBody"), ipLine, t("auth.mail.notYou")], footer });
    case "mfa_reset":
      return render(locale, `Opera — ${t("auth.mail.mfaResetHeading")}`, { heading: t("auth.mail.mfaResetHeading"), lines: [t("auth.mail.mfaResetBody", { org: params.org ?? "" }), t("auth.mail.timeLine", { time: when }), t("auth.mail.notYou")], footer });
    case "recovery_code_used":
      return render(locale, `Opera — ${t("auth.mail.recoveryUsedHeading")}`, {
        heading: t("auth.mail.recoveryUsedHeading"),
        lines: [t("auth.mail.recoveryUsedBody", { n: params.remaining ?? 0 }), ipLine, t("auth.mail.notYou")],
        footer,
      });
  }
}

/**
 * The daily digest (§3.2 NT rule 2): a calm "here's what needs you" note — a greeting, at most three
 * items per section, and one link to My work for the rest. Empty sections are left out.
 */
export function renderDigestEmail(locale: Locale, p: DigestEmailParams, ctx: { orgSlug: string; orgName: string }): RenderedMail {
  const m = getMessages(locale);
  const t = (k: string, v?: Record<string, string | number | null | undefined>) => translateKey(m, k, v);
  const d = p.digest;
  const lines: string[] = [t("notif.digestMail.intro")];
  const section = (labelKey: string, count: number, items: DigestItem[]) => {
    if (!count) return;
    lines.push("", t(labelKey, { count }));
    for (const i of items) lines.push(`• ${i.title}${i.code ? ` (${i.code})` : ""}`);
    if (count > items.length) lines.push(t("notif.digestMail.more", { n: count - items.length }));
  };
  section("notif.digestMail.approvals", d.approvalsCount, d.approvals);
  section("notif.digestMail.overdue", d.overdueCount, d.overdue);
  section("notif.digestMail.dueToday", d.dueTodayCount, d.dueToday);
  if (d.mentions) lines.push("", t("notif.digestMail.mentions", { count: d.mentions }));
  const total = d.overdueCount + d.dueTodayCount + d.approvalsCount + d.mentions;
  return render(locale, `Opera — ${t("notif.digestMail.subject", { count: total })}`, {
    heading: t("notif.digestMail.heading"),
    lines: lines.filter((l, i) => !(l === "" && lines[i - 1] === "")),
    button: { label: t("notif.digestMail.open"), href: deepLink(ctx.orgSlug, p) },
    footer: t("notif.digestMail.footer", { org: ctx.orgName }),
  });
}
