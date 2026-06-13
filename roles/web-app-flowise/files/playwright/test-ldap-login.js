const { test, expect } = require("@playwright/test");
const { skipUnlessServiceEnabled } = require("./service-gating");
const { decodeDotenvQuotedValue, normalizeBaseUrl, performKeycloakLoginForm } = require("./personas");

const baseUrl = normalizeBaseUrl(process.env.FLOWISE_BASE_URL || "");
const canonicalDomain = decodeDotenvQuotedValue(process.env.CANONICAL_DOMAIN || "");
const adminUsername = decodeDotenvQuotedValue(process.env.ADMIN_USERNAME);
const adminPassword = decodeDotenvQuotedValue(process.env.ADMIN_PASSWORD);

test.use({ ignoreHTTPSErrors: true });

test("LDAP: same oauth2-proxy gate when Keycloak federates user storage from LDAP (variant 1)", async ({ page }) => {
  expect(baseUrl, "FLOWISE_BASE_URL must be set").toBeTruthy();
  expect(canonicalDomain, "CANONICAL_DOMAIN must be set").toBeTruthy();
  await page.context().clearCookies();

  skipUnlessServiceEnabled("ldap");
  expect(adminUsername, "ADMIN_USERNAME must be set when LDAP is enabled").toBeTruthy();
  expect(adminPassword, "ADMIN_PASSWORD must be set when LDAP is enabled").toBeTruthy();
  const expectedBaseUrl = baseUrl.replace(/\/$/, "");
  await page.goto(`${expectedBaseUrl}/`);
  await performKeycloakLoginForm(page, adminUsername, adminPassword);
  await expect
    .poll(() => page.url(), {
      timeout: 90_000,
      message: `expected redirect back to Flowise at ${expectedBaseUrl}`
    })
    .toContain(expectedBaseUrl);
  await expect(page.locator("body")).toBeVisible({ timeout: 60_000 });
});
