import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { McpServer } from "../../harnesses/domain/execution.js";
import type { HarnessInput } from "../../harnesses/domain/harness.js";
import { resolveDataDirectory } from "../../infrastructure/data-directory.js";
import {
  decisionEvidenceSchema,
  rewriteResponse,
  targetSchema,
} from "../domain/response-override.js";
import { publish, relayTimeoutMs, requestSchema } from "./model-exchange.js";
import { relaySource } from "./relay-source.js";

const captureSchema = z.object({
  callId: z.string().min(1).max(512),
  route: z.string(),
  target: targetSchema,
  args: z.record(z.unknown()),
  original: z.unknown(),
  delivered: z.unknown().optional(),
  inputOmitted: z.boolean().optional(),
  decisions: z.array(decisionEvidenceSchema).max(40).optional(),
  ruleId: z.string().uuid().optional(),
  error: z.string().optional(),
});
export async function prepareResponseTools(input: HarnessInput) {
  const rules = input.responseOverrides ?? [];
  const web = rules.some((rule) => rule.target.kind === "web");
  const shell = rules.filter((rule) => rule.target.kind === "shell");
  if (input.label === "judge" || !rules.length)
    return { input, shellHook: undefined, finish: async () => {} };
  // Keep local hook executables outside the shell workspace and its writable temp directory.
  const parent =
    shell.length && input.runtime?.kind !== "docker"
      ? resolveDataDirectory()
      : dirname(input.directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, "response-tools-"));
  const canonical = await realpath(directory);
  const helper = join(directory, "relay.cjs");
  try {
    await writeFile(helper, await relaySource(), { mode: 0o600 });
    let shellHook: string | undefined;
    if (shell.length) {
      const runtimePath = (file: string) =>
        input.runtime?.filePath?.(file) ?? file;
      const config = join(directory, "shell.json");
      await writeFile(config, JSON.stringify(shell), { mode: 0o600 });
      if (input.settings.harness === "opencode") {
        const docker = input.runtime?.kind === "docker";
        const plugin = join(directory, docker ? "shell.mjs" : "server.js");
        const spec = JSON.stringify(runtimePath(config));
        await writeFile(
          plugin,
          docker
            ? `import relay from "./relay.cjs";\nexport default relay.openCodeShellPlugin(${spec});\n`
            : `module.exports = require("./relay.cjs").openCodeShellPluginV2(${spec});\n`,
          { mode: 0o600 },
        );
        // OpenCode v1 loads a module URL. V2 resolves server.js from a plugin directory.
        shellHook = pathToFileURL(runtimePath(docker ? plugin : directory), {
          windows: !docker && process.platform === "win32",
        }).href;
      } else {
        const encoded = (file: string) =>
          `Buffer.from('${Buffer.from(runtimePath(file)).toString("base64")}','base64').toString()`;
        // All command arguments come from the application. Rule text stays in the data file.
        shellHook = `node -e "require(${encoded(helper)}).runShellHook(${encoded(config)},'${input.settings.harness}').catch(()=>{process.exitCode=1})"`;
      }
    }
    const servers: McpServer[] = [];
    async function add(server?: McpServer) {
      const index = servers.length;
      const path = join(directory, `${index}.json`);
      const tokenVariable = `STUNTHOG_MCP_TOKEN_${index}`;
      await writeFile(
        path,
        JSON.stringify({
          rules,
          ...(server && {
            server: {
              id: server.id,
              command: server.command,
              arguments: server.arguments,
              url: server.url,
              tokenVariable,
            },
          }),
        }),
        { mode: 0o600 },
      );
      servers.push({
        title: server?.title ?? "Web pages",
        command: "node",
        required: true,
        ...(server?.allowedTools && { allowedTools: server.allowedTools }),
        arguments: [
          input.runtime?.filePath?.(helper) ?? helper,
          input.runtime?.filePath?.(path) ?? path,
        ],
        ...(server?.accessToken && { accessToken: server.accessToken }),
      });
    }
    for (const server of input.mcps ?? []) {
      if (
        server.id &&
        rules.some(
          (rule) =>
            rule.target.kind === "mcp" && rule.target.serverId === server.id,
        )
      )
        await add(server);
      else servers.push(server);
    }
    if (web) await add();
    const processed = new Set<string>();
    const modelRules = rules.some((rule) => rule.decision);
    const pending = new Map<string, Promise<void>>();
    async function answer(name: string) {
      const path = join(directory, name);
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        const timeLeft =
          relayTimeoutMs - Math.max(0, Math.ceil(Date.now() - stat.mtimeMs));
        if (!stat.isFile() || stat.size > 1_536_000 || timeLeft <= 0) return;
        const { target, args, original } = requestSchema.parse(
          JSON.parse(await handle.readFile("utf8")),
        );
        // Only the host's session snapshot can select providers, instructions, or models.
        const call = { target, args };
        const result = input.rewrite
          ? await input.rewrite(
              rules,
              call,
              original,
              AbortSignal.timeout(timeLeft),
            )
          : await rewriteResponse(rules, call, original);
        if ((await realpath(directory)) === canonical)
          await publish(
            path.replace(/\.request$/, ".reply"),
            JSON.stringify(result),
          );
      } finally {
        await handle.close();
      }
    }
    async function drain() {
      if ((await realpath(directory)) !== canonical)
        throw new Error("Invalid response tool directory.");
      for (const file of await readdir(directory, {
        withFileTypes: true,
      })) {
        if (
          modelRules &&
          file.isFile() &&
          /^[a-f0-9-]{36}\.request$/.test(file.name)
        ) {
          if (
            !processed.has(file.name) &&
            pending.size < 4 &&
            !input.signal.aborted
          ) {
            processed.add(file.name);
            pending.set(
              file.name,
              answer(file.name)
                .catch(() => {})
                .finally(() => pending.delete(file.name)),
            );
          }
          continue;
        }
        if (
          processed.has(file.name) ||
          !file.isFile() ||
          !/^[a-f0-9-]{36}\.response$/.test(file.name)
        )
          continue;
        const handle = await open(
          join(directory, file.name),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 4_000_000) continue;
          const capture = captureSchema.parse(
            JSON.parse(await handle.readFile("utf8")),
          );
          await input.onToolResponse?.({
            ...capture,
            original: capture.original,
          });
          processed.add(file.name);
        } finally {
          await handle.close();
        }
      }
    }

    // A relay atomically renames each completed response. Only one reader drains the directory at a time.
    let reading: Promise<void> | undefined;
    const timer = setInterval(
      () => {
        reading ??= drain()
          .catch(() => {
            // Leave unread captures for the next pass. The final drain reports persistent errors.
          })
          .finally(() => {
            reading = undefined;
          });
      },
      modelRules ? 100 : 750,
    );
    timer.unref();
    return {
      input: { ...input, mcps: servers },
      shellHook,
      finish: async () => {
        clearInterval(timer);
        try {
          await reading;
          await drain();
          await Promise.all(pending.values());
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
