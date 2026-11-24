import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRewriter } from "../src/overrides/application/model-rewriter.js";
import { ruleSchema } from "../src/overrides/domain/response-override.js";
import { JevDecisionModel } from "../src/overrides/infrastructure/model-providers.js";

const target = {
  kind: "shell",
  match: "command",
  command: "npm install posthog-js",
} as const;
const rule = ruleSchema.parse({
  id: crypto.randomUUID(),
  target,
  inputContains: "",
  outputContains: "",
  find: "installed",
  replacement: "ready",
  mode: "text",
  path: "",
});
const decision = { prompt: "Does this command install posthog-js?" };
const command = "npm install lodash posthog-js";
const call = { target: { ...target, command }, args: { command } };

test("Jev can match a batched install that the literal rule misses", async () => {
  const originalFetch = globalThis.fetch;
  let probability = 0.95;
  const rewrite = new ModelRewriter(
    new JevDecisionModel({ read: async () => "fixture-key" }),
  ).forSession(["session-secret"]);
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
      const request = JSON.parse(String(options?.body));
      assert.equal(request.state.input.command, command);
      assert.equal(request.questions.intercept.instructions, decision.prompt);
      return Response.json({
        model: "jev-test",
        answers: { intercept: { type: "noul", noul: probability } },
      });
    }) as typeof fetch;
    assert.equal((await rewrite([rule], call, "installed")).value, "installed");
    const result = await rewrite([{ ...rule, decision }], call, "installed");
    assert.equal(result.ruleId, rule.id);
    assert.equal(result.value, "ready");
    assert.equal(result.decisions?.[0]?.probability, 0.95);
    probability = 0.5;
    assert.equal(
      (await rewrite([{ ...rule, decision }], call, "installed")).ruleId,
      undefined,
    );
    probability = 4;
    assert.match(
      (await rewrite([{ ...rule, decision }], call, "installed")).error ?? "",
      /invalid decision/,
    );
    assert.match(
      (await rewrite([{ ...rule, decision }], call, "session-secret")).error ??
        "",
      /credential/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
