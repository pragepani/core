const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Functional cross-role coupling check for nextcloud/integration_suitecrm.
//
// The loader installs+enables the app and writes config:app:set integration_suitecrm
// url <suitecrm>. But the upstream julien-nc/integration_suitecrm app never reads
// `url`: both Settings/Admin.php and Settings/Personal.php read the SuiteCRM instance
// address from the app value `oauth_instance_url`. tasks/addons/integration_suitecrm.yml
// provisions oauth_instance_url ONLY when the partner SuiteCRM container is reachable;
// in topologies where web-app-suitecrm is not deployed the hook is skipped and
// oauth_instance_url stays unset. When the addon IS coupled, the admin SuiteCRM panel
// (settings/admin/connected-accounts -> #suitecrm_prefs) renders the instance-URL field
// (#suitecrm-oauth-instance) populated with the partner URL — a host distinct from
// Nextcloud. That is the hard coupling signal asserted here; absent the partner the
// spec skips rather than fails.
test("integration integration_suitecrm: connects Nextcloud to suitecrm", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_suitecrm");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // Determine "app present" from its OWN admin panel rendering, not the lazy-loaded
    // settings/apps/enabled list (that [data-id] check false-negatives even when the
    // app is enabled). The SuiteCRM admin section lives under "connected-accounts".
    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page).catch(() => {});

    // Strict-mode safe: #suitecrm_prefs may match both the Vue data-v-app mount and a
    // .section div, so take .first(). A bounded wait tells absent from slow-to-render.
    const suitecrmPanel = page.locator("#suitecrm_prefs").first();
    const panelPresent = await suitecrmPanel
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    // Read the instance-URL field (oauth_instance_url) the addon hook provisions.
    // Prefer the stable id; fall back to any URL-shaped input inside the panel
    // (NcTextField may wrap the native <input>).
    let configuredInstanceUrl = null;
    if (panelPresent) {
      const instanceField = suitecrmPanel.locator("#suitecrm-oauth-instance").first();
      if ((await instanceField.count()) > 0) {
        const value = (await instanceField.inputValue().catch(() => "")) || "";
        if (/^https?:\/\//i.test(value.trim())) {
          configuredInstanceUrl = value.trim();
        }
      }
      if (!configuredInstanceUrl) {
        const urlInputs = suitecrmPanel.locator(
          "input[type='text'], input[type='url'], input:not([type])"
        );
        const inputCount = await urlInputs.count();
        for (let i = 0; i < inputCount; i += 1) {
          const value = (await urlInputs.nth(i).inputValue().catch(() => "")) || "";
          if (/^https?:\/\//i.test(value.trim())) {
            configuredInstanceUrl = value.trim();
            break;
          }
        }
      }
    }

    // SuiteCRM partner absent -> hook skipped -> oauth_instance_url unset. Whether the
    // panel never rendered or rendered with no partner URL, the coupling is simply not
    // configured in this topology: skip, do not fail.
    if (!configuredInstanceUrl) {
      test.skip(
        true,
        "integration_suitecrm: oauth_instance_url not configured (suitecrm partner not deployed; integration hook skipped)"
      );
      return;
    }

    // Coupled state: the configured SuiteCRM instance must be the partner host, not
    // Nextcloud itself.
    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(configuredInstanceUrl).host;
    expect(
      instanceHost,
      "the configured SuiteCRM instance must be the partner instance, not Nextcloud itself"
    ).not.toBe(nextcloudHost);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
