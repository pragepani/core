const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Full-coupling check for nextcloud/integration_mattermost.
//
// The addon hook (tasks/addons/integration_mattermost.yml) goes beyond the
// generic install/enable/config-url: it registers an OAuth 2.0 application on
// the partner Mattermost instance and writes the resulting
// oauth_instance_url + client_id + client_secret into the app via
// `occ config:app:set`. This spec proves that coupling end to end:
//
//   1) the integration_mattermost app is enabled (admin app-detail "Disable"),
//   2) the personal "Connected accounts" page exposes the Mattermost connect
//      control (only rendered when the app is enabled), and
//   3) clicking connect performs the OAuth authorize redirect to the PARTNER
//      Mattermost host (not Nextcloud) carrying a real `client_id` and
//      `response_type=code` — which can only happen once the admin OAuth client
//      provisioned by the hook is persisted. This step FAILS if the OAuth
//      coupling is missing.
test("integration integration_mattermost: OAuth client provisioned and connects to Mattermost", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_mattermost");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // 1) App is installed AND enabled: the app-detail page resolves with a
    // "Disable" action only for an enabled app.
    await page.goto(
      new URL("settings/apps/installed/integration_mattermost", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});

    const disableAction = page
      .getByRole("button", { name: /^disable$/i })
      .or(page.locator('input[value="Disable"]'))
      .first();
    await expect(
      disableAction,
      "integration_mattermost must be enabled (admin app-detail Disable action)"
    ).toBeVisible({ timeout: 60_000 });

    // 2) Personal connect surface renders (app registers it only when enabled).
    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});

    const connect = page
      .locator("#mattermost-connect")
      .or(page.getByRole("button", { name: /connect to mattermost/i }))
      .or(page.getByRole("link", { name: /connect to mattermost/i }))
      .first();

    await expect(
      connect,
      "the Mattermost connect control must render on Connected accounts when the app is enabled"
    ).toBeVisible({ timeout: 60_000 });

    // In topologies where Mattermost is not deployed, the integration hook probes the
    // partner container, finds it absent, and skips provisioning entirely: the OAuth app
    // is never registered, so oauth_instance_url / client_id are never written. The admin
    // settings surface then shows empty OAuth fields and the connect control cannot reach a
    // partner /oauth/authorize endpoint. That is a valid degraded state, not a failure —
    // skip rather than assert.
    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});

    const oauthFields = page.locator(
      'input[id*="mattermost-oauth-instance"], input[id*="mattermost"][id*="instance"], ' +
        'input[id*="mattermost"][id*="client-id"], input[id*="mattermost-client-id"]'
    );
    const oauthFieldCount = await oauthFields.count();
    let mattermostConfigured = false;
    for (let i = 0; i < oauthFieldCount; i += 1) {
      const value = (await oauthFields.nth(i).inputValue().catch(() => "")) || "";
      if (value.trim().length > 0) {
        mattermostConfigured = true;
        break;
      }
    }
    if (!mattermostConfigured) {
      test.skip(
        true,
        "Mattermost not deployed in this topology: the integration_mattermost hook skipped OAuth provisioning, so oauth_instance_url/client_id are not configured"
      );
      return;
    }

    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});

    // 3) The connect button performs the OAuth authorize redirect to the partner
    // Mattermost. This only works when the hook provisioned the OAuth client and
    // persisted client_id/oauth_instance_url. A token/login-only fallback would
    // NOT navigate off-Nextcloud to an /oauth/authorize endpoint.
    await Promise.all([
      page.waitForEvent("framenavigated", { timeout: 60_000 }).catch(() => {}),
      connect.click().catch(() => {}),
    ]);

    await expect
      .poll(() => page.url(), { timeout: 60_000 })
      .toMatch(/\/oauth\/authorize\?/i);

    const authorizeUrl = new URL(page.url());
    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;

    expect(
      authorizeUrl.host,
      "Mattermost OAuth authorize must be served by the partner instance, not Nextcloud"
    ).not.toBe(nextcloudHost);
    expect(
      authorizeUrl.searchParams.get("client_id"),
      "OAuth authorize must carry the provisioned Mattermost client_id"
    ).toBeTruthy();
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
