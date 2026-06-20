const { test, expect } = require("@playwright/test");
const { skipUnlessAddonEnabled } = require("../addon-gating");
const shared = require("../_shared");

test.use({ ignoreHTTPSErrors: true });

const BOT_LOCALPART = "facebookbot";

test("mautrix-facebook addon: bridge appservice bot is provisioned on and reachable through the Synapse homeserver", async ({ request }) => {
  skipUnlessAddonEnabled("mautrix-facebook");
  test.setTimeout(60_000);

  const { matrixBaseUrl, matrixServerName } = shared.env;
  expect(matrixBaseUrl, "MATRIX_BASE_URL must be set for the mautrix-facebook bridge probe").toBeTruthy();
  expect(matrixServerName, "MATRIX_SERVER_NAME must be set for the mautrix-facebook bridge probe").toBeTruthy();

  const botUserId = `@${BOT_LOCALPART}:${matrixServerName}`;
  const profileUrl = `${matrixBaseUrl}/_matrix/client/v3/profile/${encodeURIComponent(botUserId)}`;

  const probeHost = new URL(profileUrl).host;
  expect(
    probeHost,
    "the bridge round-trip must reach the partner Synapse homeserver, not a bare server-name"
  ).toBe(new URL(matrixBaseUrl).host);

  const response = await request.get(profileUrl, { failOnStatusCode: false });
  const status = response.status();
  const body = await response.text();

  expect(
    status,
    `Synapse returned HTTP ${status} for ${botUserId}. When mautrix-facebook is enabled the bridge must register its appservice on the homeserver; a 5xx means the bridge/appservice round-trip to Synapse failed.\n${body.slice(0, 400)}`
  ).toBeLessThan(500);

  expect(
    status,
    `Synapse has no profile for ${botUserId} (HTTP ${status}). When mautrix-facebook is enabled the @${BOT_LOCALPART}:${matrixServerName} appservice bot MUST exist on the homeserver — its absence means the bridge never reached Synapse / never registered, so the coupling failed. The test MUST fail here, not skip.\n${body.slice(0, 400)}`
  ).toBe(200);

  const profile = JSON.parse(body);
  expect(
    profile,
    `the ${botUserId} profile returned by Synapse must be an object describing the provisioned bridge bot`
  ).toBeTruthy();
  expect(typeof profile).toBe("object");
});
