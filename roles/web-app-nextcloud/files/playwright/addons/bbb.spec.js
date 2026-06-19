const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// The Nextcloud `bbb` app (cloud_bbb / BigBlueButton integration) renders its
// admin settings into the generic "additional" admin section as a `#bbb-settings`
// block whose `#bbb-api` form carries input[name='api.url'] (type=url) and
// input[name='api.secret'] (type=password). The plugin loader enables the app and
// writes api.url (partner base URL + the `/bigbluebutton/` API suffix) and
// api.secret (partner shared secret) via config:app:set. This test proves FULL
// coupling: the section renders (app enabled), the api.url field is populated with
// a valid https URL pointing at the BigBlueButton API mount, and the api.secret
// field is present (the credential half of the coupling). It FAILS if the app is
// not enabled or the partner endpoint was never wired.
test("bbb addon: BigBlueButton integration is configured and coupled to the partner server", async ({ browser }) => {
  skipUnlessAddonEnabled("bbb");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    await page.goto(
      new URL("settings/admin/additional", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const bbbSection = page.locator("#bbb-settings");
    await expect(
      bbbSection.first(),
      "the cloud_bbb admin settings section (#bbb-settings) must render on the additional admin page, proving the bbb app is enabled"
    ).toBeVisible({ timeout: 60_000 });

    const apiUrlField = bbbSection.locator("#bbb-api input[name='api.url'], input[name='api.url']");
    await expect(
      apiUrlField.first(),
      "the BigBlueButton (bbb) admin settings section must expose the api.url field"
    ).toBeVisible({ timeout: 60_000 });

    const configuredUrl = ((await apiUrlField.first().inputValue().catch(() => "")) || "").trim();
    expect(
      configuredUrl.length,
      "the bbb api.url field must be populated from config:app:set so the BigBlueButton partner endpoint is wired"
    ).toBeGreaterThan(0);

    expect(
      configuredUrl,
      "the bbb api.url must be a valid https URL pointing at the BigBlueButton API mount (the partner base URL + '/bigbluebutton/' API suffix)"
    ).toMatch(/^https:\/\/.+\/bigbluebutton\/?$/);

    const apiSecretField = bbbSection.locator("#bbb-api input[name='api.secret'], input[name='api.secret']");
    await expect(
      apiSecretField.first(),
      "the bbb settings must expose the api.secret field; together with api.url it forms the partner coupling written via config:app:set"
    ).toBeAttached({ timeout: 30_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
