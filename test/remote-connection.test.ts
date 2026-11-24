import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectRemote } from "../src/catalog/infrastructure/inspect-remote.js";

test("a remote MCP challenge offers authorization", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("Token required", { status: 401 }),
  });
  try {
    assert.equal(
      (await inspectRemote(server.url.href)).status,
      "authorization",
    );
  } finally {
    await server.stop(true);
  }
});

test("tool discovery follows cursors and sends only discovery requests", async () => {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (request.headers.get("authorization") !== "Bearer fixture")
        return new Response(null, { status: 401 });
      const { method, params, id } = await request.json();
      methods.push(method);
      if (method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        });
      if (method !== "tools/list") return new Response(null, { status: 400 });
      const next = params?.cursor === "page-2";
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: next ? "save" : "lookup",
              description: next ? "Write" : "Read",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: !next },
            },
          ],
          ...(!next && { nextCursor: "page-2" }),
        },
      });
    },
  });
  try {
    const result = await inspectRemote(server.url.href, "fixture", true);
    assert.deepEqual(result, {
      status: "ready",
      tools: [
        { name: "lookup", description: "Read", readOnly: true },
        { name: "save", description: "Write", readOnly: false },
      ],
    });
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
    ]);
  } finally {
    await server.stop(true);
  }
});
