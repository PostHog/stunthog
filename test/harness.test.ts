import assert from "node:assert/strict";
import { readFile, realpath, rm } from "node:fs/promises";
import { test } from "node:test";
import { ModelSettings } from "../src/evaluations/domain/model-settings.js";
import type { HarnessInput } from "../src/harnesses/domain/harness.js";
import { externalCommand } from "../src/harnesses/infrastructure/external-command.js";
import { summarizeEvents } from "../src/harnesses/infrastructure/external-events.js";
import { ExternalHarness } from "../src/harnesses/infrastructure/external-harness.js";
import { runProcess } from "../src/harnesses/infrastructure/process-runner.js";
import { fixture } from "./fixture.js";

test("native adapters keep credentials out of arguments and disable judge tools", async () => {
  const f = await fixture();

  try {
    const input: HarnessInput = {
      label: "judge",
      directory: f.root,
      workspace: f.workspace,
      skills: [],
      prompt: "Test",
      model: "test",
      effort: "low",
      tools: [],
      timeout: 10,
      maxTurns: 2,
      apiKey: "secret-key",
      mcps: [
        {
          title: "Remote",
          url: "https://example.com/mcp",
          command: "",
          arguments: [],
          accessToken: "secret-mcp-token",
        },
      ],
      signal: new AbortController().signal,
      settings: { ...ModelSettings.create({ model: "test" }).value },
      onRawEvent: async () => {},
    };

    for (const id of ["codex", "claude", "opencode"] as const) {
      const command = await externalCommand(id, input);

      assert.doesNotMatch(
        JSON.stringify(command.args),
        /secret-key|secret-mcp-token/,
      );
      assert.equal(command.env.STUNTHOG_MCP_TOKEN_0, "secret-mcp-token");

      if (id === "claude") {
        const configPath =
          command.args[command.args.indexOf("--mcp-config") + 1];
        assert.ok(configPath);
        const config = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(config.mcpServers.eval_0, {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: `Bearer \${STUNTHOG_MCP_TOKEN_0}` },
        });
      }

      if (id === "codex") {
        for (const [index, arg] of command.args.entries()) {
          if (arg === "-c")
            assert.match(command.args[index + 1] ?? "", /^[\w.]+=/);
        }
        assert.ok(command.args.includes("read-only"));
        assert.equal(command.env.CODEX_API_KEY, "secret-key");
        assert.equal(command.env.OPENAI_API_KEY, undefined);
        assert.ok(
          !command.args.some((argument) =>
            argument.startsWith("model_providers.openai."),
          ),
        );
      }
      if (id === "claude")
        assert.equal(command.args[command.args.indexOf("--tools") + 1], "");
      if (id === "opencode") {
        assert.ok(command.args.includes("--standalone"));

        assert.equal(
          JSON.parse(command.env.OPENCODE_CONFIG_CONTENT ?? "{}").permission,
          "deny",
        );

        for (const effort of ["low", "off"] as const) {
          const dockerCommand = await externalCommand(id, {
            ...input,
            settings: { ...input.settings, effort },
            runtime: {
              kind: "docker",
              process: async (value) => value,
              shell: async () => ({ exitCode: 0 }),
              close: async () => {},
            },
          });

          assert.deepEqual(dockerCommand.args, [
            "run",
            "--format",
            "json",
            "--model",
            "test",
            ...(effort === "off" ? [] : ["--variant", "low"]),
          ]);
          assert.equal(
            JSON.parse(dockerCommand.env.OPENCODE_CONFIG_CONTENT ?? "{}")
              .permission,
            "deny",
          );
        }
      }
    }

    const events: unknown[] = [];

    await runProcess(
      {
        binary: process.execPath,
        args: [
          "-e",
          'console.log(JSON.stringify({type:"result",result:process.env.PWD,cwd:process.cwd()}))',
        ],
        env: { ...process.env, PWD: f.root },
      },
      {
        ...input,
        onRawEvent: async (event) => {
          events.push(event);
        },
      },
    );

    assert.equal(summarizeEvents(events).text, f.workspace);

    const [event] = events as {
      type: string;
      result: string;
      cwd: string;
    }[];

    assert.equal(event?.type, "result");
    assert.equal(event?.result, f.workspace);
    assert.equal(await realpath(event?.cwd ?? ""), await realpath(f.workspace));

    await assert.rejects(
      runProcess(
        {
          binary: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          env: process.env,
        },
        { ...input, signal: AbortSignal.timeout(30) },
      ),
      /abort|timeout/i,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native errors preserve provider messages from structured stdout", () => {
  const message = "Quota exceeded. Check your plan and billing details.";

  assert.equal(summarizeEvents([{ type: "error", message }]).error, message);
  assert.equal(
    summarizeEvents([{ type: "turn.failed", error: { message } }]).error,
    message,
  );
  assert.equal(
    summarizeEvents([{ type: "error", error: { data: { message } } }]).error,
    message,
  );
  assert.equal(
    summarizeEvents([
      { type: "result", is_error: true, result: "Authentication failed" },
    ]).error,
    "Authentication failed",
  );
});

test("Codex relies on the container boundary instead of its nested sandbox", async () => {
  const f = await fixture();

  try {
    const command = await externalCommand("codex", {
      label: "agent",
      directory: f.root,
      workspace: f.workspace,
      skills: [],
      prompt: "Test",
      model: "test",
      effort: "low",
      tools: ["bash"],
      timeout: 10,
      maxTurns: 2,
      apiKey: "secret-key",
      signal: new AbortController().signal,
      settings: { ...ModelSettings.create({ model: "test" }).value },
      onRawEvent: async () => {},
      runtime: {
        kind: "docker",
        process: async (value) => value,
        shell: async () => ({ exitCode: 0 }),
        close: async () => {},
      },
    });

    assert.equal(
      command.args[command.args.indexOf("--sandbox") + 1],
      "danger-full-access",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native usage distinguishes unavailable cost and avoids double-counting Codex cached input", () => {
  const codex = summarizeEvents([
    {
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 },
    },
  ]);

  assert.equal(codex.usage?.total, 110);

  assert.equal(codex.usage?.costUsd, null);

  const claude = summarizeEvents([
    {
      type: "result",
      result: "Done",
      total_cost_usd: 0.03,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      },
    },
  ]);

  assert.equal(claude.usage?.total, 65);

  assert.equal(claude.usage?.costUsd, 0.03);
});

test("a judge with MCP servers keeps built-in tools off and can call only allowed MCP tools", async () => {
  const f = await fixture();

  try {
    const input: HarnessInput = {
      label: "judge",
      directory: f.root,
      workspace: f.workspace,
      skills: [],
      prompt: "Test",
      model: "test",
      effort: "low",
      tools: [],
      timeout: 10,
      maxTurns: 2,
      apiKey: "secret-key",
      signal: new AbortController().signal,
      settings: { ...ModelSettings.create({ model: "test" }).value },
      onRawEvent: async () => {},
      mcps: [
        {
          title: "Docs",
          command: "docs-mcp",
          arguments: ["--stdio"],
          allowedTools: ["search", "docs.get"],
        },
      ],
    };

    const claude = await externalCommand("claude", input);
    const allowed = (
      claude.args[claude.args.indexOf("--allowedTools") + 1] ?? ""
    ).split(",");

    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
    // Claude Code replaces dots in MCP tool names with underscores.
    assert.ok(allowed.includes("mcp__eval_0__search"));
    assert.ok(allowed.includes("mcp__eval_0__docs_get"));
    assert.ok(!allowed.includes("mcp__eval_0__*"));

    // Only the Claude Code judge accepts MCP servers. Codex can still read host files from its sandbox.
    assert.deepEqual(
      (["claude", "codex", "opencode"] as const).map(
        (id) => new ExternalHarness(id, id, "openai").judgeSupportsMcp,
      ),
      [true, false, false],
    );

    // Codex and OpenCode cannot limit MCP tools, so a tool list is rejected rather than ignored.
    for (const id of ["codex", "opencode"] as const)
      await assert.rejects(
        externalCommand(id, input),
        /cannot limit MCP tools/,
      );

    // Agents keep every tool. Claude allows the whole server.
    const agentInput: HarnessInput = {
      ...input,
      label: "agent",
      mcps: [{ title: "Docs", command: "docs-mcp", arguments: ["--stdio"] }],
    };
    const agentClaude = await externalCommand("claude", agentInput);

    assert.match(
      agentClaude.args[agentClaude.args.indexOf("--allowedTools") + 1] ?? "",
      /mcp__eval_0__\*/,
    );

    // Codex rejects MCP calls under approval_policy="never" unless the server pre-approves them.
    const codex = await externalCommand("codex", agentInput);

    assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(codex.args.includes('mcp_servers.eval_0.command="docs-mcp"'));
    assert.ok(
      codex.args.includes(
        'mcp_servers.eval_0.default_tools_approval_mode="approve"',
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
