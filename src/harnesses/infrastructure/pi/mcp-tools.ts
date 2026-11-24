import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";
import { z } from "zod";
import { deliverResponse } from "../../../overrides/infrastructure/deliver.js";
import type {
  HarnessRequest,
  McpServer,
  ProcessCommand,
} from "../../domain/execution.js";

export async function connectMcpTools(request: HarnessRequest) {
  const clients: Client[] = [];
  const tools: ToolDefinition[] = [];
  const close = async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  };

  try {
    for (const [index, server] of (request.mcps ?? []).entries()) {
      const client = new Client({ name: "stunthog", version: "1.0.0" });

      clients.push(client);

      const transport = server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            ...(server.accessToken && {
              requestInit: {
                headers: { Authorization: `Bearer ${server.accessToken}` },
              },
            }),
          })
        : await stdioTransport(server, request);

      await client.connect(transport, {
        signal: request.signal,
        timeout: 30_000,
      });

      let cursor: string | undefined;

      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal: request.signal,
          timeout: 30_000,
        });

        // Judges get only the tools the evaluation author allowed. Agents get every tool.
        const allowed = server.allowedTools
          ? page.tools.filter((tool) =>
              server.allowedTools?.includes(tool.name),
            )
          : page.tools;

        for (const tool of allowed) {
          tools.push({
            name: `mcp_${index}_${tools.length}_${tool.name.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`.slice(
              0,
              64,
            ),
            label: `${server.title}: ${tool.name}`,
            description: tool.description ?? tool.name,
            parameters: tool.inputSchema as TSchema,
            execute: async (id, args, signal) => {
              const result = await client.callTool(
                {
                  name: tool.name,
                  arguments: z.record(z.unknown()).parse(args),
                },
                undefined,
                { ...(signal ? { signal } : {}), timeout: 30_000 },
              );

              const delivered =
                server.id &&
                (request.onToolResponse || request.responseOverrides?.length)
                  ? await deliverResponse(
                      request.responseOverrides ?? [],
                      {
                        target: {
                          kind: "mcp",
                          serverId: server.id,
                          tool: tool.name,
                        },
                        args: z.record(z.unknown()).parse(args),
                      },
                      result,
                      id,
                      "Pi MCP",
                      request.onToolResponse,
                      request.rewrite,
                    )
                  : result;
              return {
                content: [{ type: "text", text: JSON.stringify(delivered) }],
                details: {},
                isError: result.isError === true,
              };
            },
          });
        }

        cursor = page.nextCursor;
      } while (cursor);
    }

    return { tools, close };
  } catch (error) {
    await close();

    throw error;
  }
}

async function stdioTransport(server: McpServer, request: HarnessRequest) {
  const env = request.runtime?.kind === "docker" ? {} : { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const localCommand: ProcessCommand = {
    binary: server.command,
    args: server.arguments,
    env,
  };
  const command = request.runtime
    ? await request.runtime.process(localCommand, request.workspace)
    : localCommand;
  return new StdioClientTransport({
    command: command.binary,
    args: command.args,
    env: Object.fromEntries(
      Object.entries(command.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...(request.runtime ? {} : { cwd: request.workspace }),
    stderr: "pipe",
  });
}
