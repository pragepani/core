const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const { skipUnlessServiceEnabled } = require("../service-gating");
const { normalizeBaseUrl, decodeDotenvQuotedValue, performKeycloakLoginForm } = require("../personas");

test.use({ ignoreHTTPSErrors: true });

const oidcIssuerUrl = normalizeBaseUrl(process.env.OIDC_ISSUER_URL || "");
const discourseBaseUrl = normalizeBaseUrl(process.env.DISCOURSE_BASE_URL || "");
const adminUsername = decodeDotenvQuotedValue(process.env.ADMIN_USERNAME);
const adminPassword = decodeDotenvQuotedValue(process.env.ADMIN_PASSWORD);

async function signInViaOidc(page) {
  const expectedOidcAuthUrl = `${oidcIssuerUrl}/protocol/openid-connect/auth`;

  await page.goto(`${discourseBaseUrl}/`);

  const oidcSignIn = page
    .locator("a, button")
    .filter({ hasText: /sign\s*in\s+with\s+oidc|sign\s*in\s+with\s+sso|continue\s+with\s+oidc|continue\s+with\s+sso|single\s+sign[-\s]*on|log\s*in|sign\s*up/i })
    .first();

  if ((await oidcSignIn.count().catch(() => 0)) > 0) {
    await oidcSignIn.click();
  } else {
    await page.goto(`${discourseBaseUrl}/auth/oidc`).catch(() => {});
  }

  await expect
    .poll(() => page.url(), {
      timeout: 60_000,
      message: `expected redirect to Keycloak OIDC auth (${expectedOidcAuthUrl})`,
    })
    .toContain(expectedOidcAuthUrl);

  await performKeycloakLoginForm(page, adminUsername, adminPassword);

  await expect
    .poll(() => page.url(), {
      timeout: 60_000,
      message: `expected redirect back to discourse at ${discourseBaseUrl}`,
    })
    .toContain(discourseBaseUrl);
}

function findSetting(settings, name) {
  return settings.find((s) => s && s.setting === name);
}

test("discourse-ldap-auth: LDAP auth plugin is installed and bound to the LDAP partner", async ({ page }) => {
  skipUnlessAddonEnabled("discourse-ldap-auth");
  skipUnlessServiceEnabled("ldap");

  expect(oidcIssuerUrl, "OIDC_ISSUER_URL must be set").toBeTruthy();
  expect(discourseBaseUrl, "DISCOURSE_BASE_URL must be set").toBeTruthy();
  expect(adminUsername, "ADMIN_USERNAME must be set").toBeTruthy();
  expect(adminPassword, "ADMIN_PASSWORD must be set").toBeTruthy();

  try {
    await page.context().clearCookies();
    await signInViaOidc(page);

    await expect(page.locator("body")).toContainText(
      /topic|category|welcome|latest|discourse/i,
      { timeout: 60_000 },
    );

    const siteSettings = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/admin/site_settings.json`, {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      if (!res.ok) return { ok: false, status: res.status };
      const body = await res.json();
      return { ok: true, settings: (body && body.site_settings) || [] };
    }, discourseBaseUrl);

    expect(
      siteSettings.ok,
      `expected /admin/site_settings.json to be reachable as admin (status ${siteSettings.status})`,
    ).toBe(true);

    const ldapEnabled = findSetting(siteSettings.settings, "ldap_auth_enabled");
    expect(
      ldapEnabled,
      "ldap_auth_enabled site setting must exist (LDAP auth plugin installed)",
    ).toBeTruthy();
    expect(
      String(ldapEnabled.value).toLowerCase(),
      "ldap_auth_enabled must be active",
    ).toBe("true");

    const ldapSync = findSetting(siteSettings.settings, "ldap_sync_enabled");
    expect(
      ldapSync,
      "ldap_sync_enabled site setting must exist (LDAP sync coupling)",
    ).toBeTruthy();
    expect(
      String(ldapSync.value).toLowerCase(),
      "ldap_sync_enabled must be active (Discourse must sync against the LDAP partner)",
    ).toBe("true");

    const ldapHost = findSetting(siteSettings.settings, "ldap_sync_host");
    expect(
      ldapHost,
      "ldap_sync_host site setting must exist",
    ).toBeTruthy();
    expect(
      String(ldapHost.value).trim().length,
      "ldap_sync_host must point at the LDAP partner server (non-empty)",
    ).toBeGreaterThan(0);

    const ldapBaseDn = findSetting(siteSettings.settings, "ldap_base_dn");
    expect(
      ldapBaseDn,
      "ldap_base_dn site setting must exist",
    ).toBeTruthy();
    expect(
      String(ldapBaseDn.value).trim(),
      "ldap_base_dn must be a real LDAP directory root (e.g. dc=...)",
    ).toMatch(/dc=/i);

    const ldapBindDn = findSetting(siteSettings.settings, "ldap_bind_dn");
    expect(
      ldapBindDn,
      "ldap_bind_dn site setting must exist",
    ).toBeTruthy();
    expect(
      String(ldapBindDn.value).trim().length,
      "ldap_bind_dn must be set so Discourse can bind to the LDAP partner",
    ).toBeGreaterThan(0);
  } finally {
    await page.context().clearCookies().catch(() => {});
  }
});
