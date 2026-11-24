import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CredentialStore, Provider } from "../src/credentials/provider.js";
import { ProviderCreditsService } from "../src/credits/provider-credits-service.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("provider credits calculate the OpenRouter remaining balance", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        JSON.stringify({ data: { total_credits: 25, total_usage: 7.5 } }),
        { status: 200 },
      ),
    { preconnect: () => {} },
  );
  const service = new ProviderCreditsService({
    read: async (provider: Provider) =>
      provider === "openrouter" ? "management-key" : "provider-key",
  } as CredentialStore);

  const credits = await service.get();

  assert.deepEqual(credits[0], {
    provider: "openrouter",
    balanceUsd: 17.5,
    status: "available",
    detail: "OpenRouter credits remaining.",
  });
  assert.equal(credits[1]?.status, "unsupported");
  assert.equal(credits[2]?.status, "unsupported");
  assert.deepEqual(
    credits.find((c) => c.provider === "typesafe"),
    {
      provider: "typesafe",
      status: "unsupported",
      balanceUsd: null,
      detail: "TypeSafe does not publish a credit balance through its API.",
    },
  );
});

test("provider credits explain when a balance endpoint is unavailable", async () => {
  globalThis.fetch = Object.assign(
    async () => new Response(null, { status: 403 }),
    { preconnect: () => {} },
  );
  const service = new ProviderCreditsService({
    read: async () => "inference-key",
  } as CredentialStore);

  const credits = await service.get();

  assert.equal(credits[0]?.status, "unavailable");
  assert.match(credits[0]?.detail ?? "", /management key/i);
});
