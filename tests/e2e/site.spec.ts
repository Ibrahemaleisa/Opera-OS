import { expect, test } from "@playwright/test";

test("corporate homepage renders in both languages and hands off to sign-in", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("نبني الأصعب");
  for (const id of ["about", "capabilities", "work", "formula", "technologies", "contact"]) await expect(page.locator(`#${id}`)).toBeVisible();
  // no invented case studies; unconfirmed details are left out rather than shown as "[placeholders]"
  // real field photographs, every one described for screen readers
  const photos = page.locator("main img");
  expect(await photos.count()).toBeGreaterThanOrEqual(7);
  for (const alt of await photos.evaluateAll((els) => els.map((e) => e.getAttribute("alt") ?? ""))) expect(alt.length).toBeGreaterThan(10);
  await expect(page.locator("#work")).toContainText("من الميدان");
  await expect(page.locator("main")).not.toContainText("[");
  await expect(page.locator("#leadership")).toHaveCount(0);
  // the illustrative status card says what each ring shows
  await expect(page.locator("#technologies")).toContainText("سُلّمت 340 من 500");

  await context.addCookies([{ name: "operra_locale", value: "en", url: page.url() }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("We build the hardest things.");

  await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL("**/login");
  expect((await page.request.get("/work/not-a-project")).status()).toBe(404);
});
