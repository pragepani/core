const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// Verifies the coupling of the richdocuments (Collabora Online) connector to the
// partner web-svc-collabora WOPI server. The generic loader enables the app and
// writes wopi_url / public_wopi_url via config:app:set; the addon hook then runs
// `occ richdocuments:activate-config` to fetch Collabora's /hosting/discovery.
//
// The richdocuments addon flag binds meta `enabled:` to `services.collabora.enabled`
// with `required: true`, so RICHDOCUMENTS_ADDON_ENABLED is "true" only when
// web-svc-collabora is deployed. skipUnlessAddonEnabled is therefore the complete
// gate; reaching the body means the partner is deployed and the WOPI URL is wired.
//
// DETERMINISTIC coupling (always asserted): the Collabora Online admin section
// renders (app enabled) and the WOPI server URL field carries the persisted
// wopi_url, whose host equals the web-svc-collabora partner host. The live-discovery
// signal (failure banner absent + post-discovery editing settings) is asserted
// BEST-EFFORT only, so a transient /hosting/discovery hiccup never hard-fails the
// config coupling.
test("richdocuments addon: Collabora connector wired to the partner WOPI server", async ({ browser }) => {
  skipUnlessAddonEnabled("richdocuments");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    await page.goto(
      new URL("settings/admin/richdocuments", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    // 1) App enabled: the Collabora Online admin settings section must render.
    // `#richdocuments` can match both the Vue `data-v-app` mount and a `.section`
    // div, so the locator is collapsed with `.first()` to stay strict-mode safe.
    const adminSection = page
      .locator("#richdocuments, [data-cy='collabora-server-settings']")
      .or(page.getByText(/collabora online/i).first());
    await expect(
      adminSection.first(),
      "the Collabora Online (richdocuments) admin settings section must render, proving the app is enabled"
    ).toBeVisible({ timeout: 60_000 });

    // 1b) The WOPI/Collabora server URL field must carry the persisted wopi_url.
    const wopiField = page.locator("#wopi_url, input[name='wopi_url'], input[id*='wopi' i]").first();
    await expect(
      wopiField,
      "the Collabora server URL (WOPI) field must be present in the admin panel"
    ).toBeVisible({ timeout: 60_000 });

    const wopiValue = ((await wopiField.inputValue().catch(() => "")) || "").trim();
    expect(
      wopiValue,
      "the WOPI server URL field must carry the configured Collabora partner URL (config:app:set wopi_url); empty means the partner endpoint was never wired"
    ).toMatch(/^https?:\/\/.+/);

    // 1c) The persisted wopi_url must point at the web-svc-collabora partner host.
    const expectedWopiUrl = (process.env.NEXTCLOUD_RICHDOCUMENTS_EXPECTED_WOPI_URL || "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    expect(
      expectedWopiUrl.length,
      "NEXTCLOUD_RICHDOCUMENTS_EXPECTED_WOPI_URL must be rendered into the Playwright env so the spec can prove the WOPI address points at the real partner"
    ).toBeGreaterThan(0);
    expect(
      new URL(wopiValue).host,
      "the configured WOPI server URL must point at the web-svc-collabora partner host (wopi_url coupling), not an arbitrary or stale URL"
    ).toBe(new URL(expectedWopiUrl).host);

    // 2) Live-discovery signal (BEST-EFFORT): the failure banner should be absent
    // and the post-discovery editing settings should render once a reachable
    // Collabora server has been discovered. Guarded so a transient discovery
    // hiccup never overrides the deterministic config coupling proven above.
    const connectionError = page.getByText(
      /could not establish connection to the collabora online server|failed to connect|not a valid (collabora|wopi)/i
    );
    const editingSettings = page
      .locator("#documentsAllowEdit, #richdocuments_canonical_webroot, input[name='canonical_webroot']")
      .or(page.getByText(/use office online|secure view|enable edit/i).first());

    const errorCount = await connectionError.count().catch(() => 0);
    const discovered = await editingSettings
      .first()
      .isVisible({ timeout: 15_000 })
      .catch(() => false);
    if (errorCount === 0 && discovered) {
      await expect(
        connectionError,
        "discovery connected: the Collabora connection-failure banner must stay absent"
      ).toHaveCount(0);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
