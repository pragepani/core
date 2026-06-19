const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// Functional cross-role coupling check for nextcloud/xwiki.
//
// The upstream "xwiki" app reads its instance list via
// SettingsManager::getFromAppJSON('instances', '[]') (json_decode of the
// `instances` appValue). The generic loader serialises that LIST configvalue as a
// Python repr (single quotes), which json_decode() rejects -> getInstances()
// returns [] and the integration is NOT wired. tasks/addons/xwiki.yml rewrites
// `instances` as valid JSON pointing at the partner XWiki instance. The app's own
// admin section (lib/Settings/AdminSection.php getID() == 'xwiki', template
// templates/admin.php) then renders one <input name="instance-url"> per
// configured instance, populated with that URL, and HIDES the
// "#no-wikis-registered-p" placeholder. That populated instance-url input — host =
// the XWiki partner, not Nextcloud — is the hard coupling signal asserted here.
test("xwiki addon: Nextcloud admin XWiki settings are coupled to the partner instance", async ({ browser }) => {
  skipUnlessAddonEnabled("xwiki");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // Presence + hard coupling signal in one place: the app's own admin section
    // (#settings/admin/xwiki) renders the configured instances. Determine "app
    // present" from this panel rendering, not the lazy data-id apps list.
    await page.goto(
      new URL("settings/admin/xwiki", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const instanceList = page.locator("#xwiki-admin-instance-list").first();
    const panelRendered = await instanceList
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !panelRendered,
      "xwiki admin instances table absent (app disabled/unconfigured) — nothing to couple"
    );

    // If instances decode to [] (generic-config JSON bug, hook missing/broken),
    // the template emits the "No wikis are registered yet." placeholder. Its
    // presence means the integration is NOT wired -> fail.
    const noWikis = page.locator("#no-wikis-registered-p");
    await expect(
      noWikis,
      "XWiki must report at least one registered instance (instances appValue must be valid JSON coupling to the partner)"
    ).toHaveCount(0);

    // Collect the populated (non-template) instance-url inputs and confirm one
    // carries an absolute URL whose host is the XWiki partner, not Nextcloud.
    const urlInputs = instanceList.locator("input[name='instance-url']");
    const inputCount = await urlInputs.count();
    expect(
      inputCount,
      "the XWiki admin table must render at least one instance-url input"
    ).toBeGreaterThan(0);

    let configuredUrl = null;
    for (let i = 0; i < inputCount; i += 1) {
      const value = (await urlInputs.nth(i).inputValue().catch(() => "")) || "";
      if (/^https?:\/\//i.test(value.trim())) {
        configuredUrl = value.trim();
        break;
      }
    }

    expect(
      configuredUrl,
      "the XWiki admin instances table must contain a populated instance-url (addon hook writes valid-JSON instances)"
    ).toBeTruthy();

    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(configuredUrl).host;
    expect(
      instanceHost,
      "the configured XWiki instance must be the partner instance, not Nextcloud itself"
    ).not.toBe(nextcloudHost);
    expect(
      instanceHost,
      "the XWiki instances appValue must point at the deployed XWiki partner host"
    ).toBe("x.wiki.infinito.example");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
