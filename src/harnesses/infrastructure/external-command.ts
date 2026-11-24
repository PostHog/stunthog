import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessCommand } from "../domain/execution.js";
import type { HarnessInput } from "../domain/harness.js";

export async function externalCommand(
  id: "codex" | "claude" | "opencode",
  input: HarnessInput,
  shellHook?: string,
): Promise<ProcessCommand> {
  const managedWeb = input.responseOverrides?.some(
    (rule) => rule.target.kind === "web",
  );
  const hookTimeout = input.responseOverrides?.some(
    (r) => r.target.kind === "shell" && (r.decision || r.llmEdit),
  )
    ? 50
    : 10;
  const model = input.settings.model;
  const effort = input.settings.effort;
  const env = input.runtime?.kind === "docker" ? {} : { ...process.env };

  for (const key of [
    "TYPESAFE_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
  ])
    delete env[key];

  // Only Claude Code can limit which MCP tools are callable. Never ignore a tool limit silently.
  if (id !== "claude" && input.mcps?.some((server) => server.allowedTools))
    throw new Error(`The ${id} harness cannot limit MCP tools.`);

  const tokenVariable = (index: number) => `STUNTHOG_MCP_TOKEN_${index}`;
  for (const [index, server] of (input.mcps ?? []).entries()) {
    if (server.accessToken) env[tokenVariable(index)] = server.accessToken;
  }

  if (id === "codex") {
    // Codex accepts a per-run key without redefining its reserved OpenAI provider.
    env.CODEX_API_KEY = input.apiKey;

    // With approval_policy="never", Codex rejects MCP calls unless each configured server pre-approves its tools.
    const mcpArgs = (input.mcps ?? []).flatMap((server, index) => [
      ...(server.required
        ? ["-c", `mcp_servers.eval_${index}.required=true`]
        : []),
      ...(server.url
        ? ["-c", `mcp_servers.eval_${index}.url=${JSON.stringify(server.url)}`]
        : [
            "-c",
            `mcp_servers.eval_${index}.command=${JSON.stringify(server.command)}`,
            "-c",
            `mcp_servers.eval_${index}.args=${JSON.stringify(server.arguments)}`,
          ]),
      ...(server.accessToken && !server.url
        ? [
            "-c",
            `mcp_servers.eval_${index}.env_vars=[${JSON.stringify(tokenVariable(index))}]`,
          ]
        : []),
      ...(server.accessToken && server.url
        ? [
            "-c",
            `mcp_servers.eval_${index}.bearer_token_env_var=${JSON.stringify(tokenVariable(index))}`,
          ]
        : []),
      "-c",
      `mcp_servers.eval_${index}.default_tools_approval_mode="approve"`,
    ]);

    return {
      binary: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        input.runtime?.kind === "docker"
          ? "danger-full-access"
          : input.tools.length
            ? "workspace-write"
            : "read-only",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        'approval_policy="never"',
        "-c",
        'model_provider="openai"',
        "-c",
        `model_reasoning_effort=${JSON.stringify(effort === "off" || effort === "minimal" ? "low" : effort)}`,
        "--model",
        model,
        ...mcpArgs,
        ...(shellHook
          ? codexShellHook(
              shellHook,
              hookTimeout,
              input.runtime?.kind !== "docker" && process.platform === "win32",
            )
          : []),
        "-",
      ],
      env,
    };
  }

  if (id === "claude") {
    env.ANTHROPIC_API_KEY = input.apiKey;
    // Bare mode skips every hook. Load only our settings and keep this run's Claude state isolated.
    if (shellHook) {
      const state = join(input.directory, "claude-state");
      env.CLAUDE_CONFIG_DIR = input.runtime?.filePath?.(state) ?? state;
    }

    const path = join(input.directory, "mcp-config.json");

    await writeFile(
      path,
      JSON.stringify({
        mcpServers: Object.fromEntries(
          (input.mcps ?? []).map((server, index) => [
            `eval_${index}`,
            server.url
              ? {
                  type: "http",
                  url: server.url,
                  ...(server.accessToken && {
                    headers: {
                      Authorization: `Bearer \${${tokenVariable(index)}}`,
                    },
                  }),
                }
              : {
                  command: server.command,
                  args: server.arguments,
                  ...(server.accessToken && {
                    env: {
                      [tokenVariable(index)]: `\${${tokenVariable(index)}}`,
                    },
                  }),
                },
          ]),
        ),
      }),
    );

    return {
      binary: "claude",
      args: [
        "--print",
        ...(shellHook
          ? [
              "--setting-sources",
              "",
              "--settings",
              JSON.stringify({
                hooks: {
                  PostToolUse: [
                    {
                      matcher: "^Bash$",
                      hooks: [
                        {
                          type: "command",
                          command: shellHook,
                          timeout: hookTimeout,
                        },
                      ],
                    },
                  ],
                },
              }),
            ]
          : ["--bare"]),
        "--verbose",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--effort",
        effort === "off" || effort === "minimal" ? "low" : effort,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        [
          "Bash",
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          ...(managedWeb ? [] : ["WebFetch"]),
          "WebSearch",
          ...(input.mcps ?? []).flatMap((server, index) =>
            server.allowedTools
              ? server.allowedTools.map(
                  (tool) => `mcp__eval_${index}__${claudeToolName(tool)}`,
                )
              : [`mcp__eval_${index}__*`],
          ),
        ].join(","),
        ...(input.tools.length ? [] : ["--tools", ""]),
        ...(managedWeb ? ["--disallowedTools", "WebFetch"] : []),
        "--strict-mcp-config",
        "--mcp-config",
        path,
      ],
      env,
    };
  }

  env.OPENROUTER_API_KEY = input.apiKey;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...(shellHook && {
      [input.runtime?.kind === "docker" ? "plugin" : "plugins"]: [shellHook],
    }),
    provider: { openrouter: { options: { apiKey: input.apiKey } } },
    mcp: Object.fromEntries(
      (input.mcps ?? []).map((server, index) => [
        `eval_${index}`,
        server.url
          ? {
              type: "remote",
              url: server.url,
              oauth: false,
              ...(server.accessToken && {
                headers: {
                  Authorization: `Bearer {env:${tokenVariable(index)}}`,
                },
              }),
            }
          : {
              type: "local",
              command: [server.command, ...server.arguments],
              ...(server.accessToken && {
                environment: {
                  [tokenVariable(index)]: `{env:${tokenVariable(index)}}`,
                },
              }),
            },
      ]),
    ),
    permission: input.tools.length
      ? managedWeb
        ? { "*": "allow", webfetch: "deny" }
        : "allow"
      : "deny",
  });

  // Docker installs the published v1 CLI; local runs use v2's private server.
  const docker = input.runtime?.kind === "docker";

  return {
    binary: "opencode",
    args: [
      "run",
      ...(docker ? [] : ["--standalone"]),
      "--format",
      "json",
      "--model",
      docker ? model : `${model}${effort === "off" ? "" : `#${effort}`}`,
      ...(docker && effort !== "off" ? ["--variant", effort] : []),
    ],
    env,
  };
}

function codexShellHook(
  command: string,
  hookTimeout: number,
  windows: boolean,
) {
  const matcher = "^Bash$";
  // Codex fingerprints the normalized declaration. Trust only this session's generated command.
  const identity = {
    event_name: "post_tool_use",
    hooks: [{ async: false, command, timeout: hookTimeout, type: "command" }],
    matcher,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const source = windows
    ? "C:\\<session-flags>\\config.toml"
    : "/<session-flags>/config.toml";
  const key = JSON.stringify(`${source}:post_tool_use:0:0`);
  return [
    "-c",
    `hooks.PostToolUse=[{matcher="${matcher}",hooks=[{type="command",command=${JSON.stringify(command)},timeout=${hookTimeout}}]}]`,
    "-c",
    `hooks.state={${key}={trusted_hash="sha256:${hash}"}}`,
  ];
}

// Claude Code replaces characters outside letters, digits, underscores, and hyphens in MCP tool names.
function claudeToolName(tool: string): string {
  return tool.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}
