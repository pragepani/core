const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

test("external addon: admin External-sites settings panel renders", async ({ browser }) => {
  skipUnlessAddonEnabled("external");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    const settingsUrl = new URL("settings/admin/external", shared.env.nextcloudBaseUrl).toString();
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await shared.dismissBlockingNextcloudModals(page, page);

    await expect(
      page.locator("#app-content, #app-content-vue, #content, #content-vue").first(),
      "the Nextcloud admin settings shell must render for the external app's own section (settings/admin/external)",
    ).toBeVisible({ timeout: 60_000 });

    await expect(
      page.getByText("Add external sites to your Nextcloud navigation", { exact: true }).first(),
      "the external app's own admin panel description must render (proves the 'external' section + template are served by the enabled app)",
    ).toBeVisible({ timeout: 60_000 });

    await expect(
      page.getByRole("button", { name: /^New site$/ }).first(),
      "the external app's 'New site' admin action must render (proves the External-sites configuration UI is live)",
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
