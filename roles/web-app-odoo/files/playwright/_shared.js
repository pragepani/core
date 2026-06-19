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
  const notLoginUrl = new RegExp(
    `^${expectedBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!/web/login)`
  );
  const webClient = page.locator(".o_web_client, .o_main_navbar, .o_action_manager").first();

  // The OAuth (implicit token) round-trip can land back on Odoo without a fully
  // established session, so a URL check alone is a false positive. Also, when a
  // realm session already exists, the SSO click bounces straight back to an
  // authenticated Odoo without showing the Keycloak form. Handle both: fill the
  // Keycloak form only when it appears, then confirm an authenticated web client.
  const issuer = env.oidcIssuerUrl.replace(/\/$/, "");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(`${expectedBaseUrl}/web/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await clickOdooSsoButton(page);

    await Promise.race([
      page.waitForURL((u) => u.toString().startsWith(issuer), { timeout: 60_000 }).catch(() => {}),
      webClient.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    ]);
    if (page.url().startsWith(issuer)) {
      await performKeycloakLoginForm(page, env.adminUsername, env.adminPassword);
      await expect
        .poll(() => page.url(), { timeout: 60_000, message: "Expected page to navigate back from Keycloak to Odoo" })
        .toMatch(notLoginUrl);
    }

    await page.goto(`${expectedBaseUrl}/odoo`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const rendered = await webClient
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (rendered) {
      return;
    }
  }
  throw new Error(
    "Odoo SSO login did not establish an authenticated session: the web client did not render after the Keycloak OAuth round-trip"
  );
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
