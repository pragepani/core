const { expect } = require("@playwright/test");
const { decodeDotenvQuotedValue, performKeycloakLoginForm } = require("./personas");

const env = {
  odooBaseUrl: decodeDotenvQuotedValue(process.env.ODOO_BASE_URL || ""),
  oidcIssuerUrl: decodeDotenvQuotedValue(process.env.OIDC_ISSUER_URL || ""),
  adminUsername: decodeDotenvQuotedValue(process.env.ADMIN_USERNAME || ""),
  adminPassword: decodeDotenvQuotedValue(process.env.ADMIN_PASSWORD || ""),
};

function baseUrl() {
  return env.odooBaseUrl.replace(/\/$/, "");
}

async function clickOdooSsoButton(locator) {
  const providerList = locator.locator(".o_login_auth, .o_auth_oauth_providers");
  const ssoButton = locator
    .locator('a[href*="/auth_oauth/signin"], a[href*="auth_oauth/signin"]')
    .filter({ hasText: /login with sso|sign in with|continue with/i })
    .first();
  const ssoButtonByText = locator.getByRole("link", { name: /login with sso/i }).first();

  await Promise.any([
    providerList.first().waitFor({ state: "visible", timeout: 60_000 }),
    ssoButton.waitFor({ state: "visible", timeout: 60_000 }),
    ssoButtonByText.waitFor({ state: "visible", timeout: 60_000 }),
  ]);

  if (await ssoButtonByText.isVisible().catch(() => false)) {
    await ssoButtonByText.click();
  } else {
    await ssoButton.click();
  }
}

async function loginToOdoo(page) {
  const expectedBaseUrl = baseUrl();
  await page.goto(`${expectedBaseUrl}/web/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  await clickOdooSsoButton(page);

  await expect
    .poll(() => page.url(), {
      timeout: 60_000,
      message: "Expected page to navigate to Keycloak for authentication",
    })
    .toContain(env.oidcIssuerUrl.replace(/\/$/, ""));

  await performKeycloakLoginForm(page, env.adminUsername, env.adminPassword);

  await expect
    .poll(() => page.url(), {
      timeout: 60_000,
      message: "Expected page to navigate back to authenticated Odoo (not login page)",
    })
    .toMatch(new RegExp(`^${expectedBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!/web/login)`));
}

async function openModule(page, modulePath) {
  const url = `${baseUrl()}/${String(modulePath).replace(/^\//, "")}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const appShell = page.locator(
    ".o_web_client, .o_action_manager, .o_main_navbar, .o_content, .o_list_view, .o_kanban_view"
  );
  // Odoo bootstraps a heavy web-client asset bundle per module; under serial test
  // load the first render can take well over a minute, so allow generous time.
  await expect(appShell.first()).toBeVisible({ timeout: 120_000 });
}

module.exports = { env, baseUrl, clickOdooSsoButton, loginToOdoo, openModule };
