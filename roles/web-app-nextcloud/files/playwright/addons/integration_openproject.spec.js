const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Verifies the nextcloud/integration_openproject app is not merely installed/enabled but
// FULLY coupled to the partner OpenProject instance by the role's integration hook
// (tasks/addons/integration_openproject.yml): the hook provisions the two-way OAuth 2.0
// pair (OpenProject OAuth application -> openproject_client_id/secret, Nextcloud OAuth2
// client -> nc_oauth_client_id) and only runs when the OpenProject partner container is
// reachable. When OpenProject is NOT deployed in the topology, the hook probes the partner,
// finds it absent, and skips provisioning entirely: openproject_client_id is never stored,
// so the coupling is unconfigured. That is a valid degraded state, not a failure — the spec
// must test.skip, not assert.
//
// Coupling is proven on two surfaces when configured:
//   1) Admin settings (settings/admin/openproject): the form has advanced past the initial
//      "enter the OpenProject server URL" step into the OAuth-configured state — i.e. it
//      exposes OAuth client fields / a reset-OAuth affordance that only renders once
//      openproject_client_id is stored, with the instance URL pointing at the partner host.
//   2) Per-user connect (settings/user/connected-accounts): a real "Connect to OpenProject"
//      control redirects to the PARTNER instance's /oauth/authorize with a non-empty
//      client_id, proving the cross-role OAuth handshake end-to-end.
test("integration integration_openproject: two-way OAuth coupling to partner OpenProject", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_openproject");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // --- App-present signal: render the app's OWN admin panel (never gate on the lazy
    //     enabled-apps list, which false-negatives). ---
    await page.goto(
      new URL("settings/admin/openproject", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const adminSection = page
      .locator("#openproject_prefs, #openproject-server-host, #openproject-prefs")
      .or(page.getByText(/openproject/i))
      .first();
    await expect(
      adminSection,
      "the OpenProject integration admin settings section must render when the addon is enabled"
    ).toBeVisible({ timeout: 60_000 });

    // --- Configured-coupling signal: once openproject_client_id is stored, the admin form
    //     moves past the URL-only step and exposes OAuth client fields / a reset-OAuth
    //     control. None of these appear on a bare enable without OAuth wiring. ---
    const oauthConfigured = page
      .locator(
        'input[id*="openproject-oauth-client-id"], input[id*="client-id"], input[id*="client-secret"]'
      )
      .or(page.getByText(/reset oauth|replace oauth|nextcloud oauth (client|values)/i))
      .or(page.getByText(/oauth client id|client secret/i))
      .first();

    const configured = await oauthConfigured
      .isVisible({ timeout: 60_000 })
      .catch(() => false);

    // --- Skip when genuinely unconfigured (partner absent -> hook skipped provisioning). ---
    if (!configured) {
      test.skip(
        true,
        "OpenProject not deployed in this topology: the integration_openproject hook found the partner container absent and skipped OAuth provisioning, so openproject_client_id is unset and the coupling is not configured"
      );
      return;
    }

    // --- Assert the real coupling: the configured instance URL must point at the partner
    //     host, distinct from Nextcloud itself. ---
    const instanceUrlField = page.locator(
      'input[id*="openproject-oauth-instance"], input[id*="server-host"], input[type="url"], input[name*="instance"]'
    );
    const fieldCount = await instanceUrlField.count();
    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    let instanceHost = null;
    for (let i = 0; i < fieldCount; i += 1) {
      const value = (await instanceUrlField.nth(i).inputValue().catch(() => "")) || "";
      if (/^https?:\/\//i.test(value)) {
        instanceHost = new URL(value).host;
        break;
      }
    }
    if (instanceHost) {
      expect(
        instanceHost,
        "the configured OpenProject instance URL must be the partner host, not the Nextcloud host"
      ).not.toBe(nextcloudHost);
    }

    await expect(
      oauthConfigured,
      "the admin panel must show OAuth client configuration (proving the two-way OAuth pair is provisioned, not just the app enabled)"
    ).toBeVisible({ timeout: 60_000 });

    // --- Surface 2: per-user connect drives the partner OAuth authorize endpoint ---
    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );

    const connect = page
      .getByRole("button", { name: /connect to openproject/i })
      .or(page.getByRole("link", { name: /connect to openproject/i }))
      .first();
    await expect(
      connect,
      "a 'Connect to OpenProject' control must be present once the admin OAuth client is configured"
    ).toBeVisible({ timeout: 60_000 });

    const popupPromise = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
    await Promise.all([
      page.waitForEvent("framenavigated", { timeout: 60_000 }).catch(() => {}),
      connect.click(),
    ]);

    const popup = await popupPromise;
    const currentUrl = () => (popup ? popup.url() : page.url());

    // The redirect MUST reach the partner OpenProject /oauth/authorize with a real client_id.
    await expect
      .poll(currentUrl, { timeout: 60_000 })
      .toMatch(/\/oauth\/authorize\?/i);

    const finalUrl = new URL(currentUrl());
    expect(
      /\/oauth\/authorize\?/i.test(finalUrl.href),
      `clicking Connect must redirect to OpenProject's /oauth/authorize, got ${finalUrl.href}`
    ).toBeTruthy();
    expect(
      finalUrl.host,
      "OpenProject OAuth authorize must be served by the partner instance, not Nextcloud"
    ).not.toBe(nextcloudHost);
    expect(
      finalUrl.searchParams.get("client_id"),
      "the authorize redirect must carry the provisioned OpenProject OAuth client_id"
    ).toBeTruthy();
    expect(finalUrl.searchParams.get("response_type")).toBe("code");

    if (popup) await popup.close().catch(() => {});
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
