import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Resource } from "../src/catalog/domain/resource.js";
import { McpOAuth } from "../src/catalog/infrastructure/mcp-oauth.js";
import { PrismaCatalog } from "../src/catalog/infrastructure/prisma-catalog.js";
import { KeyVault } from "../src/credentials/key-vault.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";

test("MCP URL and OAuth credentials survive restart and concurrent use refreshes once", async () => {
  const data = await mkdtemp(join(tmpdir(), "stunthog-mcp-"));
  const previousDirectory = process.env.STUNTHOG_DATA_DIR;
  const previousUrl = process.env.DATABASE_URL;
  await migrateDatabase(data);
  const db = new Database();
  let refreshes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const origin = server.url.origin;
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (path === "/register")
        return Response.json({
          ...(await request.json()),
          client_id: "test-client",
        });
      if (path === "/token") {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "refresh_token") {
          assert.equal(body.get("refresh_token"), "mock-refresh-token");
          refreshes++;
          return Response.json({
            access_token: "mock-new-access-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        assert.equal(body.get("code"), "test-code");
        assert.ok(body.get("code_verifier"));
        return Response.json({
          access_token: "mock-access-token",
          refresh_token: "mock-refresh-token",
          token_type: "Bearer",
          expires_in: 1,
        });
      }
      return new Response(null, { status: 404 });
    },
  });

  try {
    const url = new URL("mcp", server.url).href;
    const catalog = new PrismaCatalog(db);
    await catalog.save(
      Resource.create({ kind: "mcp", title: "Remote", url, arguments: [] }),
    );
    assert.equal((await catalog.list()).mcps[0]?.url, url);
    const oauth = new McpOAuth(new KeyVault(db));
    const authorize = new URL(
      await oauth.connect(url, "http://127.0.0.1:3100/callback"),
    );
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const state = authorize.searchParams.get("state");
    assert.ok(state);
    await assert.rejects(oauth.complete(crypto.randomUUID(), "test-code"));
    await oauth.complete(state, "test-code");
    await assert.rejects(oauth.complete(state, "test-code"));
    const saved = await db.credential.findFirstOrThrow();
    assert.ok(!saved.encryptedValue.includes("mock-refresh-token"));
    const restarted = new McpOAuth(new KeyVault(db));
    assert.deepEqual(
      await Promise.all([
        restarted.accessToken(url),
        restarted.accessToken(url),
      ]),
      ["mock-new-access-token", "mock-new-access-token"],
    );
    assert.equal(refreshes, 1);
  } finally {
    await server.stop(true);
    await db.$disconnect();
    await rm(data, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.STUNTHOG_DATA_DIR;
    else process.env.STUNTHOG_DATA_DIR = previousDirectory;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
