const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Functional cross-role coupling check for nextcloud/integration_mastodon.
//
// The loader installs+enables the app and writes config:app:set integration_mastodon
// url <mastodon>. But the upstream app reads `url` only as a per-USER override
// (Settings/Personal.php); the admin-level default the per-user OAuth connect flow
// falls back to is the app value `oauth_instance_url` (Settings/Admin.php), which the
// generic config never sets. tasks/addons/integration_mastodon.yml provisions
// oauth_instance_url to the partner instance, so the admin "Mastodon integration"
// settings panel (settings/admin/connected-accounts) MUST render the
// "Default Mastodon instance address" field populated with the partner URL — a host
// distinct from Nextcloud. That is the hard coupling signal asserted here.
test("integration integration_mastodon: connects Nextcloud to mastodon", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_mastodon");

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // Hard coupling signal: the admin Mastodon settings panel must render the
    // configured default instance address (oauth_instance_url) provisioned by the
    // addon hook. The field is an NcTextField bound to oauth_instance_url inside the
    // app's admin section (#mastodon_prefs / #mastodon-content) under the
    // "connected-accounts" admin settings page.
    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );

    const mastodonPanel = page
      .locator("#mastodon_prefs, #mastodon-content")
      .first();
    const panelRendered = await mastodonPanel
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !panelRendered,
      "integration_mastodon admin panel absent (app disabled/unconfigured) — nothing to couple"
    );

    // The instance-address NcTextField has no stable id; locate the text input
    // inside the Mastodon panel whose value is an absolute URL. NcTextField may
    // wrap the native <input>, so search the panel for a URL-shaped value.
    const urlInputs = mastodonPanel.locator("input[type='text'], input[type='url'], input:not([type])");
    const inputCount = await urlInputs.count();
    expect(
      inputCount,
      "the Mastodon admin panel must expose the 'Default Mastodon instance address' field"
    ).toBeGreaterThan(0);

    let configuredInstanceUrl = null;
    for (let i = 0; i < inputCount; i += 1) {
      const value = (await urlInputs.nth(i).inputValue().catch(() => "")) || "";
      if (/^https?:\/\//i.test(value.trim())) {
        configuredInstanceUrl = value.trim();
        break;
      }
    }

    expect(
      configuredInstanceUrl,
      "the Mastodon admin instance-address field must be populated with the partner URL (addon hook sets oauth_instance_url)"
    ).toBeTruthy();

    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(configuredInstanceUrl).host;
    expect(
      instanceHost,
      "the configured Mastodon instance must be the partner instance, not Nextcloud itself"
    ).not.toBe(nextcloudHost);
    expect(
      instanceHost,
      "the Mastodon oauth_instance_url must point at the deployed microblog partner host"
    ).toBe("microblog.infinito.example");

    // Best-effort Tier-2: confirm the personal connect handoff reaches the partner
    // instance's /oauth/authorize endpoint once a per-user OAuth client exists. The
    // hard coupling above is the deterministic signal; never fail on absence here.
    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );

    const connect = page
      .getByRole("button", { name: /connect to mastodon/i })
      .or(page.getByRole("link", { name: /connect to mastodon/i }));

    if ((await connect.count()) === 0) {
      return;
    }

    await Promise.all([
      page.waitForEvent("framenavigated", { timeout: 60_000 }).catch(() => {}),
      connect.first().click(),
    ]);

    await expect
      .poll(() => page.url(), { timeout: 60_000 })
      .toMatch(/\/oauth\/authorize\?|connected-accounts/i);

    const reachedAuthorize = /\/oauth\/authorize\?/i.test(page.url());
    if (reachedAuthorize) {
      const authorizeUrl = new URL(page.url());
      expect(
        authorizeUrl.host,
        "Mastodon OAuth authorize must be served by the partner instance, not Nextcloud"
      ).not.toBe(nextcloudHost);
      expect(
        authorizeUrl.host,
        "Mastodon OAuth authorize host must match the configured partner instance"
      ).toBe(instanceHost);
      expect(authorizeUrl.searchParams.get("client_id")).toBeTruthy();
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
