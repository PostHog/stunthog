import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export async function inspectRemote(
  url: string,
  token?: string,
  discover = false,
) {
  const client = new Client({ name: "stunthog", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      ...(token && { headers: { Authorization: `Bearer ${token}` } }),
    },
  });
  const signal = AbortSignal.timeout(10000);
  try {
    await client.connect(transport, { signal });
    const tools: { name: string; description: string; readOnly: boolean }[] =
      [];
    if (discover) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal,
        });
        for (const tool of page.tools)
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error("The server repeated a tool cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    return { status: "ready" as const, tools };
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      (error instanceof StreamableHTTPError && error.code === 401)
    )
      return { status: "authorization" as const };
    return { status: "unavailable" as const };
  } finally {
    if (transport.sessionId) await transport.terminateSession().catch(() => {});
    await client.close();
  }
}
