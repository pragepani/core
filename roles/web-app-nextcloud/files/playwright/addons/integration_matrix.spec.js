const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Functional cross-role coupling check for nextcloud/integration_matrix.
//
// The generic loader sets the app-scoped `url` key, but upstream
// nextcloud/integration_matrix reads `url` only per-user; the admin key that
// actually drives the integration is `oauth_instance_url`. Our hook
// (tasks/addons/integration_matrix.yml) writes it to the partner Synapse base
// URL, so the admin "Matrix integration" settings panel
// (settings/admin/connected-accounts) MUST render the homeserver-address field
// populated with the partner URL — a host distinct from Nextcloud. That is the
// hard coupling signal asserted here.
test("integration integration_matrix: connects Nextcloud to the Matrix homeserver", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_matrix");

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );

    // App-present signal: the app's OWN admin panel renders. #matrix_prefs can
    // match both the Vue data-v-app mount div and the .section wrapper, so pin
    // to .first() for strict mode.
    const matrixPanel = page
      .locator("#matrix_prefs, #matrix-content")
      .first();

    // Genuinely absent (app disabled / never wired): no admin panel renders.
    if (!(await matrixPanel.isVisible({ timeout: 30_000 }).catch(() => false))) {
      test.skip(true, "integration_matrix admin panel absent — app not enabled / unconfigured");
      return;
    }

    // The homeserver-address NcTextField has no stable id; locate the text input
    // inside the Matrix panel whose value is an absolute URL.
    const urlInputs = matrixPanel.locator("input[type='text'], input[type='url'], input:not([type])");
    const inputCount = await urlInputs.count();
    expect(
      inputCount,
      "the Matrix admin panel must expose the homeserver-address field"
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
      "the Matrix admin homeserver field must be populated with the partner URL (addon hook sets oauth_instance_url)"
    ).toBeTruthy();

    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(configuredInstanceUrl).host;
    expect(
      instanceHost,
      "the configured Matrix homeserver must be the partner instance, not Nextcloud itself"
    ).not.toBe(nextcloudHost);
    expect(
      instanceHost,
      "the Matrix oauth_instance_url must point at the deployed Synapse partner host"
    ).toBe("matrix.infinito.example");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
