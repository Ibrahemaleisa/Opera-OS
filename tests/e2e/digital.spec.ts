import { expect, test, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import pg from "pg";

/**
 * Digital invitations (synthetic data, simulation provider only):
 * bulk campaign requires four-eyes approval → simulated send → recipient RSVP via tokenised link →
 * QR entry code → check-in desk.
 */
const stamp = Date.now().toString(36);
const slug = `dg-${stamp}`;
const PASS = "E2e-Strong-Pass-2026";
const SAMPLE = path.join(process.cwd(), "samples/vip-recipients-ar.xlsx");

async function invite(page: Page, email: string, roleLabel: string) {
  await page.goto(`/o/${slug}/settings/members`);
  await page.getByRole("button", { name: "دعوة مستخدم" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input[name=email]").fill(email);
  await dialog.locator("select[name=roleId]").selectOption({ label: roleLabel });
  await dialog.getByRole("button", { name: "دعوة مستخدم" }).click();
  const link = await dialog.getByTestId("invite-link").inputValue();
  await page.keyboard.press("Escape");
  return new URL(link).pathname;
}

async function accept(browser: Browser, invitePath: string, name: string) {
  const page = await (await browser.newContext({ locale: "ar-SA" })).newPage();
  await page.goto(invitePath);
  await page.fill("#name", name);
  await page.fill("#password", PASS);
  await page.getByRole("button", { name: "قبول الدعوة" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/invite"));
  return page;
}

/** The RSVP token only exists inside the (simulated) outbound message body, as it would in a real SMS. */
async function rsvpTokenFromOutbox(campaignId: string) {
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(`SELECT m.body, m.simulated FROM "MessageJob" m JOIN "DigitalInvitation" i ON i.id = m."invitationId" WHERE i."campaignId" = $1 AND m.status = 'SENT' ORDER BY m."createdAt" LIMIT 1`, [campaignId]);
    expect(r.rows[0]?.simulated).toBe(true);
    return /\/rsvp\/([A-Za-z0-9_-]+)/.exec(r.rows[0].body)![1];
  } finally {
    await client.end();
  }
}

test("digital campaign: approval gate → simulated send → RSVP → QR check-in", async ({ page, browser }) => {
  await page.goto("/register");
  await page.fill("#name", "مدير الحملات");
  await page.fill("#email", `owner-${stamp}@example.test`);
  await page.fill("#password", PASS);
  await page.fill("#orgName", `وكالة الدعوات ${stamp}`);
  await page.fill("#orgSlug", slug);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/o/${slug}`);
  const directorInvite = await invite(page, `dir-${stamp}@example.test`, "مدير العمليات");

  await page.goto(`/o/${slug}/projects/new`);
  await page.getByTestId("project-name").fill("حفل الاستقبال التجريبي");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("event-start").fill("2026-12-20T19:00");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("tpl-vip-digital-campaign").click();
  await expect(page.getByTestId("tpl-vip-digital-campaign")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]+$/);
  const projectPath = new URL(page.url()).pathname;

  // recipients come from the shared registry (imported once via the Import Studio)
  await page.goto(`${projectPath}/delivery/imports`);
  await page.getByTestId("import-file").setInputFiles(SAMPLE);
  await page.getByTestId("import-upload").click();
  await page.waitForURL(/\/delivery\/imports\/c[a-z0-9]+$/);
  await page.getByTestId("import-validate").click();
  await page.getByTestId("skip-duplicates").click();
  await page.getByTestId("skip-invalid").click();
  const acceptPartial = page.getByTestId("accept-partial");
  if (await acceptPartial.isVisible()) await acceptPartial.click();
  await page.getByTestId("import-commit").click();
  await expect(page.getByText(/تم اعتماد \d+ سجل/)).toBeVisible();

  // the template created a draft campaign; switch it to SMS and add the audience
  await page.goto(`${projectPath}/digital`);
  await page.locator(`a[href^="${projectPath}/digital/"]`).first().click();
  await page.waitForURL(/\/digital\/c[a-z0-9]+$/);
  const campaignPath = new URL(page.url()).pathname;
  const campaignId = campaignPath.split("/").pop()!;
  await expect(page.getByText("وضع المحاكاة").first()).toBeVisible();
  await page.locator("select[name=channel]").selectOption("SMS");
  await page.getByRole("button", { name: "حفظ" }).click();
  await page.getByTestId("audience-add-all").click();
  await expect(page.getByTestId("audience-add-all")).toBeHidden();
  await expect(page.getByTestId("campaign-launch")).toHaveCount(0); // no launch before approval
  await page.getByTestId("campaign-request-approval").click();

  // requester cannot approve their own bulk campaign: the decision buttons are not offered
  await page.reload();
  await expect(page.getByRole("button", { name: "اعتماد", exact: true })).toHaveCount(0);

  const director = await accept(browser, directorInvite, "مدير العمليات");
  await director.goto(campaignPath);
  await director.getByRole("button", { name: "اعتماد", exact: true }).click();
  await expect(director.getByText("معتمد").first()).toBeVisible();

  await page.reload();
  await page.getByTestId("campaign-launch").click();
  await expect(page.getByText("تم إطلاق الحملة")).toBeVisible();
  await page.reload();
  await expect(page.getByText("محاكاة").first()).toBeVisible();

  // recipient opens the RSVP link (public, unauthenticated, minimal data)
  const token = await rsvpTokenFromOutbox(campaignId);
  const guest = await (await browser.newContext({ locale: "ar-SA" })).newPage();
  await guest.goto(`/rsvp/${token}`);
  await expect(guest.getByText("حفل الاستقبال التجريبي").or(guest.getByText("يسرنا دعوتكم")).first()).toBeVisible();
  await expect(guest.locator("body")).not.toContainText("+9665");
  await guest.getByTestId("rsvp-attending").click();
  await guest.getByTestId("rsvp-submit").click();
  await expect(guest.getByTestId("rsvp-thanks")).toBeVisible();
  const code = (await guest.getByText(/QR-[A-Z0-9]+/).first().textContent())!.match(/QR-[A-Z0-9]+/)![0];

  await page.goto(`${campaignPath}/checkin`);
  await page.getByPlaceholder("امسح رمز QR أو أدخله يدوياً").fill(code);
  await page.getByRole("button", { name: "تأكيد" }).click();
  await expect(page.getByText("تم تسجيل دخول الضيف")).toBeVisible();
  await page.getByPlaceholder("امسح رمز QR أو أدخله يدوياً").fill(code);
  await page.getByRole("button", { name: "تأكيد" }).click();
  await expect(page.getByText("تم تسجيل الدخول مسبقاً")).toBeVisible();

  // invalid token shows nothing about any tenant
  await guest.goto("/rsvp/not-a-real-token-123456");
  await expect(guest.locator("h1")).toBeVisible();
});
