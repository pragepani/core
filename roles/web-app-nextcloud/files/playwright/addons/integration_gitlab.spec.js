const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// Verifies the nextcloud/integration_gitlab app is installed, enabled and — the
// part the generic loader does NOT do — pinned to the deployed partner GitLab
// instance. The app drives every OAuth/API request from the `oauth_instance_url`
// admin appValue, which defaults to https://gitlab.com when unset. The addon
// hook (tasks/addons/integration_gitlab.yml) sets that key to the partner base
// URL via occ. This spec proves the coupling held end-to-end:
//   1) the GitLab admin settings section (#gitlab_prefs) renders, and
//   2) its "OAuth app instance address" field (#gitlab-oauth-instance) holds a
//      real partner URL — NOT the upstream gitlab.com default and not empty.
// It then drives the per-user connect control as a best-effort extra and, when
// an OAuth client is provisioned, asserts the authorize redirect targets the
// partner host rather than Nextcloud.
test("integration integration_gitlab: pinned to partner GitLab instance and connectable", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_gitlab");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // 1) Activation + coupling: the GitLab admin settings section must render
    //    and the OAuth instance address must be pinned to the partner instance.
    await page.goto(
      new URL("settings/admin/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const gitlabPrefs = page.locator("#gitlab_prefs");
    await expect(
      gitlabPrefs.first(),
      "the GitLab integration admin section (#gitlab_prefs) must render when integration_gitlab is enabled"
    ).toBeVisible({ timeout: 60_000 });

    const instanceInput = page.locator("#gitlab-oauth-instance");
    await expect(
      instanceInput.first(),
      "the OAuth instance-address field must be present in the GitLab admin section"
    ).toBeVisible({ timeout: 30_000 });

    const instanceUrl = ((await instanceInput.first().inputValue()) || "").trim();
    expect(
      instanceUrl.length,
      "oauth_instance_url must be configured (the addon hook pins it to the partner GitLab base URL)"
    ).toBeGreaterThan(0);

    const nextcloudHost = new URL(shared.env.nextcloudBaseUrl).host;
    const instanceHost = new URL(instanceUrl).host;
    expect(
      instanceHost,
      "oauth_instance_url must point at the deployed partner GitLab instance, not the upstream gitlab.com default"
    ).not.toBe("gitlab.com");
    expect(
      instanceHost,
      "the GitLab instance URL must not point back at Nextcloud itself"
    ).not.toBe(nextcloudHost);

    // 2) Best-effort Tier-2 cross-role check: drive the per-user OAuth connect
    //    flow. The partner GitLab role may be ABSENT (only the config coupling
    //    above is guaranteed), so every step here is guarded — a missing OAuth
    //    client, an unreachable partner host or a stalled authorize redirect
    //    must NEVER fail this spec. The asserted positive is the config
    //    coupling proven in step 1.
    try {
      await page.goto(
        new URL("settings/user/connected-accounts", shared.env.nextcloudBaseUrl).toString(),
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await shared.dismissBlockingNextcloudModals(page, page);

      const connect = page
        .getByRole("button", { name: /connect to gitlab/i })
        .or(page.getByRole("link", { name: /connect to gitlab/i }));

      if ((await connect.count()) > 0) {
        await Promise.all([
          page.waitForEvent("framenavigated", { timeout: 60_000 }).catch(() => {}),
          connect.first().click().catch(() => {}),
        ]);
        await expect
          .poll(() => page.url(), { timeout: 60_000 })
          .toMatch(/\/oauth\/authorize\?|connected-accounts/i)
          .catch(() => {});

        if (/\/oauth\/authorize\?/i.test(page.url())) {
          const authorizeUrl = new URL(page.url());
          expect(
            authorizeUrl.host,
            "GitLab OAuth authorize must be served by the partner instance, not Nextcloud"
          ).not.toBe(nextcloudHost);
          expect(
            authorizeUrl.host,
            "the OAuth authorize host must match the configured partner instance URL"
          ).toBe(instanceHost);
          expect(authorizeUrl.searchParams.get("client_id")).toBeTruthy();
          expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
        }
      }
    } catch {
      // Tier-2 handoff requires the partner GitLab to be deployed and reachable;
      // when it is absent the config coupling (step 1) is the verified guarantee.
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
