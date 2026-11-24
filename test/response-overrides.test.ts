import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HarnessInput } from "../src/harnesses/domain/harness.js";
import { externalCommand } from "../src/harnesses/infrastructure/external-command.js";
import { connectMcpTools } from "../src/harnesses/infrastructure/pi/mcp-tools.js";
import { createSession } from "../src/harnesses/infrastructure/pi/runtime.js";
import { webTool } from "../src/harnesses/infrastructure/pi/web.js";
import {
  type ResponseCapture,
  type ResponseRule,
  rewriteResponse,
  ruleSchema,
} from "../src/overrides/domain/response-override.js";
import {
  editFromSample,
  literalEdit,
  maxFindLength,
} from "../src/overrides/domain/sample-edit.js";
import {
  shellCallTarget,
  shellCommands,
} from "../src/overrides/domain/shell-commands.js";
import { deliverResponse } from "../src/overrides/infrastructure/deliver.js";
import { prepareResponseTools } from "../src/overrides/infrastructure/native-tools.js";
import { DefaultWorkspaceRuntimeFactory } from "../src/sessions/infrastructure/workspace-runtime-factory.js";
import { fixture } from "./fixture.js";

const webRule: ResponseRule = {
  id: crypto.randomUUID(),
  target: { kind: "web" },
  mode: "regex",
  find: "install (old)",
  replacement: "use new ($1)",
  inputContains: "",
  outputContains: "App Router",
  path: "",
};
const id = crypto.randomUUID();
const mcpRule: ResponseRule = {
  ...webRule,
  id: crypto.randomUUID(),
  target: { kind: "mcp", serverId: id, tool: "read_doc" },
  find: "doc",
  replacement: "edited",
  outputContains: "",
  mode: "text",
};
const shellRule: ResponseRule = {
  ...mcpRule,
  id: crypto.randomUUID(),
  target: { kind: "shell", match: "command", command: "printf original" },
  find: "original",
  replacement: "modified",
};

test("shell rules match complete commands inside batches and keep quoted text and here-documents intact", async () => {
  const cmd = "grep posthog package.json";
  const batch = `npm install posthog-js 2>&1 | tail -5; ${cmd}`;
  const call = (command: string) => ({
    target: { kind: "shell", match: "batch", command } as const,
    args: { command },
  });
  const rule: ResponseRule = {
    ...shellRule,
    target: { kind: "shell", match: "command", command: cmd },
  };
  const apply = async (input: string, saved = rule) =>
    (await rewriteResponse([saved], call(input), "original")).value;
  assert.deepEqual(shellCommands(batch), [
    "npm install posthog-js",
    "tail -5",
    cmd,
  ]);
  assert.equal(await apply(`pwd && ${cmd} | cat`), "modified");
  assert.equal(await apply(cmd), "modified");
  assert.equal(await apply(`${cmd}.bak`), "original");
  assert.equal(await apply(`${cmd} >& output.txt`), "original");
  assert.equal(await apply(`echo '${cmd}'; echo "a|b"`), "original");
  const heredoc = `cat <<'EOF'\n${cmd}\nEOF\necho 'a;b'`;
  assert.deepEqual(shellCommands(heredoc), ["cat <<'EOF'", "echo 'a;b'"]);
  assert.equal(await apply(heredoc), "original");
  assert.deepEqual(
    shellCallTarget("command_execution", {
      command: `/bin/zsh -lc '${batch}'`,
    }),
    call(batch).target,
  );
  assert.deepEqual(shellCommands('echo "incomplete'), []);
  assert.equal(
    await apply(batch, { ...rule, target: call(batch).target }),
    "modified",
  );
  assert.equal(
    await apply(cmd, { ...rule, target: call(batch).target }),
    "original",
  );
});

