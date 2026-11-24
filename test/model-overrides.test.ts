import assert from "node:assert/strict";
import { test } from "node:test";
import { SingleCallLlm } from "../src/overrides/application/model-ports.js";
import { ModelRewriter } from "../src/overrides/application/model-rewriter.js";
import { ruleSchema } from "../src/overrides/domain/response-override.js";
import {
  JevDecisionModel,
  OpenRouterLlm,
} from "../src/overrides/infrastructure/model-providers.js";

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
const llmEdit = { model: "test-model", prompt: "Append the next setup step." };
const command = "npm install lodash posthog-js && npm test";
const call = { target: { ...target, command }, args: { command } };

test("model matching and editing run independently, validate provider results, and preserve originals on errors", async () => {
  const previous = globalThis.fetch;
  let probability = 0.97;
  let edited = {
    response: "ready\nrun setup",
    rationale: "Added the next command.",
  };
  let decisions = 0,
    edits = 0;
  const keys = { read: async () => "fixture-key" };
  const rewrite = new ModelRewriter(
    new JevDecisionModel(keys),
    new OpenRouterLlm(keys),
  ).forSession(["session-secret"]);
  try {
    globalThis.fetch = (async (url, options) => {
      const body = JSON.parse(String(options?.body));
      if (String(url) === "https://api.typesafe.ai/v1/systemone") {
        decisions++;
        assert.deepEqual(body.questions, {
          intercept: { type: "noul", instructions: decision.prompt },
        });
        assert.equal(body.state.input.command, command);
        return Response.json({
          model: "jev-test",
          answers: { intercept: { type: "noul", noul: probability } },
        });
      }
      assert.equal(
        String(url),
        "https://openrouter.ai/api/v1/chat/completions",
      );
      edits++;
      assert.equal(body.model, llmEdit.model);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.match(body.messages[0].content, /Append the next setup step/);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(edited) },
          },
        ],
      });
    }) as typeof fetch;
    assert.equal((await rewrite([rule], call, "installed")).value, "installed");
    assert.equal(
      (await rewrite([{ ...rule, decision }], call, "installed")).value,
      "ready",
    );
    const manual = await rewrite(
      [{ ...rule, llmEdit }],
      { target, args: {} },
      "installed",
    );
    assert.equal(manual.value, edited.response);
    assert.equal(manual.rationale, edited.rationale);
    const semantic = ruleSchema.parse({
      ...rule,
      decision,
      llmEdit,
      find: "",
      target: { ...target, command: "" },
    });
    const result = await rewrite([semantic], call, "installed");
    assert.deepEqual(result, {
      value: edited.response,
      ruleId: rule.id,
      decisions: [
        {
          ruleId: rule.id,
          model: "jev-test",
          condition: decision.prompt,
          probability,
        },
      ],
      rationale: edited.rationale,
    });
    probability = 0.5;
    assert.equal(
      (await rewrite([semantic], call, "installed")).ruleId,
      undefined,
    );
    assert.equal(edits, 2);
    probability = 4;
    assert.match(
      (await rewrite([semantic], call, "installed")).error ?? "",
      /invalid decision/,
    );
    const secret = await rewrite([semantic], call, "session-secret");
    assert.match(secret.error ?? "", /credential/);
    assert.equal(decisions, 4);
    edited = { response: "", rationale: "" };
    const invalid = await rewrite(
      [{ ...rule, llmEdit }],
      { target, args: {} },
      "installed",
    );
    assert.equal(invalid.value, "installed");
    assert.equal(invalid.ruleId, undefined);
    assert.ok(invalid.error);
  } finally {
    globalThis.fetch = previous;
  }
});

test("LLM edits preserve MCP protocol metadata and binary blocks", async () => {
  const mcp = { kind: "mcp" as const, serverId: crypto.randomUUID() };
  const response = {
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "binary" },
    ],
    structuredContent: { title: "before" },
    isError: false,
    _meta: { private: "metadata" },
  };
  let output = JSON.stringify({
    texts: ["after"],
    structuredContent: { title: "after" },
  });
  const rewrite = new ModelRewriter(
    {
      decide: async () => {
        throw Error("Unexpected decision");
      },
    },
    new (class extends SingleCallLlm {
      async text(_model: string, _instruction: string, input: unknown) {
        assert.deepEqual(input, {
          texts: ["before"],
          structuredContent: { title: "before" },
        });
        return JSON.stringify({
          response: output,
          rationale: "Updated both copies.",
        });
      }
    })(),
  ).forSession();
  const apply = () =>
    rewrite(
      [{ ...rule, target: mcp, llmEdit }],
      { target: mcp, args: {} },
      response,
    );
  assert.deepEqual((await apply()).value, {
    ...response,
    content: [{ type: "text", text: "after" }, response.content[1]],
    structuredContent: { title: "after" },
  });
  output = '{"texts":[]}';
  const failure = await apply();
  assert.equal(failure.value, response);
  assert.ok(failure.error);
});
