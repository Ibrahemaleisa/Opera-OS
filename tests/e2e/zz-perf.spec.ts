import { test } from "@playwright/test";
test("perf", async ({ page }) => {
  test.setTimeout(300_000);
  const base = "https://opera-os-alpha.vercel.app";
  await page.goto(`${base}/login?_vercel_share=7vjDMuZbdUsdylZhmDJN4ZOMyJgc6H2D`);
  await page.fill("#email", "pm@operra.demo");
  await page.fill("#password", process.env.LIVE_PW!);
  await page.click("button[type=submit]");
  await page.waitForURL("**/o/demo");
  const paths = ["/o/demo", "/o/demo/projects", "/o/demo/my-work", "/o/demo/delivery", "/o/demo/events", "/o/demo/finance", "/o/demo/vendors", "/o/demo/settings/members"];
  for (const round of [1, 2]) {
    for (const p of paths) {
      const t0 = Date.now();
      const r = await page.goto(base + p, { waitUntil: "domcontentloaded" });
      const ttfb = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming; return Math.round(n.responseStart - n.requestStart); });
      console.log(`round${round} ${p} status=${r?.status()} ttfb=${ttfb}ms total=${Date.now() - t0}ms`);
    }
  }
  // client-side navigation via sidebar link
  await page.goto(base + "/o/demo");
  for (const label of ["المشاريع", "مهامي", "الفعاليات", "المالية", "لوحة القيادة"]) {
    const t0 = Date.now();
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await page.waitForLoadState("networkidle");
    console.log(`client-nav ${label} ${Date.now() - t0}ms`);
  }
  const res = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /\.js|\.css|woff/.test(e.name)).reduce((a, e) => a + ((e as PerformanceResourceTiming).transferSize || 0), 0));
  console.log(`static transfer on last page ~${Math.round(res / 1024)}KB`);
});
