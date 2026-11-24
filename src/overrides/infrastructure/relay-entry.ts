// This Node entry point runs inside the same runtime as the native harness.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { redactEvent } from "../../harnesses/domain/redact-secrets.js";
import { responseIdKey } from "../../sessions/domain/tool-call.js";
import {
  type ResponseCapture,
  rulesSchema,
  type ToolCall,
} from "../domain/response-override.js";
import { deliverResponse, deliverShellResponse } from "./deliver.js";
import { publish, relayRewrite } from "./model-exchange.js";
import { fetchPage } from "./read-page.js";

function isCredentialVariable(name: string): boolean {
  return (
    /^(?:STUNTHOG|AGENT_EVAL)_MCP_TOKEN_/.test(name) ||
    [
      "TYPESAFE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "CODEX_API_KEY",
    ].includes(name)
  );
}

async function writeCapture(path: string, capture: ResponseCapture) {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => !!value && isCredentialVariable(key))
    .map(([, value]) => value as string);
  const destination = join(dirname(path), randomUUID());
  await publish(
    `${destination}.response`,
    JSON.stringify(redactEvent(capture, secrets)),
  );
}

const nativeCall = z.object({
  tool_name: z.string(),
  tool_use_id: z.string().min(1).max(512),
  tool_input: z.object({ command: z.string().max(64_000) }),
  tool_response: z.unknown(),
});
async function applyShell(
  path: string,
  id: string,
  command: string,
  output: string,
) {
  const rules = rulesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return deliverShellResponse(
    rules,
    command,
    output,
    id,
    (capture) => writeCapture(path, capture),
    relayRewrite(dirname(path)),
  );
}

// Native hooks receive the completed call. No command from the trace runs here.
export async function runShellHook(path: string, harness: "claude" | "codex") {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4_000_000) return;
    chunks.push(chunk);
  }
  const event = nativeCall.safeParse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  if (
    !event.success ||
    !/^(Bash|shell|exec_command|shell_command)$/i.test(event.data.tool_name)
  )
    return;
  const { tool_input, tool_response, tool_use_id } = event.data;
  const fields =
    tool_response && typeof tool_response === "object"
      ? (tool_response as Record<string, unknown>)
      : {};
  if (
    fields.interrupted ||
    fields.isImage ||
    fields.backgroundTaskId ||
    (typeof fields.exit_code === "number" && fields.exit_code !== 0)
  )
    return;
  const text =
    harness === "claude" && typeof fields.stdout === "string"
      ? [fields.stdout, fields.stderr]
          .filter((value) => typeof value === "string" && value)
          .join("\n")
      : typeof tool_response === "string"
        ? tool_response
        : typeof fields.output === "string"
          ? fields.output
          : undefined;
  if (text === undefined) return;
  const value = await applyShell(path, tool_use_id, tool_input.command, text);
  if (value === text) return;
  process.stdout.write(
    JSON.stringify(
      harness === "claude"
        ? {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { ...fields, stdout: value, stderr: "" },
            },
          }
        : { continue: false, stopReason: value },
    ),
  );
}

