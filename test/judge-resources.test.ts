import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Resource } from "../src/catalog/domain/resource.js";
import { PrismaCatalog } from "../src/catalog/infrastructure/prisma-catalog.js";
import { KeyVault } from "../src/credentials/key-vault.js";
import { EvaluationsService } from "../src/evaluations/application/evaluations-service.js";
import { ModelSettings } from "../src/evaluations/domain/model-settings.js";
import { PrismaEvaluationRepository } from "../src/evaluations/infrastructure/prisma-evaluation-repository.js";
import type { Harness, HarnessInput } from "../src/harnesses/domain/harness.js";
import type { HarnessRegistry } from "../src/harnesses/domain/harness-registry.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";
import { SessionQueue } from "../src/sessions/application/session-queue.js";
import { SessionWorker } from "../src/sessions/application/session-worker.js";
import { StartSessions } from "../src/sessions/application/start-sessions.js";
import type { ExecutionSnapshot } from "../src/sessions/domain/execution-snapshot.js";
import { ArtifactStore } from "../src/sessions/infrastructure/artifact-store.js";
import { PrismaSessionRepository } from "../src/sessions/infrastructure/prisma-session-repository.js";
import { DefaultWorkspaceRuntimeFactory } from "../src/sessions/infrastructure/workspace-runtime-factory.js";
import { SettingsService } from "../src/settings/application/settings-service.js";
import { PrismaSettingsRepository } from "../src/settings/infrastructure/prisma-settings-repository.js";
import { fixture } from "./fixture.js";

test(
  "judge skills and MCP servers are saved, snapshotted, and sent only to the judge",
  { timeout: 30_000 },
  verifyJudgeResources,
);

