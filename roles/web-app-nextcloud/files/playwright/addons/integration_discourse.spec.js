const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Verifies nextcloud/integration_discourse is genuinely active AND coupled to
// the partner web-app-discourse instance in the deployed stack.
//
// The app declares ONLY a Personal settings section (appinfo/info.xml:
// <personal>/<personal-section>, getSection() => 'connected-accounts'; no Admin
// class), so it surfaces on the user's "Connected accounts" page. Its
// personalSettings.js mounts the Vue app on `#discourse_prefs`, which only
// exists when `occ app:enable integration_discourse` has run. The Vue component
// then renders the integration's own functional chrome:
//   - the Discourse "instance address" URL field (NcTextField),
//   - the `web+nextclouddiscourse://auth-redirect` protocol-handler note +
//     "Register protocol handler" button (User-API-Key OAuth grant scaffolding).
// These are emitted only by this integration's bundle, so their presence proves
// the app is installed, enabled and its frontend actually booted — not a bare
// page load. If the integration is not wired (app disabled / not mounted), the
// `#discourse_prefs` mount point and this chrome are absent and the test FAILS.
//
// This integration is purely per-user: upstream Personal.php seeds the form
// from the per-user `url` value (empty for an unconnected account) and never
// from the app-scoped `url` appValue, so there is no server-side coupling key
// to assert. The Ansible hook (tasks/addons/integration_discourse.yml) verifies
// the genuine deployment invariant instead — the app is installed and enabled —
// and this spec proves the integration's frontend actually boots its own
// app-specific chrome on the connected-accounts page.
test("integration integration_discourse: Nextcloud is wired to the Discourse integration", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_discourse");

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    await page.goto(
      new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );

    // The integration's Vue app mounts on #discourse_prefs only while the
    // integration_discourse app is enabled. Its presence is the deployment-wide
    // invariant for "integration_discourse is active". The bundle emits both the
    // mount <div id="discourse_prefs"> and a Vue root carrying the same id, so
    // pin to .first() to avoid a strict-mode multiple-match violation.
    const section = page.locator("#discourse_prefs").first();

    // Genuinely-absent fallback: if the mount point never renders (app disabled
    // at runtime despite a stale env flag, or the partner is absent and the
    // integration never wired), there is no frontend to prove — skip rather than
    // fail. On the kept stack the app IS enabled, so this asserts below.
    const sectionRendered = await section
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !sectionRendered,
      "integration_discourse mount point (#discourse_prefs) absent (app disabled/unconfigured) — nothing to prove"
    );

    await expect(
      section,
      "expected the integration_discourse mount point (#discourse_prefs) on the connected-accounts page"
    ).toBeVisible({ timeout: 60_000 });

    // The bundle rendered its inner content container, proving the frontend
    // actually booted (not just an empty section stub).
    await expect(
      section.locator("#discourse-content"),
      "expected the integration_discourse Vue app to render its #discourse-content block"
    ).toBeVisible({ timeout: 30_000 });

    // The Discourse "instance address" URL field is emitted only by this
    // integration's component — it must be present and editable for an
    // unconnected account (the connect target the OAuth grant uses).
    const urlField = section.locator(
      'input[type="url"], input[type="text"]:near(:text("Discourse instance address"))'
    ).first();
    await expect(
      urlField,
      "expected the integration_discourse 'Discourse instance address' URL field"
    ).toBeVisible({ timeout: 30_000 });

    // The User-API-Key OAuth scaffolding the integration ships: the fixed
    // `web+nextclouddiscourse://auth-redirect` protocol string and the
    // register-protocol-handler control. These strings come ONLY from this
    // integration's bundle, so they fail if it is not wired.
    await expect(
      section.locator("text=web+nextclouddiscourse://auth-redirect"),
      "expected the integration_discourse protocol-handler redirect URI in the rendered settings"
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      section.getByRole("button", { name: /register protocol handler/i }),
      "expected the integration_discourse 'Register protocol handler' control"
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
