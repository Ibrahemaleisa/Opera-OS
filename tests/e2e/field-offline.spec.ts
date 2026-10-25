import { expect, test, type Page } from "@playwright/test";

/**
 * Driver PWA offline path: one online visit caches the shell → the app opens again without a
 * network → a status update made offline is queued on the device → it replays when the
 * connection returns. Runs against the seeded demo agency (agent1@operra.demo).
 *
 * The delivery used is cycled RESCHEDULED/ASSIGNED → OUT_FOR_DELIVERY (offline) → RESCHEDULED,
 * so repeated runs don't consume the demo data.
 */
const ORG = process.env.E2E_FIELD_ORG ?? "demo";
const EMAIL = process.env.E2E_FIELD_EMAIL ?? "agent1@operra.demo";
const PASSWORD = process.env.E2E_FIELD_PASSWORD ?? process.env.SEED_PASSWORD ?? "Operra-Demo-2026";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

interface FieldDelivery { id: string; status: string; version: number }

async function deliveries(page: Page): Promise<FieldDelivery[]> {
  const res = await page.request.get(`/api/o/${ORG}/field/deliveries`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as FieldDelivery[];
}

async function signIn(page: Page) {
  await page.goto("/login");
  // wait for hydration: submitting before it would post the form natively
  await page.waitForFunction(() => {
    const f = document.querySelector("form");
    return !!f && Object.keys(f).some((k) => k.startsWith("__reactProps"));
  });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(`**/field/${ORG}`);
}

test("field PWA: opens offline after one visit, queues an offline update and replays it", async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByTestId("field-card").first()).toBeVisible();

  // 1. one online visit: the page hands its shell and assets to the service worker
  await expect(page.locator("[data-precached='1']")).toBeAttached({ timeout: 60_000 });
  const cached = await page.evaluate(async () => (await (await caches.open("operra-field-v3")).keys()).map((r) => new URL(r.url).pathname));
  expect(cached).toContain(`/field/${ORG}`);

  // 2. reload with no network: the shell comes from the cache, not the browser's offline page
  const isDevServer = await page.evaluate(() => [...document.scripts].some((s) => /hmr-client/.test(s.src)));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("field-online")).toBeVisible();
  if (!isDevServer) {
    // production: the app hydrates offline and shows the cached list
    await expect(page.getByTestId("field-online")).toHaveText(/غير متصل|Offline/);
    await expect(page.getByTestId("field-card").first()).toBeVisible();
  }
  // (under `next dev` the page can't hydrate fully offline: dev streams React debug info over its
  // HMR websocket. The shell above still comes from the service worker; hydration offline is
  // asserted against a production server.)
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("field-card").first()).toBeVisible();

  // 3. pick a delivery the agent can start
  const list = await deliveries(page);
  const target = list.find((d) => d.status === "RESCHEDULED") ?? list.find((d) => d.status === "ASSIGNED") ?? list.find((d) => d.status === "FAILED_ATTEMPT");
  test.skip(!target, "no startable delivery assigned to the field agent");
  const card = page.locator(`[data-testid=field-card][data-delivery-id="${target!.id}"]`);

  // 4. offline: the update is saved on the device and shown as waiting to sync
  await context.setOffline(true);
  await expect(page.getByTestId("field-online")).toHaveText(/غير متصل|Offline/);
  await card.locator("button").first().click();
  await page.getByTestId("field-start").click();
  await expect(page.getByTestId("field-pending")).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "OUT_FOR_DELIVERY");
  await expect(card.getByTestId("field-card-queued")).toBeVisible();
  expect((await page.evaluate(() => new Promise<number>((resolve) => {
    const r = indexedDB.open("operra-field");
    r.onsuccess = () => {
      const q = r.result.transaction("queue", "readonly").objectStore("queue").getAll();
      q.onsuccess = () => resolve(q.result.length);
    };
  })))).toBeGreaterThan(0);

  // 5. back online: the queue replays and the server has the new status
  await context.setOffline(false);
  await expect(page.getByTestId("field-pending")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByTestId("field-attention")).toHaveCount(0);
  await expect.poll(async () => (await deliveries(page)).find((d) => d.id === target!.id)?.status, { timeout: 30_000 }).toBe("OUT_FOR_DELIVERY");

  // 6. leave the delivery startable again for the next run
  await card.locator("button").first().click();
  await page.getByTestId("field-reschedule").click();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const local = `${tomorrow.toISOString().slice(0, 10)}T10:00`;
  await page.getByTestId("field-when").fill(local);
  await page.getByTestId("field-confirm").click();
  await expect.poll(async () => (await deliveries(page)).find((d) => d.id === target!.id)?.status, { timeout: 30_000 }).toBe("RESCHEDULED");
});