export function openCodeShellPlugin(path: string) {
  return async () => ({
    "tool.execute.after": async (
      input: { tool: string; callID: string; args: { command?: string } },
      result: { output: string; metadata?: { exit?: number } },
    ) => {
      if (
        /^(bash|shell)$/.test(input.tool) &&
        typeof input.args?.command === "string" &&
        typeof result.output === "string" &&
        (result.metadata?.exit === undefined || result.metadata.exit === 0)
      )
        result.output = await applyShell(
          path,
          input.callID,
          input.args.command,
          result.output,
        );
    },
  });
}
type OpenCodeResult = {
  tool: string;
  id: string;
  input: { command?: string };
  status: string;
  result?: {
    output?: { output: string; exit?: number; status?: string };
    content?: { type: string; text?: string }[];
  };
};
export function openCodeShellPluginV2(path: string) {
  return {
    id: "stunthog-shell",
    async setup(ctx: {
      tool: {
        hook: (
          name: string,
          fn: (call: OpenCodeResult) => Promise<void>,
        ) => Promise<unknown>;
      };
    }) {
      await ctx.tool.hook("execute.after", async (call) => {
        const { result } = call;
        const shell = result?.output;
        if (
          call.tool !== "shell" ||
          call.status !== "completed" ||
          !shell ||
          typeof shell.output !== "string" ||
          typeof call.input?.command !== "string" ||
          shell.status === "running" ||
          (shell.exit !== undefined && shell.exit !== 0)
        )
          return;
        const value = await applyShell(
          path,
          call.id,
          call.input.command,
          shell.output,
        );
        if (value === shell.output) return;
        if (Array.isArray(result?.content)) {
          result.content = result.content.map((block) =>
            block.type === "text" && block.text === shell.output
              ? { ...block, text: value }
              : block,
          );
        }
        shell.output = value;
      });
    },
  };
}
async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Missing response tool configuration.");
  const config = z
    .object({
      rules: rulesSchema,
      server: z
        .object({
          id: z.string().uuid(),
          command: z.string(),
          arguments: z.array(z.string()),
          url: z.string().nullish(),
          tokenVariable: z.string(),
        })
        .optional(),
    })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const record = (capture: ResponseCapture) => writeCapture(path, capture);
  const downstream = new StdioServerTransport();
  if (!config.server) {
    const server = new McpServer({ name: "stunthog-web", version: "1" });
    server.registerTool(
      "web_fetch",
      {
        description: "Read a web page by URL. Returns text or HTML source.",
        inputSchema: { url: z.string().url() },
      },
      async ({ url }, extra) => {
        const id = randomUUID();
        const text = await fetchPage(
          url,
          extra.signal,
          config.rules,
          id,
          record,
          "StuntHog web fetch",
          relayRewrite(dirname(path)),
        );
        return {
          content: [{ type: "text", text }],
          _meta: { [responseIdKey]: id },
        };
      },
    );
    await server.connect(downstream);
    return;
  }

  const upstream = config.server;
  const token = process.env[upstream.tokenVariable];
  const transport = upstream.url
    ? new StreamableHTTPClientTransport(
        new URL(upstream.url),
        token
          ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
          : {},
      )
    : new StdioClientTransport({
        command: upstream.command,
        args: upstream.arguments,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined && !isCredentialVariable(entry[0]),
          ),
        ),
        stderr: "inherit",
      });
  const calls = new Map<string | number, ToolCall>();
  // Forward discovery, notifications, and server requests. Rewrite only tools/call results.
  downstream.onmessage = (message) => {
    if (
      "method" in message &&
      message.method === "tools/call" &&
      "id" in message &&
      typeof message.params?.name === "string"
    )
      calls.set(message.id, {
        target: {
          kind: "mcp",
          serverId: upstream.id,
          tool: message.params.name,
        },
        args: z.record(z.unknown()).parse(message.params.arguments ?? {}),
      });
    void transport.send(message).catch(async () => {
      if ("id" in message && "method" in message) {
        calls.delete(message.id);
        await downstream.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Cannot reach the MCP server." },
        });
      }
    });
  };
  const forward: NonNullable<typeof transport.onmessage> = async (message) => {
    if ("id" in message && message.id !== undefined && !("method" in message)) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if ("result" in message) {
        if (
          transport instanceof StreamableHTTPClientTransport &&
          typeof message.result.protocolVersion === "string"
        )
          transport.setProtocolVersion(message.result.protocolVersion);
        if (call) {
          const id = randomUUID();
          const result = await deliverResponse(
            config.rules,
            call,
            message.result,
            id,
            "MCP relay",
            record,
            relayRewrite(dirname(path)),
          );
          await downstream.send({
            ...message,
            result: {
              ...result,
              _meta: { ...result._meta, [responseIdKey]: id },
            },
          });
          return;
        }
      }
    }
    await downstream.send(message);
  };
  transport.onmessage = (message) => {
    void Promise.resolve(forward(message))
      .catch(async () => {
        if ("result" in message && "id" in message)
          await downstream.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: "Cannot deliver the tool response.",
            },
          });
      })
      .catch(() => transport.close());
  };
  process.stdin.once("end", () => {
    void transport.close();
  });
  transport.onclose = () => {
    void downstream.close();
  };
  await transport.start();
  await downstream.start();
}
if (require.main === module)
  main().catch(() => {
    console.error("Cannot start the response tool.");
    process.exitCode = 1;
  });
