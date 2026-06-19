const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

// Verifies the coupling of the spreed (Nextcloud Talk) High-Performance Backend
// to its partner services. The generic loader enables the app and persists
// signaling_servers / stun_servers / turn_servers / recording_servers via
// config:app:set; the spreed addon flag binds meta `enabled:` to
// `services.talk.enabled` with `required: true`, so skipUnlessAddonEnabled is the
// complete gate. Reaching the body means Talk is enabled.
//
// DETERMINISTIC coupling (always asserted): the OCS capabilities advertise a
// spreed signaling config (the HPB wiring is live) AND the Talk admin settings
// surface the persisted TURN server, whose host is the distinct web-svc-coturn
// partner host (NEXTCLOUD_TALK_EXPECTED_TURN_SERVER) — not the Nextcloud host.
// The signaling URL is path-on-NC-host so it is asserted as a presence check, but
// the TURN coupling is the discriminating partner-host assertion.
//
// The live "Test this server" reachability handoff is asserted BEST-EFFORT only,
// so a transient HPB/coturn network hiccup never overrides the config coupling.
test("spreed addon: Talk HPB signaling/turn backends are configured and coupled", async ({ browser }) => {
  skipUnlessAddonEnabled("spreed");
  test.setTimeout(120_000);

  const unquote = (v) => ((v || "").trim().replace(/^"(.*)"$/, "$1"));
  const expectedSignalingUrl = unquote(process.env.NEXTCLOUD_TALK_EXPECTED_SIGNALING_URL);
  const expectedTurnServer = unquote(process.env.NEXTCLOUD_TALK_EXPECTED_TURN_SERVER);
  const expectedStunServer = unquote(process.env.NEXTCLOUD_TALK_EXPECTED_STUN_SERVER);

  // SKIP WHEN GENUINELY ABSENT: when the HPB is not wired (no signaling URL and no
  // TURN server rendered into the env) there is no coupling to assert. The loader
  // would not have persisted the backends, so a positive assertion would false-fail.
  test.skip(
    !expectedSignalingUrl && !expectedTurnServer,
    "Talk HPB not configured in this env (no signaling/turn server rendered) — nothing to couple",
  );

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await shared.loginToStandaloneNextcloud(page);

    // 1) WIRING PROOF: OCS capabilities must advertise a spreed signaling config.
    // This is the app's OWN capability surface, not the lazy-loaded apps list.
    const capabilitiesUrl = new URL(
      "ocs/v2.php/cloud/capabilities?format=json",
      shared.env.nextcloudBaseUrl,
    ).toString();
    const capabilitiesResponse = await page.request.get(capabilitiesUrl, {
      headers: { "OCS-APIRequest": "true", Accept: "application/json" },
    });
    expect(capabilitiesResponse.ok(), "the OCS capabilities endpoint must respond").toBeTruthy();
    const capabilitiesBody = await capabilitiesResponse.json();
    const spreedCapabilities = capabilitiesBody?.ocs?.data?.capabilities?.spreed;
    expect(
      spreedCapabilities,
      "Nextcloud must advertise spreed (Talk) capabilities, proving the app is enabled and wired",
    ).toBeTruthy();
    expect(
      JSON.stringify(spreedCapabilities?.config ?? {}),
      "spreed must expose a signaling configuration, proving the HPB signaling_servers wiring is live",
    ).toMatch(/signaling/i);

    // 2) ENABLED SIGNAL: the Talk admin settings section must render.
    const talkAdminUrl = new URL("settings/admin/talk", shared.env.nextcloudBaseUrl).toString();
    await page.goto(talkAdminUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await shared.dismissBlockingNextcloudModals(page, page);

    await expect(
      page.getByText(/signaling/i).first(),
      "the Talk admin settings must render the High-Performance Backend (signaling) section",
    ).toBeVisible({ timeout: 60_000 });

    // Talk admin settings are part plain text, part <input value="…">. innerText
    // alone misses input values, so collect both before asserting coupling.
    const collectSettingsText = async () => {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const formValues = await page
        .locator("input, textarea, select")
        .evaluateAll((els) =>
          els.flatMap((el) => {
            const out = [];
            const value = typeof el.value === "string" ? el.value.trim() : "";
            const text = typeof el.textContent === "string" ? el.textContent.trim() : "";
            if (value) out.push(value);
            if (text) out.push(text);
            return out;
          }),
        )
        .catch(() => []);
      return [bodyText, ...formValues].filter(Boolean).join("\n");
    };

    // 3a) REAL COUPLING (discriminating): the persisted TURN server points at the
    // distinct web-svc-coturn partner host, surfaced in the Talk admin settings.
    if (expectedTurnServer) {
      await expect
        .poll(collectSettingsText, {
          timeout: 30_000,
          message: `the Talk admin settings must surface the configured HPB TURN server '${expectedTurnServer}' (turn_servers from the spreed addon, pointing at the web-svc-coturn partner host); a stock Talk install without the HPB wiring would not show it`,
        })
        .toContain(expectedTurnServer);
    }

    // 3b) Coupling: the persisted STUN server (coturn partner host:port) is shown.
    if (expectedStunServer) {
      await expect
        .poll(collectSettingsText, {
          timeout: 30_000,
          message: `the Talk admin settings must surface the configured HPB STUN server '${expectedStunServer}' (stun_servers from the spreed addon)`,
        })
        .toContain(expectedStunServer);
    }

    // 3c) Presence: the configured signaling server host (path on the NC host) is
    // shown. Asserted as a host-presence check since signaling is same-host.
    if (expectedSignalingUrl) {
      let signalingNeedle = expectedSignalingUrl;
      try {
        signalingNeedle = new URL(expectedSignalingUrl).host;
      } catch {
        signalingNeedle = expectedSignalingUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
      }
      await expect
        .poll(collectSettingsText, {
          timeout: 30_000,
          message: `the Talk admin settings must surface the configured HPB signaling server '${signalingNeedle}' (signaling_servers from the spreed addon)`,
        })
        .toContain(signalingNeedle);
    }

    // 4) LIVE HANDOFF (BEST-EFFORT): clicking "Test this server" should report an
    // OK row, but a transient HPB/coturn reachability hiccup must never override
    // the deterministic config coupling proven above.
    const connectionSpans = page.locator("span.test-connection");
    await connectionSpans
      .first()
      .waitFor({ state: "attached", timeout: 15_000 })
      .catch(() => {});
    const okRows = (await connectionSpans.allInnerTexts().catch(() => [])).filter((t) =>
      /OK:\s*Running version:\s*\S+/i.test(t),
    );
    if (okRows.length > 0) {
      const errored = (await connectionSpans.allInnerTexts().catch(() => [])).filter((t) =>
        /Error:|seems to be broken/i.test(t),
      );
      expect(
        errored,
        `a Talk backend reported OK yet another row reported a connection error: ${errored.join(" | ")}`,
      ).toHaveLength(0);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});
