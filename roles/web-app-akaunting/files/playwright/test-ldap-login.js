const { test, expect } = require("@playwright/test");
const { skipUnlessServiceEnabled } = require("./service-gating");

const { decodeDotenvQuotedValue, normalizeBaseUrl, performKeycloakLoginForm } = require("./personas");
test.use({ ignoreHTTPSErrors: true });

const baseUrl = normalizeBaseUrl(process.env.AKAUNTING_BASE_URL || "");
const canonicalDomain = decodeDotenvQuotedValue(process.env.CANONICAL_DOMAIN || "");
const adminUsername = decodeDotenvQuotedValue(process.env.ADMIN_USERNAME);
const adminPassword = decodeDotenvQuotedValue(process.env.ADMIN_PASSWORD);

test("LDAP: same oauth2-proxy gate when Keycloak federates user storage from LDAP (variant 1)", async ({ page }) => {
  expect(baseUrl, "AKAUNTING_BASE_URL must be set").toBeTruthy();
  expect(canonicalDomain, "CANONICAL_DOMAIN must be set").toBeTruthy();
  await page.context().clearCookies();

  skipUnlessServiceEnabled("ldap");
  expect(adminUsername).toBeTruthy(); expect(adminPassword).toBeTruthy();
  const expectedBase = baseUrl.replace(/\/$/, "");
  await page.goto(`${expectedBase}/`);
  await performKeycloakLoginForm(page, adminUsername, adminPassword);
  await expect.poll(() => page.url(), { timeout: 90_000 }).toContain(expectedBase);
  await expect(page.locator("body")).toBeVisible({ timeout: 60_000 });
});