async function verifyJudgeResources() {
  const f = await fixture();
  const data = await mkdtemp(join(tmpdir(), "stunthog-judge-resources-"));
  const previousDirectory = process.env.STUNTHOG_DATA_DIR;
  const previousUrl = process.env.DATABASE_URL;

  await migrateDatabase(data);

  const db = new Database();

  try {
    const catalog = new PrismaCatalog(db);
    const agentSkill = Resource.create({
      kind: "skill",
      title: "Agent skill",
      filePath: null,
      content: "AGENT-SKILL-TEXT",
    });
    const judgeSkill = Resource.create({
      kind: "skill",
      title: "Docs rubric",
      filePath: null,
      content: "JUDGE-RUBRIC-TEXT",
    });
    const agentMcp = Resource.create({
      kind: "mcp",
      title: "Writer",
      description: "Writes things.",
      command: "writer-mcp",
      arguments: [],
    });
    const judgeMcp = Resource.create({
      kind: "mcp",
      title: "Docs search",
      description: "Reads docs.",
      command: "docs-mcp",
      arguments: ["--read-only"],
    });

    for (const resource of [agentSkill, judgeSkill, agentMcp, judgeMcp])
      await catalog.save(resource);

    const vault = new KeyVault(db);

    await vault.save("openrouter", "test-secret");

    const evals = new EvaluationsService(new PrismaEvaluationRepository(db));
    const model = { ...ModelSettings.create({ model: "test-model" }).value };
    const evaluation = await evals.save({
      title: "Docs",
      prompt: "Update the docs",
      criteria: [{ description: "Links work" }],
      models: [model],
      judge: model,
      skillIds: [agentSkill.value.id],
      mcpIds: [agentMcp.value.id],
      judgeSkillIds: [judgeSkill.value.id, judgeSkill.value.id],
      judgeMcpIds: [judgeMcp.value.id],
      judgeMcpTools: {
        [judgeMcp.value.id]: [" search_docs ", "search_docs", "get_page"],
      },
    });
    const allowedTools = { [judgeMcp.value.id]: ["search_docs", "get_page"] };

    assert.deepEqual(evaluation.judgeMcpTools, allowedTools);

    // Judge MCP tools are auto-approved, so each judge MCP server needs a named tool list.
    const unlimited = {
      title: "Docs",
      prompt: "Update the docs",
      criteria: [{ description: "Links work" }],
      models: [model],
      judge: model,
      judgeMcpIds: [judgeMcp.value.id],
    };

    await assert.rejects(evals.save(unlimited), /Name at least one tool/);
    await assert.rejects(
      evals.save({
        ...unlimited,
        judgeMcpTools: { [judgeMcp.value.id]: ["bad name"] },
      }),
    );

    // Duplicates collapse, and the selections survive a reload, a revision, and a duplicate.
    assert.deepEqual(evaluation.judgeSkillIds, [judgeSkill.value.id]);

    const reloaded = (await evals.get(evaluation.id)).snapshot();

    assert.deepEqual(reloaded.judgeSkillIds, [judgeSkill.value.id]);
    assert.deepEqual(reloaded.judgeMcpIds, [judgeMcp.value.id]);
    assert.deepEqual(reloaded.mcpIds, [agentMcp.value.id]);

    const { id: _id, ...input } = reloaded;
    const revised = await evals.save(
      { ...input, prompt: "Update the docs again" },
      evaluation.id,
    );

    assert.deepEqual(reloaded.judgeMcpTools, allowedTools);
    assert.deepEqual(revised.judgeMcpIds, [judgeMcp.value.id]);
    assert.deepEqual(revised.judgeMcpTools, allowedTools);

    const duplicate = await evals.duplicate(evaluation.id);

    assert.deepEqual(duplicate.judgeSkillIds, [judgeSkill.value.id]);
    assert.deepEqual(duplicate.judgeMcpTools, {
      [judgeMcp.value.id]: ["search_docs", "get_page"],
    });

    // Library resources in use by a judge cannot be deleted.
    await assert.rejects(catalog.delete("skill", judgeSkill.value.id));
    await assert.rejects(catalog.delete("mcp", judgeMcp.value.id));

    const calls: HarnessInput[] = [];
    const adapter: Harness = {
      id: "pi",
      title: "Test",
      binary: null,
      provider: "openrouter",
      supportsMcp: true,
      judgeSupportsMcp: true,
      models: async () => [{ id: "test-model", name: "Test" }],
      run: async (request) => {
        calls.push(request);

        if (request.label !== "judge")
          await writeFile(join(request.directory, "messages.json"), "[]");

        return {
          label: request.label,
          status: "completed",
          durationMs: 1,
          text:
            request.label === "judge"
              ? JSON.stringify({
                  summary: "Checked",
                  decisions: revised.criteria.map((criterion) => ({
                    criterionId: criterion.id,
                    passed: true,
                    feedback: "Docs search confirmed the links.",
                  })),
                })
              : "Done",
        };
      },
    };
    let judgeSupportsMcp = true;
    const harnesses: HarnessRegistry = {
      get: () => adapter,
      catalog: async () => [
        {
          id: "pi",
          title: "Test",
          installed: true,
          provider: "openrouter",
          models: [{ id: "test-model", name: "Test" }],
          supportsMcp: true,
          judgeSupportsMcp,
        },
      ],
    };
    const sessions = new PrismaSessionRepository(db);
    const artifacts = new ArtifactStore(db);
    const settings = new SettingsService(new PrismaSettingsRepository(db));
    const starter = new StartSessions(
      new PrismaEvaluationRepository(db),
      catalog,
      sessions,
      artifacts,
      new SessionWorker(
        sessions,
        artifacts,
        harnesses,
        vault,
        new DefaultWorkspaceRuntimeFactory(),
      ),
      harnesses,
      vault,
      settings,
      new SessionQueue(),
    );

    const batch = await starter.start(evaluation.id);

    for (let attempt = 0; attempt < 500; attempt++) {
      const pending = await db.session.count({
        where: {
          batchId: batch.batchId,
          status: { in: ["queued", "running", "judging"] },
        },
      });

      if (!pending) break;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const saved = await db.session.findFirstOrThrow({
      where: { batchId: batch.batchId },
    });

    assert.equal(saved.status, "completed", saved.error ?? "");

    const snapshot = saved.snapshot as unknown as ExecutionSnapshot;

    assert.deepEqual(snapshot.judgeSkills, [
      { title: "Docs rubric", content: "JUDGE-RUBRIC-TEXT" },
    ]);
    assert.deepEqual(
      snapshot.judgeMcps?.map((mcp) => [mcp.command, mcp.allowedTools]),
      [["docs-mcp", ["search_docs", "get_page"]]],
    );

    const agent = calls.find((call) => call.label !== "judge");
    const judge = calls.find((call) => call.label === "judge");

    assert.ok(agent && judge);
    assert.deepEqual(
      agent.mcps?.map((mcp) => mcp.command),
      ["writer-mcp"],
    );
    assert.deepEqual(
      judge.mcps?.map((mcp) => [mcp.command, mcp.allowedTools]),
      [["docs-mcp", ["search_docs", "get_page"]]],
    );
    // Agents keep every tool from their own MCP servers.
    assert.equal(agent.mcps?.[0]?.allowedTools, undefined);
    assert.deepEqual(judge.tools, []);
    assert.deepEqual(judge.skills, []);
    assert.match(judge.prompt, /JUDGE-RUBRIC-TEXT/);
    assert.doesNotMatch(judge.prompt, /AGENT-SKILL-TEXT/);
    assert.doesNotMatch(agent.prompt, /JUDGE-RUBRIC-TEXT/);

    // A judge harness that cannot keep built-in tools off while allowing MCP rejects the run up front.
    judgeSupportsMcp = false;
    const before = await db.session.count();

    await assert.rejects(
      starter.start(evaluation.id),
      /judge cannot use MCP servers/,
    );
    assert.equal(await db.session.count(), before);

    await starter.onModuleDestroy();
  } finally {
    await db.$disconnect();
    if (previousDirectory === undefined) delete process.env.STUNTHOG_DATA_DIR;
    else process.env.STUNTHOG_DATA_DIR = previousDirectory;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await rm(data, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
}
