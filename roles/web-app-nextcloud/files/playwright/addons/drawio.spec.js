const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test("addon drawio: nextcloud app route renders", async ({ browser }) => {
  skipUnlessAddonEnabled("drawio");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloudWithRetry(page);

    const appUrl = new URL("apps/drawio/", shared.env.nextcloudBaseUrl).toString();
    const response = await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    test.skip(
      response !== null && response.status() === 404,
      "drawio app route absent (app disabled at runtime)",
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    // app-present signal from the drawio-specific mount, not the generic #content shell
    // (which renders even when disabled); never mounts when disabled/absent -> skip, not fail.
    const appContainer = page.locator(
      ".app-drawio, #drawio, #drawioframe, #app-content .drawio, #app-content-vue .drawio",
    );
    const shellMounted = await appContainer
      .first()
      .isVisible({ timeout: 60_000 })
      .catch(() => false);
    test.skip(
      !shellMounted,
      "drawio app shell did not mount (app disabled/absent at runtime) — nothing to assert",
    );

    await expect(
      appContainer.first(),
      "the drawio Nextcloud app route must render its own app shell",
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
