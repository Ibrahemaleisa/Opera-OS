import { expect, test } from "@playwright/test";

/** Every top-level page renders for an agency owner (no error boundary), plus report export and account. */
const stamp = Date.now().toString(36);
const slug = `sm-${stamp}`;

test("org pages render and report export downloads", async ({ page }) => {
  await page.goto("/register");
  await page.fill("#name", "مالك الوكالة");
  await page.fill("#email", `owner-${stamp}@example.test`);
  await page.fill("#password", "E2e-Strong-Pass-2026");
  await page.fill("#orgName", `وكالة الفحص ${stamp}`);
  await page.fill("#orgSlug", slug);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/o/${slug}`);
  const pages: [string, RegExp][] = [
    ["", /لوحة القيادة/], ["/projects", /المشاريع/], ["/my-work", /مهامي|أعمالي/], ["/templates", /القوالب/], ["/delivery", /توصيل/], ["/recipients", /سجل/], ["/dispatch", /التوزيع/],
    ["/digital", /الدعوات الرقمية/], ["/events", /مركز القيادة/], ["/protocol", /لوحة الوصول/], ["/booths", /الأجنحة/], ["/vendors", /الموردون/], ["/resources", /الموارد/],
    ["/finance", /المالية/], ["/reports", /التقارير/], ["/notifications", /الإشعارات/], ["/settings", /عام/], ["/settings/automation", /قواعد الأتمتة/], ["/settings/providers", /مزودو الإرسال/], ["/settings/audit", /التدقيق/],
  ];
  for (const [path, heading] of pages) {
    const res = await page.goto(`/o/${slug}${path}`);
    expect(res?.status(), path).toBe(200);
    await expect(page.locator("main, body").getByText(heading).first(), path).toBeVisible();
    await expect(page.getByText("لم نتمكن من تحميل هذه الصفحة")).toHaveCount(0);
  }
  await page.goto(`/o/${slug}/settings/automation`);
  await expect(page.getByTestId("automation-rule").first()).toBeVisible();
  await page.goto(`/o/${slug}/reports`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-projects").click()]);
  expect(dl.suggestedFilename()).toMatch(/^projects-.*\.csv$/);
  await page.goto("/account");
  await expect(page.getByText("حسابي")).toBeVisible();
  await expect(page.getByTestId("session-row").first()).toBeVisible();
});
