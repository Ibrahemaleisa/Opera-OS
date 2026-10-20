import { expect, test } from "@playwright/test";

test("corporate homepage renders in both languages and hands off to sign-in", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("نبني الأصعب");
  for (const id of ["about", "capabilities", "formula", "work", "technologies", "leadership", "contact"]) await expect(page.locator(`#${id}`)).toBeVisible();
  // no invented case studies or contact details: placeholders are explicit
  await expect(page.locator("#work")).toContainText("نُعدّ حالياً");
  await expect(page.locator("#contact")).toContainText("[البريد الإلكتروني]");

  await context.addCookies([{ name: "operra_locale", value: "en", url: page.url() }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("We build the hardest things.");

  await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL("**/login");
  expect((await page.request.get("/work/not-a-project")).status()).toBe(404);
});
