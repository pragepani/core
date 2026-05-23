const { test, expect } = require("@playwright/test");
const { decodeDotenvQuotedValue, normalizeBaseUrl } = require("./personas");
const { isServiceEnabled } = require("./service-gating");

const lamEnabled = isServiceEnabled("lam");
const lamOauth2Fronted = String(process.env.LAM_OAUTH2_FRONTED || "").toLowerCase() === "true";
const lamBaseUrl = normalizeBaseUrl(process.env.LAM_BASE_URL || "");
const lamPassword = decodeDotenvQuotedValue(process.env.LAM_PASSWORD);

exports.register = function (shared) {
  test.describe("keycloak → ldap write-through, verified via LAM", () => {
    test.skip(!shared.env.oidcEnabled, "OIDC shared service disabled");
    test.skip(!lamEnabled, "LAM not deployed (LAM_SERVICE_ENABLED=false)");

    test("middleName edited in Keycloak appears in LDAP via LAM", async ({ page, context }) => {
      expect(shared.env.oidcIssuerUrl, "OIDC_ISSUER_URL must be set in env").toBeTruthy();
      expect(shared.env.oidcClientId, "OIDC_CLIENT_ID must be set in env").toBeTruthy();
      expect(lamBaseUrl, "LAM_BASE_URL must be set in env").toBeTruthy();

      const probe = `LAM-${Date.now()}`;

      await page.goto(`${shared.env.oidcIssuerUrl}/.well-known/openid-configuration`);
      const restResult = await page.evaluate(shared.setMiddleNameViaAccountRest, {
        issuer: shared.env.oidcIssuerUrl,
        clientId: shared.env.oidcClientId,
        username: shared.env.biberUsername,
        password: shared.env.biberPassword,
        middleName: probe,
        withRestore: false,
      });

      expect(
        restResult.stage,
        `Keycloak write must succeed: stage=${restResult.stage} status=${restResult.status}`
      ).toBe("ok");

      const lamPage = await context.newPage();
      await lamPage.goto(`${lamBaseUrl}/templates/login.php`, { waitUntil: "load" });

      if (lamOauth2Fronted) {
        const kcUsername = lamPage.locator("input[name='username'], input#username").first();
        await expect(kcUsername, "Keycloak login form must render for OAuth2-fronted LAM").toBeVisible({ timeout: 30_000 });
        await kcUsername.fill(shared.env.adminUsername);
        await lamPage.locator("input[name='password'], input#password").first().fill(shared.env.adminPassword);
        await lamPage.locator("button[type='submit'], input[name='login'], input[type='submit']").first().click();
        await lamPage.waitForLoadState("networkidle");

        const lamPwAfterSso = lamPage.locator("input[name='password'], input#passwd").first();
        if (lamPassword && await lamPwAfterSso.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await lamPwAfterSso.fill(lamPassword);
          await lamPage.locator("button[type='submit'], input[type='submit']").first().click();
          await lamPage.waitForLoadState("networkidle");
        }
      } else {
        expect(lamPassword, "LAM_PASSWORD must be set when LAM is not OAuth2-fronted").toBeTruthy();
        const lamPwInput = lamPage.locator("input[name='password'], input#passwd").first();
        await expect(lamPwInput, "LAM native login form must render").toBeVisible({ timeout: 30_000 });
        await lamPwInput.fill(lamPassword);
        await lamPage.locator("button[type='submit'], input[type='submit']").first().click();
        await lamPage.waitForLoadState("networkidle");
      }

      await lamPage.goto(`${lamBaseUrl}/templates/lists/list.php?type=user`, { waitUntil: "load" });
      const filter = lamPage.locator("input[name='filter_uid'], input[name*='filter']").first();
      if (await filter.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await filter.fill(shared.env.biberUsername);
        await filter.press("Enter");
        await lamPage.waitForLoadState("networkidle");
      }
      const biberLink = lamPage.locator(`a:has-text("${shared.env.biberUsername}")`).first();
      await expect(biberLink, "biber must appear in LAM user list").toBeVisible({ timeout: 30_000 });
      await biberLink.click();
      await lamPage.waitForLoadState("networkidle");

      await expect(
        lamPage.locator("body"),
        `LAM-rendered LDAP entry for ${shared.env.biberUsername} must contain probe "${probe}"`
      ).toContainText(probe, { timeout: 30_000 });
    });
  });
};
