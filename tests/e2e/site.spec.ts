import { expect, test } from "@playwright/test";

test("corporate homepage renders in both languages and hands off to sign-in", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("نبني الأصعب");
  for (const id of ["about", "capabilities", "work", "formula", "technologies", "contact"]) await expect(page.locator(`#${id}`)).toBeVisible();
  // no invented case studies; unconfirmed details are left out rather than shown as "[placeholders]"
  // real field photographs: content photos are described; background ones sit in aria-hidden layers
  const photos = await page.locator("main img").evaluateAll((els) => els.map((e) => ({ alt: e.getAttribute("alt") ?? "", hidden: !!e.closest("[aria-hidden=true]") })));
  expect(photos.filter((p) => !p.hidden).length).toBeGreaterThanOrEqual(5);
  for (const p of photos) expect(p.hidden ? p.alt === "" : p.alt.length > 10).toBe(true);
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
