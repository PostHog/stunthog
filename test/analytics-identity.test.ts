import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { ExecutionContext } from "@nestjs/common";
import { firstValueFrom, throwError } from "rxjs";
import { AnalyticsService } from "../src/analytics/analytics-service.js";
import { loadInstallationId } from "../src/analytics/installation-identity.js";
import { SettingsController } from "../src/http/settings-controller.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";

test(
  "installation identity survives restart and concurrent access, and differs between databases",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "stunthog-identity-"));
    const previousDirectory = process.env.STUNTHOG_DATA_DIR;
    const previousUrl = process.env.DATABASE_URL;
    const databases: Database[] = [];
    try {
      const productionPath = join(root, "first", "stunthog.db");
      await mkdir(join(root, "first"));
      await writeFile(productionPath, "existing production database");
      await migrateDatabase(join(root, "first"));
      assert.equal(
        await readFile(productionPath, "utf8"),
        "existing production database",
      );
      assert.equal(
        process.env.DATABASE_URL,
        `file:${join(root, "first", "stunthog_dev.db")}`,
      );
      const first = new Database();
      databases.push(first);
      const ids = await Promise.all(
        Array.from({ length: 4 }, () => loadInstallationId(first)),
      );
      assert.equal(new Set(ids).size, 1);
      const distinctId = ids[0];
      assert.match(distinctId ?? "", /^[0-9a-f-]{36}$/);
      await first.$disconnect();

      await migrateDatabase(join(root, "first"));
      const restarted = new Database();
      databases.push(restarted);
      assert.equal(await loadInstallationId(restarted), distinctId);

      await migrateDatabase(join(root, "second"));
      const second = new Database();
      databases.push(second);
      assert.notEqual(await loadInstallationId(second), distinctId);
    } finally {
      for (const database of databases) await database.$disconnect();
      if (previousDirectory === undefined) delete process.env.STUNTHOG_DATA_DIR;
      else process.env.STUNTHOG_DATA_DIR = previousDirectory;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("backend events, exceptions, logs, and agent/judge traces share the anonymous installation identity", async () => {
  const bodies: Record<string, unknown>[] = [];
  const bodyPaths: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    const json =
      request.headers["content-encoding"] === "gzip"
        ? gunzipSync(buffer)
        : buffer;
    bodies.push(JSON.parse(json.toString()));
    bodyPaths.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousToken = process.env.POSTHOG_PROJECT_TOKEN;
  const previousHost = process.env.POSTHOG_HOST;
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  process.env.POSTHOG_HOST = `http://127.0.0.1:${address.port}`;
  const distinctId = randomUUID();
  const analytics = new AnalyticsService(distinctId);

  try {
    analytics.capture("identity test", { action: "test" });
    analytics.info("identity log");
    analytics.exception(new Error("identity exception"), "test");
    const traceId = randomUUID();
    for (const phase of ["agent", "judge"]) {
      analytics.captureAi(
        "$ai_generation",
        { $ai_trace_id: traceId, phase },
        new Date(),
      );
      analytics.captureAi(
        "$ai_span",
        { $ai_trace_id: traceId, phase },
        new Date(),
      );
    }
    analytics.captureAi("$ai_trace", { $ai_trace_id: traceId }, new Date());

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { "x-posthog-distinct-id": "wrong-browser-id" },
          url: "/test",
          method: "GET",
        }),
        getResponse: () => ({ statusCode: 500 }),
      }),
    } as ExecutionContext;
    await assert.rejects(
      firstValueFrom(
        await analytics.interceptor().intercept(context, {
          handle: () => throwError(() => new Error("interceptor exception")),
        }),
      ),
    );
    await analytics.onApplicationShutdown();

    const events = bodies.flatMap((body, index) =>
      Array.isArray(body.batch)
        ? body.batch.map((event) => ({ ...event, path: bodyPaths[index] }))
        : [],
    ) as {
      event: string;
      distinct_id: string;
      options?: Record<string, unknown>;
      path?: string;
      properties: Record<string, unknown>;
    }[];
    for (const event of [
      "identity test",
      "$exception",
      "$ai_generation",
      "$ai_span",
      "$ai_trace",
    ]) {
      assert.ok(
        events.some((item) => item.event === event),
        `Missing ${event}: ${JSON.stringify(bodies)}`,
      );
    }
    for (const event of events) {
      assert.equal(event.distinct_id, distinctId);
      assert.equal(event.properties.$is_identified, false);
      assert.equal(event.properties.$device_id, distinctId);
      assert.equal(event.options?.process_person_profile, true);
      assert.equal(
        event.path,
        event.event.startsWith("$ai_")
          ? "/i/v1/ai/events"
          : "/i/v1/analytics/events",
      );
    }
    const ai = events.filter((event) => event.event.startsWith("$ai_"));
    assert.equal(ai.length, 5);
    assert.ok(ai.every((event) => event.properties.$ai_trace_id === traceId));
    assert.ok(ai.some((event) => event.properties.phase === "judge"));
    assert.ok(ai.some((event) => event.properties.phase === "agent"));
    const logs = bodies.filter((body) => body.resourceLogs);
    assert.ok(logs.length > 0);
    assert.ok(
      JSON.stringify(logs).includes(
        `"key":"posthogDistinctId","value":{"stringValue":"${distinctId}"}`,
      ),
    );
    assert.deepEqual(
      SettingsController.prototype.analyticsIdentity.call({ analytics }),
      { distinctId },
    );
  } finally {
    await analytics.onApplicationShutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previousToken === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
    else process.env.POSTHOG_PROJECT_TOKEN = previousToken;
    if (previousHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = previousHost;
  }
});
