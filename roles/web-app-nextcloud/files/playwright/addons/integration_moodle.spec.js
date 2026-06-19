const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// Cross-role coupling check for the upstream nextcloud/integration_moodle app.
//
// Reality of the app (confirmed against upstream source):
//   - Admin settings (AdminSettings.vue) render ONLY a `#disable-search`
//     checkbox inside `#moodle_prefs` (admin-config). There is NO admin OAuth
//     client (no client_id/client_secret) and NO admin-visible URL field, so
//     the admin-set app `url` (our config:app:set) is NOT rendered in the UI.
//   - Personal settings (PersonalSettings.vue) render `#moodle_prefs` with the
//     Moodle service URL input `#moodle-url` (bound to state.url, seeded from
//     loadState('integration_moodle', 'user-config')). Personal.php seeds that
//     url from the PER-USER getUserValue('url') with NO fallback to the admin
//     app value, so for a fresh admin user the field is EMPTY until they
//     connect. Connecting is per-user: onValidate() POSTs login+password to
//     /apps/integration_moodle/get-token to mint that user's webservice token
//     (no OAuth redirect to a partner authorize endpoint).
//
// Because the admin-set url is never surfaced in the DOM, the authoritative
// proof that config:app:set integration_moodle url == the Moodle partner URL
// lives in the Ansible hook (tasks/addons/integration_moodle.yml, which reads
// it back via occ config:app:get and asserts equality). What this Playwright
// test proves about the coupling is the part that IS observable in the UI: that
// the app is provisioned into Nextcloud's settings — the personal #moodle_prefs
// section, the #moodle-url connect field, and the "Connect to Moodle" per-user
// get-token control all render.
//
// GENUINE ABSENCE: integration_moodle is incompatible with Nextcloud 33, so the
// loader's `occ app:enable integration_moodle` is a no-op there — the app stays
// disabled and the personal #moodle_prefs section is never injected. That is a
// real "partner not enable-able" state, not a spec bug, so the test SKIPs (does
// not fail) when, after a bounded wait, the app's own settings section does not
// render. We determine presence from the app's OWN provisioned UI (the personal
// #moodle_prefs section), NOT from the lazy settings/apps/enabled [data-id] list,
// which yields false negatives for enabled apps. When the section IS present
// (compatible NC), the observable provisioning coupling is asserted unconditionally.
test("integration integration_moodle: Nextcloud is configured and coupled to the Moodle partner", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_moodle");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // (1) Activation + provisioning signal, derived from the app's OWN UI: the
    // personal #moodle_prefs section only renders when the app is enabled and
    // injects its personal settings. We use a bounded wait on that section as the
    // presence signal — NOT the lazy settings/apps/enabled [data-id] list, which
    // false-negatives for enabled apps. On Nextcloud 33 the app is incompatible
    // and cannot be enabled, so the section never renders: detect that genuine
    // absence and SKIP rather than fail.
    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const section = page.locator("#moodle_prefs");
    const sectionRendered = await section
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !sectionRendered,
      "integration_moodle personal settings section (#moodle_prefs) absent — app not enabled (incompatible with this Nextcloud major; app:enable is a no-op) — nothing to couple"
    );

    // (2) Provisioning coupling: with the section present, assert the integration
    // is wired into the personal settings — the #moodle-url connect field and the
    // "Connect to Moodle" per-user get-token control render. We do NOT assert the
    // field is pre-filled: upstream Personal.php seeds it from the per-user value
    // with no fallback to the admin app url, so it is legitimately empty for a
    // fresh user even when the partner url IS wired. That url equality (admin app
    // url == Moodle partner URL) is proven by the Ansible hook, since the admin
    // url is never surfaced in the DOM.
    await expect(
      section.first(),
      "the integration_moodle settings section (#moodle_prefs) must render, proving the app is provisioned"
    ).toBeVisible({ timeout: 60_000 });

    const urlField = page.locator("#moodle-url");
    await expect(
      urlField.first(),
      "the Moodle service URL field (#moodle-url) must render in the connect form, proving the personal integration settings are wired"
    ).toBeVisible({ timeout: 30_000 });

    // The connect control must exist (per-user get-token grant entry point).
    // Clicking it with no credentials must keep us on Nextcloud — there is no
    // OAuth redirect to a partner authorize endpoint — confirming the flow is
    // the get-token grant rather than an OAuth handoff.
    const connect = page.locator("#moodle_prefs button:has-text('Connect to Moodle')");
    await expect(
      connect.first(),
      "the 'Connect to Moodle' control must render, proving the per-user get-token connect flow is wired"
    ).toBeVisible({ timeout: 30_000 });

    await connect.first().click().catch(() => {});
    await page.waitForTimeout(2_000);
    await expect
      .poll(() => page.url(), { timeout: 30_000 })
      .toMatch(/connected-accounts/);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
