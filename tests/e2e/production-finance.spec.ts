import { expect, test, type Browser, type Page } from "@playwright/test";

/** Booth production, procurement and finance (synthetic data, single agency owner). */
const stamp = Date.now().toString(36);
const slug = `pf-${stamp}`;
const PASS = "E2e-Strong-Pass-2026";

// Separation of duties now includes the person who created the spend (F-02): a finance approver other
// than the owner who awarded the PO must exist, so the scenario invites one before submitting.
async function inviteApprover(page: Page, browser: Browser) {
  await page.goto(`/o/${slug}/settings/members`);
  await page.getByRole("button", { name: "دعوة مستخدم" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input[name=email]").fill(`dir-${stamp}@example.test`);
  await dialog.locator("select[name=roleId]").selectOption({ label: "مدير العمليات" });
  await dialog.getByRole("button", { name: "دعوة مستخدم" }).click();
  const link = new URL(await dialog.getByTestId("invite-link").inputValue()).pathname;
  await page.keyboard.press("Escape");
  const director = await (await browser.newContext({ locale: "ar-SA" })).newPage();
  await director.goto(link);
  await director.fill("#name", "مدير العمليات");
  await director.fill("#password", PASS);
  await director.getByRole("button", { name: "قبول الدعوة" }).click();
  await director.waitForURL((u) => !u.pathname.startsWith("/invite"));
  return director;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

test("booth BOQ and gates, RFQ award to PO, threshold PO, expense evidence, budget summary", async ({ page, browser }) => {
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "4" : undefined));
  await page.goto("/register");
  await page.fill("#name", "مدير الإنتاج");
  await page.fill("#email", `owner-${stamp}@example.test`);
  await page.fill("#password", "E2e-Strong-Pass-2026");
  await page.fill("#orgName", `وكالة المعارض ${stamp}`);
  await page.fill("#orgSlug", slug);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/o/${slug}`);

  await page.goto(`/o/${slug}/projects/new`);
  await page.getByTestId("project-name").fill("جناح معرض الابتكار التجريبي");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("event-start").fill("2026-12-20T10:00");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("tpl-booth-production").click();
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByTestId("create-project").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]+$/);
  const projectPath = new URL(page.url()).pathname;

  // booth: gates block advancing; BOQ totals
  await page.goto(`${projectPath}/production`);
  await page.getByTestId("booth-link").first().click();
  await page.waitForURL(/\/production\/c[a-z0-9]+/);
  await page.getByTestId("booth-advance").click(); // BRIEF → DESIGN has no gate
  await expect(page.getByTestId("gate-unmet").first()).toBeVisible(); // DESIGN → CLIENT_APPROVAL needs a submitted revision
  await expect(page.getByTestId("booth-advance")).toBeDisabled();
  await page.getByTestId("booth-tab-boq").click();
  await page.getByRole("button", { name: "بند جديد" }).click();
  const boq = page.getByTestId("form-boq");
  await boq.locator("input[name=code]").fill("S-01");
  await boq.locator("input[name=description]").fill("هيكل الجناح");
  await boq.locator("input[name=quantity]").fill("40");
  await boq.locator("input[name=unitCost]").fill("250");
  await boq.getByRole("button", { name: "حفظ" }).click();
  await expect(page.locator("tfoot")).toContainText("10,000");
  await page.getByTestId("booth-tab-handover").click();
  await expect(page.getByTestId("sign-handover")).toBeDisabled();

  // vendors
  for (const name of ["مصنع الأفق التجريبي", "ورشة النخبة التجريبية"]) {
    await page.goto(`/o/${slug}/vendors`);
    await page.getByRole("button", { name: "مورّد جديد" }).click();
    await page.getByTestId("form-vendor").locator("input[name=name]").fill(name);
    await page.getByTestId("form-vendor").getByRole("button", { name: "حفظ" }).click();
    await expect(page.getByText(name)).toBeVisible();
  }

  // RFQ → quotes → award lowest → draft PO
  await page.goto(`${projectPath}/procurement`);
  await page.getByRole("button", { name: "طلب تسعير جديد" }).click();
  const rfq = page.getByTestId("form-rfq");
  await rfq.locator("input[name=title]").fill("تصنيع الجناح");
  await rfq.getByLabel("مصنع الأفق التجريبي").check();
  await rfq.getByLabel("ورشة النخبة التجريبية").check();
  await rfq.getByRole("button", { name: "حفظ" }).click();
  for (const [vendor, amount] of [["مصنع الأفق التجريبي", "120000"], ["ورشة النخبة التجريبية", "100000"]]) {
    await page.getByRole("button", { name: "تسجيل عرض" }).click();
    const q = page.getByTestId("form-quote");
    await q.locator("select[name=vendorId]").selectOption({ label: vendor });
    await q.locator("input[name=amount]").fill(amount);
    await q.locator("input[name=vatAmount]").fill(String(Number(amount) * 0.15));
    await q.getByRole("button", { name: "حفظ" }).click();
    await expect(page.getByTestId("form-quote")).toBeHidden();
  }
  await expect(page.getByText("الأقل سعراً")).toBeVisible();
  const lowestRow = page.locator("tr", { hasText: "ورشة النخبة التجريبية" });
  await lowestRow.getByTestId("quote-award").click();
  await page.getByTestId("form-award").getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByText(/تمت الترسية وإنشاء أمر شراء PO-/)).toBeVisible();

  // finance: the awarded PO (115,000 incl. VAT) needs approval; a small PO is approved directly
  await inviteApprover(page, browser);
  await page.goto(`${projectPath}/finance`);
  await expect(page.getByTestId("po-row").first()).toHaveAttribute("data-status", "DRAFT");
  await page.getByTestId("po-submit").first().click();
  await expect(page.getByTestId("po-row").first()).toHaveAttribute("data-status", "PENDING_APPROVAL");
  await page.getByRole("button", { name: "أمر شراء جديد" }).click();
  const po = page.getByTestId("form-po");
  await po.locator("input[name=title]").fill("مطبوعات الجناح");
  await po.locator("select[name=vendorId]").selectOption({ label: "مصنع الأفق التجريبي" });
  await po.locator("select[name=budgetCategory]").selectOption("PRINTING");
  await po.locator("input[name=amount]").fill("2000");
  await po.locator("input[name=vatAmount]").fill("300");
  await po.getByRole("button", { name: "حفظ" }).click();
  await page.locator('[data-testid=po-row][data-status=DRAFT]').getByTestId("po-submit").click();
  await expect(page.locator('[data-testid=po-row][data-status=APPROVED]')).toContainText("مطبوعات الجناح");

  // budget line + expense with evidence
  await page.getByRole("button", { name: "تعديل بند" }).first().click();
  await page.getByTestId("form-budget").locator("select[name=category]").selectOption("PRINTING");
  await page.getByTestId("form-budget").locator("input[name=planned]").fill("5000");
  await page.getByTestId("form-budget").getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("budget-table")).toContainText("5,000");

  await page.getByTestId("new-expense").click();
  const ex = page.getByTestId("form-expense");
  await ex.locator("input[name=description]").fill("استئجار رافعة");
  await ex.locator("input[name=amount]").fill("1500");
  await ex.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("expense-request")).toBeDisabled(); // no evidence yet
  await page.getByTestId("expense-evidence").click();
  await page.getByRole("dialog").locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("dialog")).toContainText("receipt.png");
  await page.keyboard.press("Escape");
  await page.getByTestId("expense-request").click();
  await expect(page.getByTestId("expense-row")).toContainText("بانتظار الاعتماد");

  await page.goto(`/o/${slug}/finance`);
  await expect(page.getByText("جناح معرض الابتكار التجريبي")).toBeVisible();
  await page.goto(`/o/${slug}/resources`);
  await expect(page.getByTestId("resource-row").first()).toBeVisible();
});
