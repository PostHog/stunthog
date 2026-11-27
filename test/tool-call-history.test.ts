import { Database as SQLite } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ToolCallsController } from "../src/http/tool-calls-controller.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";
import { PrismaSessionRepository } from "../src/sessions/infrastructure/prisma-session-repository.js";

test("previous sessions and live tool events share a durable, searchable call history", async () => {
  const data = await mkdtemp(join(tmpdir(), "stunthog-history-"));
  const restore = {
    data: process.env.STUNTHOG_DATA_DIR,
    url: process.env.DATABASE_URL,
  };
  const file = join(data, "agent-eval_dev.db");
  const id = crypto.randomUUID(),
    session = crypto.randomUUID(),
    server = crypto.randomUUID();
  const snapshot = {
    mcps: [{ id: server }],
    evaluation: { mcpIds: [server], judge: { harness: "claude" } },
  };
  let db: Database | undefined;
  try {
    const previous = new SQLite(file, { create: true });
    try {
      const path = join(import.meta.dir, "../prisma/migrations");
      previous.exec(
        "CREATE TABLE _agent_eval_migrations(name TEXT PRIMARY KEY)",
      );
      for (const entry of (await readdir(path))
        .sort()
        .filter((e) => e < "202611180002")) {
        previous.exec(
          await readFile(join(path, entry, "migration.sql"), "utf8"),
        );
        previous
          .query("INSERT INTO _agent_eval_migrations(name) VALUES (?)")
          .run(entry);
      }
      previous
        .query(
          "INSERT INTO Eval(id,title,prompt,judge,updatedAt) VALUES (?,'Setup','Install','{}',CURRENT_TIMESTAMP)",
        )
        .run(id);
      previous
        .query(
          "INSERT INTO Session(id,evalId,batchId,model,harness,status,snapshot) VALUES (?,?,'batch','example','codex','completed',?)",
        )
        .run(session, id, JSON.stringify(snapshot));
      previous
        .query(
          "INSERT INTO SessionEvent(sessionId,phase,sequence,event) VALUES (?,'agent',1,?)",
        )
        .run(
          session,
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "codex1",
              type: "mcp_tool_call",
              server: "eval_0",
              tool: "read_doc",
              arguments: { query: "Router" },
              result: {
                content: [{ type: "text", text: "install analytics" }],
              },
            },
          }),
        );
    } finally {
      previous.close();
    }
    await migrateDatabase(data);
    db = new Database();
    assert.deepEqual(
      (await db.eval.findUniqueOrThrow({ where: { id } })).responseOverrides,
      [],
    );
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id: session } }))
        .behaviorDrift,
      null,
    );
    assert.deepEqual(
      await db.session.findUniqueOrThrow({
        where: { id: session },
        select: { origin: true, memo: true },
      }),
      { origin: "synthetic", memo: null },
    );
    const history = new ToolCallsController(db);
    const found = await history.search({
      query: "analyti",
      harness: "codex",
      phase: "agent",
      evalId: id,
    });
    assert.equal(found.calls.length, 1);
    assert.doesNotThrow(() => JSON.stringify(found));
    assert.equal(found.calls[0]?.inputPreview, "Router");
    assert.equal(found.calls[0]?.outputPreview, "install analytics");
    assert.equal(found.calls[0]?.model, "example");
    assert.equal(found.calls[0]?.evaluation, "Setup");
    assert.ok(Date.parse(found.calls[0]?.createdAt ?? ""));
    assert.equal(
      (await history.search({ kind: "mcp" })).calls[0]?.tool,
      "read_doc",
    );
    const row = await history.example(String(found.calls[0]?.id));
    assert.deepEqual(row.input, { query: "Router" });
    assert.deepEqual(row.target, {
      kind: "mcp",
      serverId: server,
      tool: "read_doc",
    });
    assert.deepEqual(row.sample, {
      content: [{ type: "text", text: "install analytics" }],
    });
    assert.deepEqual(await history.mcpTools(server), ["read_doc"]);
    const repo = new PrismaSessionRepository(db);
    const record = (phase: string, event: unknown) =>
      repo.event(session, phase, event);
    await record("judge", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "same",
            name: "Read",
            input: { path: "main.ts" },
          },
        ],
      },
    });
    await record("judge", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "same",
            is_error: true,
            content: "missing fixture",
          },
        ],
      },
    });
    await record("agent", {
      type: "tool_execution_start",
      toolCallId: "same",
      toolName: "bash",
      args: { command: "pwd", accessToken: "sensitive-example" },
    });
    await record("agent", {
      type: "tool_execution_end",
      toolCallId: "same",
      toolName: "bash",
      result: { content: [{ type: "text", text: "directory" }] },
    });
    await record("agent", {
      type: "tool_use",
      part: {
        callID: "open",
        tool: "webfetch",
        state: {
          status: "completed",
          input: { url: "https://example.com/" },
          output: "page contents",
        },
      },
    });
    assert.equal(
      (
        await history.search({
          query: "missing",
          phase: "judge",
          status: "failed",
          harness: "claude",
        })
      ).calls.length,
      1,
    );
    assert.equal(
      (await history.search({ query: "pwd", phase: "agent" })).calls.length,
      1,
    );
    assert.equal(
      (await history.search({ query: "directory" })).calls[0]?.name,
      "bash",
    );
    assert.equal(
      (await history.search({ query: "missing", phase: "agent" })).calls.length,
      0,
    );
    const web = await history.example(
      String((await history.search({ query: "page contents" })).calls[0]?.id),
    );
    assert.deepEqual(web.target, { kind: "web", url: "https://example.com/" });
    assert.equal(web.output, "page contents");
    assert.deepEqual(
      (await history.search({ kind: "web" })).calls.map((c) => c.inputPreview),
      ["https://example.com/"],
    );
    const shell = (await history.search({ query: "directory" })).calls[0];
    assert.equal(shell?.inputPreview, "pwd");
    assert.equal(shell?.outputPreview, "directory");
    assert.equal(
      (await history.search({ kind: "shell" })).calls[0]?.id,
      shell?.id,
    );
    assert.deepEqual((await history.example(String(shell?.id))).target, {
      kind: "shell",
      match: "batch",
      command: "pwd",
    });
    const branch = await db.session.create({
      data: {
        evalId: id,
        batchId: "batch",
        model: "example",
        harness: "codex",
        status: "completed",
        parentSessionId: session,
        rootSessionId: session,
        snapshot,
      },
    });
    await repo.event(branch.id, "agent", {
      type: "item.completed",
      item: {
        id: "branch-command",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "branch-only-output",
        exit_code: 0,
      },
    });
    assert.equal(
      (await history.search({ query: "branch-only-output" })).calls.length,
      0,
    );
    assert.equal(
      (
        await history.search({
          query: "branch-only-output",
          sessionId: branch.id,
        })
      ).calls[0]?.sessionId,
      branch.id,
    );
    await db.$disconnect();
    await migrateDatabase(data);
    db = new Database();
    assert.equal(await db.toolCall.count(), 5);
    assert.equal(
      (await new ToolCallsController(db).search({ query: "Router" })).calls
        .length,
      1,
    );
  } finally {
    await db?.$disconnect();
    if (restore.data === undefined) delete process.env.STUNTHOG_DATA_DIR;
    else process.env.STUNTHOG_DATA_DIR = restore.data;
    if (restore.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = restore.url;
    await rm(data, { recursive: true, force: true });
  }
});
