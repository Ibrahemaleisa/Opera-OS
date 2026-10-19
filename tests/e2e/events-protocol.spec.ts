import { expect, test } from "@playwright/test";

/** Event operations + VIP protocol (synthetic data). */
const stamp = Date.now().toString(36);
const slug = `ev-${stamp}`;

test("event workspace, live cues, incidents, command center and protocol desk", async ({ page }) => {
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Backup microphone deployed" : undefined));
  await page.goto("/register");
  await page.fill("#name", "مدير العمليات");
  await page.fill("#email", `owner-${stamp}@example.test`);
  await page.fill("#password", "E2e-Strong-Pass-2026");
  await page.fill("#orgName", `وكالة المؤتمرات ${stamp}`);
  await page.fill("#orgSlug", slug);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/o/${slug}`);

  await page.goto(`/o/${slug}/projects/new`);
  await page.getByTestId("project-name").fill("قمة الابتكار التجريبية");
  await page.getByRole("button", { name: "التالي" }).click();
  const soon = new Date(Date.now() + 2 * 3600_000 + 3 * 3600_000); // ~2h from now in Riyadh wall time
  await page.getByTestId("event-start").fill(soon.toISOString().slice(0, 16));
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("tpl-vip-protocol").click();
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]+$/);
  const projectPath = new URL(page.url()).pathname;

  // event workspace from the conference template, with a default readiness checklist
  await page.goto(`${projectPath}/events`);
  await page.getByTestId("event-link").first().click();
  await page.waitForURL(/\/events\/c[a-z0-9]+/);
  await page.getByTestId("event-tab-readiness").click();
  await expect(page.getByTestId("readiness-item")).toHaveCount(7);
  await page.getByTestId("readiness-item").first().locator("select").selectOption("READY");
  await expect(page.getByRole("heading", { name: /الجاهزية · 14/ })).toBeVisible();

  // run of show: add a cue and fire it
  await page.getByTestId("event-tab-runOfShow").click();
  await page.getByRole("button", { name: "بند تشغيل جديد" }).click();
  await page.getByTestId("form-cue").locator("input[name=title]").fill("الفيلم الافتتاحي");
  await page.getByTestId("form-cue").getByRole("button", { name: "حفظ" }).click();
  await page.getByRole("button", { name: "تنفيذ", exact: true }).click();
  await expect(page.locator('li[data-status="GO"]')).toContainText("الفيلم الافتتاحي");

  // incident: report → resolve with a resolution
  await page.getByTestId("report-incident").click();
  await page.getByTestId("form-incident").locator("input[name=title]").fill("عطل في الميكروفون الرئيسي");
  await page.getByTestId("form-incident").locator("select[name=severity]").selectOption("HIGH");
  await page.getByTestId("form-incident").getByRole("button", { name: "حفظ" }).click();
  await page.getByTestId("event-tab-incidents").click();
  await expect(page.getByTestId("incident-row")).toContainText("عطل في الميكروفون الرئيسي");

  await page.goto(`/o/${slug}/events`);
  await expect(page.getByTestId("cc-event")).toContainText("الفيلم الافتتاحي");
  await expect(page.getByText("عطل في الميكروفون الرئيسي")).toBeVisible();

  await page.goto(`${projectPath}/events`);
  await page.getByTestId("event-link").first().click();
  await page.getByTestId("event-tab-incidents").click();
  await page.getByTestId("incident-resolve").click();
  await expect(page.getByTestId("incident-row")).toContainText("Backup microphone deployed");

  // protocol: a guest with restricted notes, reveal is audited, arrival desk
  await page.goto(`${projectPath}/protocol`);
  await page.getByRole("button", { name: "ضيف جديد" }).click();
  const form = page.getByTestId("form-guest");
  await form.locator("input[name=nameAr]").fill("سعادة الضيف التجريبي");
  await form.locator("select[name=category]").selectOption("VVIP");
  await form.locator("input[name=protocolLevel]").fill("1");
  await form.locator("textarea[name=restrictedNotes]").fill("يصل عبر البوابة الخاصة");
  await form.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText("سعادة الضيف التجريبي")).toBeVisible();
  await expect(page.getByTestId("restricted-notes")).toHaveCount(0);
  await page.getByTestId("reveal-restricted").click();
  await expect(page.getByTestId("restricted-notes")).toContainText("البوابة الخاصة");
  await page.getByRole("button", { name: "وصل", exact: true }).click();
  await expect(page.locator('[data-attendance="ARRIVED"]')).toBeVisible();

  await page.goto(`/o/${slug}/settings/audit`);
  await expect(page.getByText("protocol.restricted_view").first()).toBeVisible();
});
