const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// twofactor_nextcloud_notification is the self-contained upstream 2FA provider
// that approves a login by tapping a notification on another active Nextcloud
// session. There is no partner service to wire; the loader's
// `occ app:enable twofactor_nextcloud_notification` is the full activation and
// the addon hook asserts via occ that the app is enabled AND registered in the
// 2FA subsystem (twofactorauth:state). The deterministic browser-observable
// proof of that coupling is the personal Security settings page: a 2FA provider
// is only rendered there as an activatable second factor once its app is
// enabled and registered as a provider, so the spec asserts the provider
// surface is present. A bare "app installed" list entry (the previous check)
// can survive even a half-wired install; this fails unless the provider is
// usable. The addon is only enabled when SSO is disabled
// (see meta/addons/twofactor_nextcloud_notification.yml), so the administrator
// authenticates through the native NC login flow.
test("twofactor_nextcloud_notification addon: 2FA provider is enabled and offered in personal security settings", async ({ browser }) => {
  skipUnlessAddonEnabled("twofactor_nextcloud_notification");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // 1) The connector must be enabled, not merely shipped: it must appear in
    //    the admin "installed apps" list (the enabled section renders it).
    const appsUrl = new URL("settings/apps/installed", shared.env.nextcloudBaseUrl).toString();
    await page.goto(appsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await shared.dismissBlockingNextcloudModals(page, page);

    await expect(
      page.locator("#app-content, #app-content-vue, #content, #content-vue").first(),
      "the Nextcloud installed-apps settings page must be visible",
    ).toBeVisible({ timeout: 60_000 });

    const appEntry = page
      .locator(
        '#app-twofactor_nextcloud_notification, [data-id="twofactor_nextcloud_notification"], a[href*="twofactor_nextcloud_notification"]',
      )
      .first();

    await expect(
      appEntry,
      "the twofactor_nextcloud_notification app must appear as installed/enabled in the admin apps list",
    ).toBeVisible({ timeout: 60_000 });

    // 2) Coupling proof: the personal Security settings page must surface the
    //    provider as an activatable second factor. Nextcloud only renders a 2FA
    //    provider's enable control here when its app is enabled AND the provider
    //    is registered in the two-factor subsystem; a half-wired install shows
    //    no such control. This is the browser-observable equivalent of the occ
    //    `twofactorauth:state` assertion the addon hook performs.
    const securityUrl = new URL("settings/user/security", shared.env.nextcloudBaseUrl).toString();
    const securityResponse = await page.goto(securityUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await shared.dismissBlockingNextcloudModals(page, page);

    expect(
      securityResponse && securityResponse.status(),
      "the personal Security settings route must resolve",
    ).toBeLessThan(400);

    await expect(
      page.locator("#app-content, #app-content-vue, #content, #content-vue").first(),
      "the personal Security settings page must render",
    ).toBeVisible({ timeout: 60_000 });

    const providerSurface = page
      .locator(
        '[data-provider-id="twofactor_nextcloud_notification"], '
          + '[id*="twofactor_nextcloud_notification"], '
          + 'section:has-text("Nextcloud notification"), '
          + 'fieldset:has-text("Nextcloud notification"), '
          + 'div:has-text("Two-Factor Authentication via Nextcloud notification")',
      )
      .first();

    await expect(
      providerSurface,
      "the Nextcloud-notification 2FA provider must be offered as an activatable second factor in personal security settings, proving the app is enabled and registered as a 2FA provider (not just installed)",
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
