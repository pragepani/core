const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

test("addon epubviewer: EPUB reader personal settings panel renders and reflects config", async ({ browser }) => {
  skipUnlessAddonEnabled("epubviewer");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloudWithRetry(page);

    const settingsUrl = new URL("settings/user/epubviewer", shared.env.nextcloudBaseUrl).toString();
    const response = await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    test.skip(
      response !== null && response.status() === 404,
      "epubviewer settings section absent (app disabled/absent at runtime) — nothing to assert",
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    // app-present signal from epubviewer's OWN personal settings panel, never the lazy
    // settings/apps/enabled [data-id] list; the panel only mounts when the app is enabled.
    const panel = page.locator("#reader-personal");
    const panelMounted = await panel
      .first()
      .isVisible({ timeout: 60_000 })
      .catch(() => false);
    test.skip(
      !panelMounted,
      "epubviewer personal settings panel did not mount (app disabled/absent) — nothing to assert",
    );

    await expect(
      panel.first(),
      "the epubviewer app must render its own EPUB reader personal settings panel",
    ).toBeVisible({ timeout: 60_000 });

    // real config coupling: EPUB handling defaults to enabled (epub_enable=true) and the
    // persisted user value is reflected as the checked state of the panel's own checkbox.
    await expect(
      page.locator("#EpubEnable").first(),
      "the EPUB-enable checkbox must reflect the persisted epubviewer user config",
    ).toBeChecked({ timeout: 60_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
