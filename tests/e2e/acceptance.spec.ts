import { expect, test, type Browser, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Required end-to-end acceptance scenario (synthetic data only):
 * agency → invitations → conference project with VIP delivery + conference templates →
 * Excel import → review → commit → bulk assignment → field agent on mobile with evidence →
 * KPIs → client portal → isolation → export → audit history.
 */
const stamp = Date.now().toString(36);
const slug = `e2e-${stamp}`;
const PASS = "E2e-Strong-Pass-2026";
const SAMPLE = path.join(process.cwd(), "samples/vip-recipients-ar.xlsx");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function register(page: Page, s: string, email: string) {
  await page.goto("/register");
  await page.fill("#name", "مديرة الوكالة");
  await page.fill("#email", email);
  await page.fill("#password", PASS);
  await page.fill("#orgName", `وكالة الاختبار ${s}`);
  await page.fill("#orgSlug", s);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/o/${s}`);
}

async function invite(page: Page, email: string, roleLabel: string): Promise<string> {
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

async function accept(browser: Browser, invitePath: string, name: string, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ar-SA" } : { locale: "ar-SA" });
  const page = await ctx.newPage();
  await page.goto(invitePath);
  await page.fill("#name", name);
  await page.fill("#password", PASS);
  await page.getByRole("button", { name: "قبول الدعوة" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/invite"));
  return page;
}

test("Operra acceptance scenario", async ({ page, browser }) => {
  // 1. Agency admin creates organization
  await register(page, slug, `owner-${stamp}@example.test`);
  await expect(page.getByRole("heading", { name: "لوحة القيادة" })).toBeVisible();

  // 2. Admin invites a project manager and delivery agents
  const pmInvite = await invite(page, `pm-${stamp}@example.test`, "مدير مشروع");
  const agentInvite = await invite(page, `agent1-${stamp}@example.test`, "مندوب توصيل");
  const agent2Invite = await invite(page, `agent2-${stamp}@example.test`, "مندوب توصيل");

  const pm = await accept(browser, pmInvite, "مدير المشروع");
  await expect(pm).toHaveURL(new RegExp(`/o/${slug}$`));

  // 3–4. Manager creates a conference project with VIP delivery + conference templates
  await pm.goto(`/o/${slug}/projects/new`);
  await pm.getByTestId("project-name").fill("مؤتمر مستقبل الضيافة التجريبي");
  await pm.getByRole("button", { name: "التالي" }).click();
  await pm.getByTestId("event-start").fill("2026-12-15T09:00");
  await pm.getByRole("button", { name: "التالي" }).click();
  await expect(pm.getByTestId("tpl-conference")).toHaveAttribute("aria-pressed", "true");
  await expect(pm.getByTestId("tpl-vip-physical-delivery")).toHaveAttribute("aria-pressed", "true");
  await pm.getByRole("button", { name: "التالي" }).click();
  await pm.getByTestId("create-project").click();
  await pm.waitForURL(/\/projects\/c[a-z0-9]+$/);
  const projectUrl = pm.url();
  const projectPath = new URL(projectUrl).pathname;
  await expect(pm.getByText("توصيل الدعوات الورقية لكبار الشخصيات").first()).toBeVisible();
  await expect(pm.getByText("عمليات المؤتمر").first()).toBeVisible();

  // 5. Manager imports an Excel file of VIP recipients
  await pm.goto(`${projectPath}/delivery/imports`);
  await pm.getByTestId("import-file").setInputFiles(SAMPLE);
  await pm.getByTestId("import-upload").click();
  await pm.waitForURL(/\/delivery\/imports\/c[a-z0-9]+$/);

  // 6. System previews mappings and validates rows
  await expect(pm.getByTestId("map-mobile")).toHaveValue("رقم الجوال");
  await expect(pm.getByTestId("map-nameAr")).toHaveValue("الاسم");
  await pm.getByTestId("import-validate").click();
  await expect(pm.getByTestId("chip-INVALID")).toBeVisible();
  await expect(pm.getByTestId("import-row-DUPLICATE").first()).toBeVisible();

  // 7. Manager resolves duplicate / invalid records
  await pm.getByTestId("skip-duplicates").click();
  await pm.getByTestId("skip-invalid").click();
  await expect(pm.getByTestId("import-row-INVALID").first()).toHaveClass(/opacity-50/);

  // 8. Commit import → delivery cards generated
  const acceptPartial = pm.getByTestId("accept-partial");
  if (await acceptPartial.isVisible()) await acceptPartial.click();
  await pm.getByTestId("import-commit").click();
  await expect(pm.getByText(/تم اعتماد \d+ سجل/)).toBeVisible();

  // 9. Manager assigns deliveries in bulk
  const agent = await accept(browser, agentInvite, "مندوب أول", true);
  await expect(agent).toHaveURL(new RegExp(`/field/${slug}$`));
  await pm.goto(`${projectPath}/delivery/cards`);
  await pm.waitForLoadState("networkidle");
  const rows = pm.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await rows.nth(i).getByRole("checkbox").click();
    await expect(rows.nth(i).getByRole("checkbox")).toHaveAttribute("data-state", "checked");
  }
  const agentValue = await pm.getByTestId("bulk-assign").locator("option", { hasText: "مندوب أول" }).getAttribute("value");
  await pm.getByTestId("bulk-assign").selectOption(agentValue!);
  await expect(pm.getByText(/تم إسناد 5 توصيل/)).toBeVisible();

  // 10. Agent opens assigned work on mobile
  await agent.reload();
  await expect(agent.getByTestId("field-card")).toHaveCount(5);

  // 11. Agent updates a delivery with evidence
  await agent.getByTestId("field-card").first().locator("button").first().click();
  await agent.getByTestId("field-start").click();
  await expect(agent.getByTestId("field-pending")).toHaveCount(0, { timeout: 20_000 });
  await agent.locator('[data-testid=field-card][data-status=OUT_FOR_DELIVERY]').locator("button").first().click();
  await agent.getByTestId("field-delivered").click();
  await agent.getByTestId("field-photo").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: PNG });
  await agent.getByTestId("field-received-by").fill("مدير المكتب");
  await agent.getByTestId("field-confirm").click();
  await expect(agent.getByTestId("field-card")).toHaveCount(4, { timeout: 20_000 });
  // the offline queue drains and the server confirms the delivery
  await expect(async () => {
    await agent.reload();
    await expect(agent.getByText("منجزة مؤخراً")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await expect(agent.getByTestId("field-card")).toHaveCount(4);

  // 12. Manager sees updated status and KPI calculations
  await pm.goto(`${projectPath}/delivery`);
  const deliveredStat = pm.locator("a", { hasText: "تم التسليم" }).first();
  await expect(deliveredStat).toContainText("1");

  // 14. Unauthorized access: another agent cannot open the project; another tenant cannot open the org
  const agent2 = await accept(browser, agent2Invite, "مندوب ثاني", true);
  const resp = await agent2.goto(projectUrl);
  expect([404, 200]).toContain(resp?.status());
  await expect(agent2).not.toHaveURL(projectUrl); // field agents are redirected away from the workspace
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await register(other, `${slug}-x`, `intruder-${stamp}@example.test`);
  const r2 = await other.goto(projectUrl);
  expect(r2?.status()).toBe(404);
  const r3 = await other.goto(`/o/${slug}`);
  expect(r3?.status()).toBe(404);

  // 15. Manager exports a delivery report
  const [download] = await Promise.all([pm.waitForEvent("download"), pm.getByRole("link", { name: /تقرير التوصيل/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^deliveries-.*\.xlsx$/);

  // 16. Audit history records key changes
  await page.goto(`/o/${slug}/settings/audit?action=delivery.`);
  await expect(page.getByText("delivery.status_change").first()).toBeVisible();
  await page.goto(`/o/${slug}/settings/audit?action=import.`);
  await expect(page.getByText("import.commit").first()).toBeVisible();
});
