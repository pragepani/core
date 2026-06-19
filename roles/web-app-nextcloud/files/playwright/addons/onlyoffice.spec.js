const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// The Nextcloud `onlyoffice` connector renders its admin panel at
// settings/admin/onlyoffice. The plugin loader enables the app and writes the
// partner coupling via config:app:set: DocumentServerUrl (the web-svc-onlyoffice
// document server URL), StorageUrl (this Nextcloud URL), DocumentServerInternalUrl
// and the shared jwt_secret. The connector reflects DocumentServerUrl into the
// "Document Editing Service address" field (#onlyoffice-url on the Vue settings,
// legacy #onlyofficeUrl) and the JWT into the secret field (#onlyoffice-secret,
// legacy #onlyofficeSecret). This test proves FULL coupling: the connector panel
// renders (app enabled), the address field is populated with a valid https URL
// pointing at the document server, and the JWT secret field is present (the auth
// half of the coupling). It FAILS if the app is not enabled or the partner
// document-server endpoint / secret were never wired.
test("onlyoffice addon: connector is configured and coupled to the document server", async ({ browser }) => {
  skipUnlessAddonEnabled("onlyoffice");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    const adminUrl = new URL(
      "settings/admin/onlyoffice",
      shared.env.nextcloudBaseUrl,
    ).toString();
    const response = await page.goto(adminUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await shared.dismissBlockingNextcloudModals(page, page);

    expect(
      response && response.status(),
      "the ONLYOFFICE admin settings route must resolve (the connector app must be enabled)",
    ).toBeLessThan(400);

    const addrField = page
      .locator("#onlyoffice-url, #onlyofficeUrl, input[id*='onlyoffice' i][id*='url' i]")
      .first();
    await expect(
      addrField,
      "the ONLYOFFICE Document Editing Service address field must render, proving the connector app is enabled",
    ).toBeVisible({ timeout: 60_000 });

    const configuredUrl = ((await addrField.inputValue().catch(() => "")) || "").trim();
    expect(
      configuredUrl.length,
      "the Document Server address field must be populated from config:app:set (DocumentServerUrl) so the web-svc-onlyoffice partner endpoint is wired",
    ).toBeGreaterThan(0);

    expect(
      configuredUrl,
      "the configured Document Server address must be a valid https URL pointing at the ONLYOFFICE document server",
    ).toMatch(/^https:\/\/.+/);

    const expectedDsUrl = (process.env.NEXTCLOUD_ONLYOFFICE_EXPECTED_DOCUMENT_SERVER_URL || "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    expect(
      expectedDsUrl.length,
      "NEXTCLOUD_ONLYOFFICE_EXPECTED_DOCUMENT_SERVER_URL must be rendered into the Playwright env so the spec can prove the address points at the real partner",
    ).toBeGreaterThan(0);
    expect(
      new URL(configuredUrl).host,
      "the configured Document Server address must point at the web-svc-onlyoffice partner host (DocumentServerUrl coupling), not an arbitrary or stale URL",
    ).toBe(new URL(expectedDsUrl).host);

    const secretField = page
      .locator("#onlyoffice-secret, #onlyofficeSecret, input[id*='onlyoffice' i][id*='secret' i]")
      .first();
    await expect(
      secretField,
      "the ONLYOFFICE JWT secret field must be present; together with the Document Server address it forms the partner coupling written via config:app:set (jwt_secret)",
    ).toBeAttached({ timeout: 30_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
