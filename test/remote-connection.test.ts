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
