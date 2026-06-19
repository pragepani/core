const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Verifies the nextcloud/integration_zammad app is installed, enabled and — the
// part the generic loader does NOT do — pinned to the deployed partner Zammad
// instance. The app drives its OAuth flow from the admin-level
// `oauth_instance_url` appValue (AdminSettings.vue -> state.oauth_instance_url),
// which the generic config leaves empty. The addon hook
// (tasks/addons/integration_zammad.yml) sets it to the partner base URL via occ.
// This spec proves the coupling held end-to-end:
//   1) the Zammad admin settings section (#zammad_prefs) renders, and
//   2) its "Zammad instance address" field holds a real partner URL — NOT empty
//      and NOT Nextcloud itself.
// It then drives the per-user connect control as a best-effort extra and, when
// an OAuth client is provisioned, asserts the authorize redirect targets the
// partner host rather than Nextcloud.
test("integration integration_zammad: pinned to partner Zammad instance and connectable", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_zammad");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // 1) Activation + coupling: the Zammad admin settings section must render
    //    and the instance address must be pinned to the partner instance.
    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const zammadPrefs = page.locator("#zammad_prefs");
    await expect(
      zammadPrefs.first(),
      "the Zammad integration admin section (#zammad_prefs) must render when integration_zammad is enabled"
    ).toBeVisible({ timeout: 60_000 });

    // The instance-address NcTextField has no fixed id; locate it by its label.
    const instanceInput = zammadPrefs
      .getByRole("textbox", { name: /zammad instance address/i })
      .or(zammadPrefs.locator('input[type="text"]'));

    await expect(
      instanceInput.first(),
      "the Zammad instance-address field must be present in the admin section"
    ).toBeVisible({ timeout: 30_000 });

    const instanceUrl = ((await instanceInput.first().inputValue()) || "").trim();
    expect(
      instanceUrl.length,
      "oauth_instance_url must be configured (the addon hook pins it to the partner Zammad base URL)"
    ).toBeGreaterThan(0);

    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(instanceUrl).host;
    expect(
      instanceHost,
      "the Zammad instance URL must not point back at Nextcloud itself"
    ).not.toBe(nextcloudHost);

    // 2) Best-effort cross-role check: drive the per-user OAuth connect flow.
    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const connect = page
      .getByRole("button", { name: /connect to zammad/i })
      .or(page.getByRole("link", { name: /connect to zammad/i }));

    if ((await connect.count()) === 0) {
      // The admin pinning asserted above already proves the integration is
      // coupled to the partner instance; the OAuth client (client_id/secret)
      // is a separate vault-backed provisioning step, so its absence is not a
      // failure.
      return;
    }

    await Promise.all([
      page.waitForEvent("framenavigated", { timeout: 60_000 }).catch(() => {}),
      connect.first().click(),
    ]);

    await expect
      .poll(() => page.url(), { timeout: 60_000 })
      .toMatch(/\/oauth\/authorize\??|connected-accounts/i);

    if (/\/oauth\/authorize/i.test(page.url())) {
      const authorizeUrl = new URL(page.url());
      expect(
        authorizeUrl.host,
        "Zammad OAuth authorize must be served by the partner instance, not Nextcloud"
      ).not.toBe(nextcloudHost);
      expect(
        authorizeUrl.host,
        "the OAuth authorize host must match the configured partner instance URL"
      ).toBe(instanceHost);
      expect(authorizeUrl.searchParams.get("client_id")).toBeTruthy();
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