test("rules match call and output independently, preserve structured results, and bound regex replacement", async () => {
  const call = {
    target: { kind: "web" as const, url: "https://example.com/" },
    args: { url: "https://example.com/" },
  };
  const original = "App Router: install old";
  assert.equal(
    (await rewriteResponse([webRule], call, original)).value,
    "App Router: use new (old)",
  );
  assert.equal(
    (
      await rewriteResponse(
        [{ ...webRule, inputContains: "other" }],
        call,
        original,
      )
    ).ruleId,
    undefined,
  );
  assert.equal(
    (
      await rewriteResponse(
        [
          {
            ...webRule,
            target: { kind: "web", url: "https://other.example/" },
          },
        ],
        call,
        original,
      )
    ).value,
    original,
  );
  assert.equal(
    (await rewriteResponse([webRule], call, "install old")).ruleId,
    undefined,
  );
  assert.equal(
    (
      await rewriteResponse(
        [{ ...webRule, replacement: "install old" }, webRule],
        call,
        original,
      )
    ).ruleId,
    webRule.id,
  );
  const result = {
    isError: true,
    structuredContent: { title: "doc", rest: 3 },
    content: [
      { type: "text", text: '{"title":"doc","rest":3}' },
      { type: "image", data: "doc" },
    ],
  };
  const updated = await rewriteResponse(
    [{ ...mcpRule, path: "/title" }],
    { target: mcpRule.target, args: {} },
    result,
  );
  assert.deepEqual(updated.value, {
    ...result,
    structuredContent: { title: "edited", rest: 3 },
    content: [
      { type: "text", text: '{"title":"edited","rest":3}' },
      result.content[1],
    ],
  });
  assert.equal(result.structuredContent.title, "doc");
  assert.equal(ruleSchema.safeParse({ ...webRule, find: "(" }).success, false);
  const bounded = await rewriteResponse(
    [
      {
        ...webRule,
        outputContains: "",
        find: "x",
        replacement: "y".repeat(16000),
      },
    ],
    call,
    "x".repeat(50),
  );
  assert.ok(bounded.error);
  assert.equal(bounded.value, "x".repeat(50));
});

test("a modified result remains available when the captured input exceeds the size limit", async () => {
  const call = { target: mcpRule.target, args: { query: "x".repeat(32001) } };
  const captures: ResponseCapture[] = [];
  const record = async (capture: ResponseCapture) => {
    captures.push(capture);
  };
  await deliverResponse([mcpRule], call, "doc", "first", "pi", record);
  await deliverResponse([mcpRule], call, "other", "second", "pi", record);
  assert.deepEqual(captures, [
    {
      target: mcpRule.target,
      args: {},
      inputOmitted: true,
      original: "doc",
      delivered: "edited",
      ruleId: mcpRule.id,
      callId: "first",
      route: "pi",
    },
  ]);
});

