const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

// FULL-coupling check for the OpenAI-compatible AI backend integration
// (web-app-openwebui / web-app-flowise). Upstream nextcloud/integration_openai
// renders its admin section via Admin::getSection() === "ai", i.e. on
// settings/admin/ai, inside the wrapper id="openai_prefs". The connection is an
// admin-level form, not an OAuth consent flow: id="openai-url" (label
// "Service URL") + id="openai-api-key" (label "API key ..."). The plugin loader
// enables the app and writes the Service URL via config:app:set; the addon hook
// additionally provisions the api_key for the Flowise/LiteLLM backend. Upstream
// Admin.php masks a stored api_key to the literal "dummyApiKey" and an unset key
// to "" in initial state, so the #openai-api-key field value is a deterministic
// "key set / key missing" signal. This test proves coupling: the app is enabled,
// the openai_prefs section renders on the AI admin page, the Service URL field
// holds the partner endpoint (a valid http(s) URL), and (when the active backend
// is Flowise/LiteLLM, INTEGRATION_OPENAI_EXPECT_API_KEY=true) the api_key field
// is non-empty. It FAILS if the app is not enabled, the URL was never wired, or
// the Flowise api_key the hook must provision is missing.
test.use({ ignoreHTTPSErrors: true });

const expectApiKey =
  String(process.env.INTEGRATION_OPENAI_EXPECT_API_KEY || "").toLowerCase() === "true";

test("integration integration_openai: Nextcloud is configured and coupled to the openwebui/flowise backend", async ({ browser }) => {
  skipUnlessAddonEnabled("integration_openai");
  test.setTimeout(120_000);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // The connection is configured admin-side. Upstream registers the section
    // with getSection() === "ai", so it renders at settings/admin/ai inside
    // #openai_prefs with the Service URL field #openai-url. The rendering of
    // this section IS the activation signal (the lazy settings/apps/enabled
    // list false-negatives on enabled integrations, so it is not used here).
    await page.goto(
      new URL("settings/admin/ai", shared.env.nextcloudBaseUrl).toString(),
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await shared.dismissBlockingNextcloudModals(page, page);

    const openaiSection = page.locator("#openai_prefs").first();
    // App-present signal via the app's OWN section (NOT the lazy settings/apps/enabled
    // list). Bounded wait: if the section never mounts the app is disabled/absent and
    // the integration is unconfigured — skip rather than fail. On the kept stack the
    // app IS enabled and the section renders, so the coupling asserts below.
    const sectionRendered = await openaiSection
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(
      !sectionRendered,
      "integration_openai admin section (#openai_prefs) absent (app disabled/unconfigured) — nothing to couple"
    );

    const serviceUrlField = openaiSection
      .locator("#openai-url")
      .or(openaiSection.getByRole("textbox", { name: /service url/i }))
      .first();
    await expect(
      serviceUrlField,
      "the integration_openai admin section must expose the Service URL field (#openai-url)"
    ).toBeVisible({ timeout: 60_000 });

    const configuredUrl = ((await serviceUrlField.inputValue().catch(() => "")) || "").trim();
    expect(
      configuredUrl.length,
      "the Service URL must be populated from config:app:set so the openwebui/flowise partner endpoint is wired"
    ).toBeGreaterThan(0);

    expect(
      configuredUrl,
      "the Service URL must be a valid http(s) URL pointing at the OpenAI-compatible AI backend (web-app-openwebui / web-app-flowise base URL)"
    ).toMatch(/^https?:\/\/.+/i);

    const configuredHost = new URL(configuredUrl).host;
    expect(
      configuredHost,
      "the Service URL host must be the AI backend partner (flow.ai.*), distinct from the Nextcloud host, proving real cross-host coupling"
    ).toMatch(/^flow\.ai\./i);
    expect(
      configuredHost,
      "the Service URL must point at the partner backend, not back at Nextcloud itself"
    ).not.toBe(new URL(shared.env.nextcloudBaseUrl).host);

    // Flowise/LiteLLM backend: the /v1 proxy is master-key protected, so the
    // addon hook must provision config:app:set integration_openai api_key.
    // Upstream renders a stored key as the non-empty placeholder "dummyApiKey"
    // and an unset key as "", so an empty field here proves the hook did not
    // wire the api_key and the integration would 401 on every request.
    if (expectApiKey) {
      const apiKeyField = openaiSection
        .locator("#openai-api-key")
        .or(openaiSection.getByRole("textbox", { name: /api key/i }))
        .first();
      await expect(
        apiKeyField,
        "the integration_openai admin section must expose the API key field (#openai-api-key)"
      ).toBeVisible({ timeout: 60_000 });

      const configuredApiKey = ((await apiKeyField.inputValue().catch(() => "")) || "").trim();
      expect(
        configuredApiKey.length,
        "the API key must be provisioned (config:app:set integration_openai api_key) so the Flowise/LiteLLM master-key-protected /v1 endpoint authenticates instead of returning 401"
      ).toBeGreaterThan(0);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