for (const docker of [false, true])
  test(
    `Pi and native harness configurations deliver web, MCP, and shell edits in ${docker ? "Docker" : "local workspaces"}`,
    { timeout: 60000, skip: docker && !process.env.STUNTHOG_DOCKER_TEST },
    async () => {
      const f = await fixture();
      const previousData = process.env.STUNTHOG_DATA_DIR;
      process.env.STUNTHOG_DATA_DIR = join(f.root, "data");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("App Router: install old"),
      });
      const snapshots: ResponseCapture[] = [];
      const url = server.url.href;
      const dir = join(f.root, "agent");
      await mkdir(dir);
      const runtime = await new DefaultWorkspaceRuntimeFactory().create(
        docker
          ? {
              title: "test",
              workspacePath: null,
              repositoryUrl: null,
              executionMode: "docker",
              dockerfilePath: null,
              dockerfileContent: "FROM node:22-bookworm-slim",
            }
          : null,
        f.root,
        f.workspace,
        new AbortController().signal,
        "pi",
      );
      const file = join(f.workspace, "fixture.mjs");
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "fake-mcp-server.ts")],
        target: "node",
        format: "esm",
      });
      assert.ok(build.success && build.outputs[0]);
      await Bun.write(file, build.outputs[0]);
      let nativeUrl = url;
      const model = {
        model: "test",
        harness: "pi" as const,
        effort: "low" as const,
        timeoutSeconds: 30,
        maxTurns: 3,
        count: 1,
      };
      const input: HarnessInput = {
        label: crypto.randomUUID(),
        runtime,
        workspace: f.workspace,
        directory: dir,
        settings: model,
        skills: [],
        prompt: "test",
        model: "test",
        effort: "low",
        tools: ["web_fetch"],
        timeout: 30,
        maxTurns: 3,
        signal: new AbortController().signal,
        mcps: [
          {
            id,
            title: "Docs",
            command: "node",
            arguments: [runtime.filePath?.(file) ?? file],
          },
        ],
        responseOverrides: [
          {
            ...webRule,
            decision: { prompt: "Is this an installation guide?" },
          },
          {
            ...mcpRule,
            decision: { prompt: "Is this a document?" },
          },
          {
            ...shellRule,
            decision: { prompt: "Does this print the original text?" },
          },
        ],
        rewrite: (rules, call, original) =>
          rewriteResponse(rules, call, original, {
            decide: async () => ({ model: "fixture", probability: 0.98 }),
          }),
        onToolResponse: async (capture) => {
          snapshots.push(capture);
        },
        onRawEvent: async () => {},
      };
      try {
        const batch =
          "printf once >> calls.txt; printf original; printf ' output'";
        const session = await createSession({
          ...input,
          model: "anthropic/claude-sonnet-4.5",
          mcps: [],
          tools: ["bash"],
        });
        try {
          const bash = session.state.tools.find((tool) => tool.name === "bash");
          assert.ok(bash);
          const result = await bash.execute(
            "pi-bash",
            { command: batch },
            input.signal,
          );
          assert.deepEqual(result.content, [
            { type: "text", text: "modified output" },
          ]);
          assert.equal(
            await readFile(join(f.workspace, "calls.txt"), "utf8"),
            "once",
          );
          assert.equal(snapshots[0]?.original, "original output");
          assert.equal(snapshots[0]?.delivered, "modified output");
        } finally {
          session.dispose();
          await session.closeMcp();
        }
        const web = await webTool(input).execute(
          "pi-web",
          { url },
          input.signal,
          undefined,
          {} as never,
        );
        assert.match(JSON.stringify(web.content), /use new \(old\)/);
        const pi = await connectMcpTools(input);
        try {
          const tool = pi.tools.find((tool) => tool.label === "Docs: read_doc");
          assert.ok(tool);
          const result = await tool.execute(
            "pi-mcp",
            {},
            input.signal,
            undefined,
            {} as never,
          );
          assert.match(JSON.stringify(result.content), /edited/);
        } finally {
          await pi.close();
        }
        if (docker) {
          const httpServer = await runtime.process(
            {
              binary: "node",
              args: [
                "-e",
                "require('node:http').createServer((req,res)=>res.end('App Router: install old')).listen(19112,'127.0.0.1')",
              ],
              env: {},
            },
            f.workspace,
          );
          const started = Bun.spawnSync([
            httpServer.binary,
            ...httpServer.args.map((x) =>
              x === "--interactive" ? "--detach" : x,
            ),
          ]);
          assert.equal(started.exitCode, 0, started.stderr.toString());
          nativeUrl = "http://127.0.0.1:19112/";
        }
        for (const harness of ["claude", "codex", "opencode"] as const) {
          const countBeforeRun = snapshots.length;
          const prepared = await prepareResponseTools({
            ...input,
            settings: { ...input.settings, harness },
          });
          try {
            const command = await externalCommand(
              harness,
              prepared.input,
              prepared.shellHook,
            );
            assert.ok(prepared.shellHook);
            let hookArgs: string[];
            let event = "";
            if (harness === "opencode") {
              const config = JSON.parse(
                command.env.OPENCODE_CONFIG_CONTENT ?? "",
              );
              const [url] = config[docker ? "plugin" : "plugins"];
              hookArgs = [
                "--input-type=module",
                "-e",
                docker
                  ? `const {default: plugin} = await import(process.argv[1]);
                     const hooks = await plugin();
                     const result = {output: "original output"};
                     const input = {tool: "bash", callID: "opencode-id", args: {command: process.argv[2]}};
                     await hooks["tool.execute.after"](input, result);
                     console.log(result.output);`
                  : `const {default: plugin} = await import(process.argv[1] + "/server.js");
                     const result = {output: {output: "original output"}, content: [{type: "text", text: "original output"}]};
                     const call = {tool: "shell", id: "opencode-id", status: "completed", input: {command: process.argv[2]}, result};
                     await plugin.setup({tool: {hook: (_, after) => after(call)}});
                     console.log(result.content[0].text);`,
                url,
                batch,
              ];
            } else {
              const hook =
                harness === "claude"
                  ? JSON.parse(
                      command.args[command.args.indexOf("--settings") + 1] ??
                        "",
                    ).hooks.PostToolUse[0].hooks[0].command
                  : prepared.shellHook;
              const code = /^node -e "(.+)"$/.exec(hook)?.[1];
              assert.ok(code);
              if (harness === "codex") {
                assert.ok(
                  command.args.some((arg) =>
                    arg.startsWith("hooks.PostToolUse="),
                  ),
                );
                assert.ok(
                  command.args.some((arg) => arg.startsWith("hooks.state=")),
                );
              }
              hookArgs = ["-e", code];
              event = JSON.stringify({
                tool_name: "Bash",
                tool_use_id: `${harness}-id`,
                tool_input: { command: batch },
                tool_response:
                  harness === "claude"
                    ? { stdout: "original output", stderr: "" }
                    : "original output",
              });
            }
            const hookProcess = await runtime.process(
              { binary: "node", args: hookArgs, env: {} },
              f.workspace,
            );
            const hookRun = Bun.spawn(
              [hookProcess.binary, ...hookProcess.args],
              {
                cwd: f.workspace,
                stdin: Buffer.from(event),
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            const [exitCode, stdout, stderr] = await Promise.all([
              hookRun.exited,
              new Response(hookRun.stdout).text(),
              new Response(hookRun.stderr).text(),
            ]);
            assert.equal(exitCode, 0, stderr);
            assert.match(stdout, /modified output/);
            let commands: string[][];
            if (harness === "claude") {
              const config = JSON.parse(
                await readFile(
                  command.args[
                    command.args.indexOf("--mcp-config") + 1
                  ] as string,
                  "utf8",
                ),
              );
              commands = Object.values(config.mcpServers).map((value) => {
                const s = value as { command: string; args: string[] };
                return [s.command, ...s.args];
              });
            } else if (harness === "codex") {
              commands = [0, 1].map((i) => {
                const field = (key: string) =>
                  JSON.parse(
                    command.args
                      .find((s) =>
                        s.startsWith(`mcp_servers.eval_${i}.${key}=`),
                      )
                      ?.split("=")
                      .slice(1)
                      .join("=") ?? "null",
                  );
                return [field("command"), ...field("args")];
              });
            } else
              commands = Object.values(
                JSON.parse(command.env.OPENCODE_CONFIG_CONTENT ?? "").mcp,
              ).map((value) => (value as { command: string[] }).command);
            for (const [index, argv] of commands.entries()) {
              const client = new Client({
                name: "controlled-agent",
                version: "1",
              });
              try {
                assert.ok(argv[0]);
                const launch = await runtime.process(
                  { binary: argv[0], args: argv.slice(1), env: {} },
                  f.workspace,
                );
                await client.connect(
                  new StdioClientTransport({
                    command: launch.binary,
                    args: launch.args,
                    stderr: "pipe",
                    cwd: f.workspace,
                  }),
                );
                const name = index ? "web_fetch" : "read_doc";
                assert.ok(
                  (await client.listTools()).tools.some((t) => t.name === name),
                );
                const reply = await client.callTool({
                  name,
                  arguments: index ? { url: nativeUrl } : {},
                });
                assert.match(
                  JSON.stringify(reply.content),
                  index ? /use new \(old\)/ : /edited/,
                );
              } finally {
                await client.close();
              }
            }
            // The session page polls while the native agent is still running.
            for (
              let i = 0;
              i < 60 && snapshots.length < countBeforeRun + 3;
              i++
            )
              await Bun.sleep(50);
            assert.equal(snapshots.length, countBeforeRun + 3);
            assert.equal(
              snapshots.find((c) => c.callId === `${harness}-id`)?.original,
              "original output",
            );
          } finally {
            await prepared.finish();
          }
        }
        assert.equal(snapshots.length, 12);

        const shells = snapshots.filter((c) => c.target.kind === "shell");
        assert.equal(shells.length, 4);
        assert.ok(shells.every((c) => c.decisions?.[0]?.probability === 0.98));
        assert.ok(
          snapshots.every(
            (c) => c.ruleId && c.delivered && c.original !== c.delivered,
          ),
        );
      } finally {
        if (previousData === undefined) delete process.env.STUNTHOG_DATA_DIR;
        else process.env.STUNTHOG_DATA_DIR = previousData;
        server.stop(true);
        await runtime.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

test("sample defaults match a single editable MCP field and respect the maximum pattern length", async () => {
  const target = {
    kind: "mcp",
    serverId: crypto.randomUUID(),
    tool: "docs",
  } as const;
  const content = [
    { type: "text", text: "one block" },
    { type: "text", text: "another block" },
  ];
  assert.equal(editFromSample({ content }, target).find, "one block");
  assert.equal(
    editFromSample({ content }, target, "another").replacement,
    "another",
  );
  const original = {
    content: [],
    structuredContent: { "a/b": { "~path": "hello" } },
  };
  const defaults = editFromSample(original, target);
  assert.deepEqual(defaults, {
    find: "hello",
    replacement: "hello",
    path: "/a~1b/~0path",
  });
  const rule = ruleSchema.parse({
    ...webRule,
    ...defaults,
    target,
    mode: "text",
    replacement: "updated",
    inputContains: "",
    outputContains: "",
  });
  assert.equal(
    (await rewriteResponse([rule], { target, args: {} }, original)).ruleId,
    rule.id,
  );
  const longText = `${"a".repeat(maxFindLength - 1)}😀extra`;
  assert.equal(editFromSample(longText).find, "a".repeat(maxFindLength - 1));
  assert.equal(
    editFromSample({ content: [{ type: "image", data: "example" }] }, target)
      .find,
    "",
  );
});

test("direct edits reproduce insertions, deletions and changes deep in a long or repetitive response", async () => {
  const page = "setup instructions\n".repeat(400);
  for (const [before, after] of [
    [`${page}npm i sdk\n`, `${page}bun add sdk\n`],
    ["same\nsame\nsame", "same\nnew\nsame"],
    ["hello", "👋hello"],
    ["👋", ""],
    ["a😀b", "a😎b"],
    ["a\r\n", "a\r\nend"],
    ["a\n\nb", "a\nx\nb"],
  ] as const) {
    const edit = literalEdit(before, after);
    assert.ok(edit);
    const rule = ruleSchema.parse({
      ...webRule,
      ...edit,
      mode: "text",
      inputContains: "",
      outputContains: "",
    });
    assert.equal(
      (await rewriteResponse([rule], { target: rule.target, args: {} }, before))
        .value,
      after,
    );
  }
  assert.equal(literalEdit("a".repeat(3000), "b"), undefined);
});
