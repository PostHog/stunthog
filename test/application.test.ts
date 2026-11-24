import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NestFactory } from "@nestjs/core";
import { ApplicationModule } from "../src/application.module.js";
import { Resource } from "../src/catalog/domain/resource.js";
import { PrismaCatalog } from "../src/catalog/infrastructure/prisma-catalog.js";
import { KeyVault } from "../src/credentials/key-vault.js";
import { EvaluationsService } from "../src/evaluations/application/evaluations-service.js";
import { ModelSettings } from "../src/evaluations/domain/model-settings.js";
import { PrismaEvaluationRepository } from "../src/evaluations/infrastructure/prisma-evaluation-repository.js";
import type { Harness } from "../src/harnesses/domain/harness.js";
import type { HarnessRegistry } from "../src/harnesses/domain/harness-registry.js";
import { SessionsController } from "../src/http/sessions-controller.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";
import type { ResponseRule } from "../src/overrides/domain/response-override.js";
import { SessionQueue } from "../src/sessions/application/session-queue.js";
import { SessionWorker } from "../src/sessions/application/session-worker.js";
import { StartSessions } from "../src/sessions/application/start-sessions.js";
import { ArtifactStore } from "../src/sessions/infrastructure/artifact-store.js";
import { PrismaSessionRepository } from "../src/sessions/infrastructure/prisma-session-repository.js";
import { DefaultWorkspaceRuntimeFactory } from "../src/sessions/infrastructure/workspace-runtime-factory.js";
import { SettingsService } from "../src/settings/application/settings-service.js";
import { PrismaSettingsRepository } from "../src/settings/infrastructure/prisma-settings-repository.js";
import { fixture } from "./fixture.js";

test(
  "SQLite saves eval revisions, encrypted credentials, independent judgments, logs, files, and usage",
  { timeout: 30_000 },
  verifyApplicationPersistence,
);

async function verifyApplicationPersistence() {
  const f = await fixture();
  const data = await mkdtemp(join(tmpdir(), "stunthog-database-"));
  const previousDirectory = process.env.STUNTHOG_DATA_DIR;
  const previousUrl = process.env.DATABASE_URL;

  await migrateDatabase(data);

  const db = new Database();

  try {
    const catalog = new PrismaCatalog(db);
    const environment = Resource.create({
      kind: "environment",
      title: "Sample",
      workspacePath: f.workspace,
    });
    const persona = Resource.create({
      kind: "persona",
      title: "Engineer",
      description: "Verify all changes.",
    });
    const skill = Resource.create({
      kind: "skill",
      title: "Inspect the code",
      filePath: null,
      content: "Read app.ts before making changes.",
    });

    await catalog.save(environment);
    await catalog.save(persona);
    await catalog.save(skill);

    const vault = new KeyVault(db);

    await vault.save("openrouter", "test-secret");

    assert.equal(await vault.read("openrouter"), "test-secret");

    assert.doesNotMatch(JSON.stringify(await vault.list()), /test-secret/);

    assert.doesNotMatch(
      (
        await db.credential.findUniqueOrThrow({
          where: { provider: "openrouter" },
        })
      ).encryptedValue,
      /test-secret/,
    );

    const evals = new EvaluationsService(new PrismaEvaluationRepository(db));
    const model = {
      ...ModelSettings.create({ model: "test-model", count: 2 }).value,
    };
    const rule = {
      id: crypto.randomUUID(),
      target: { kind: "web" as const },
      mode: "text" as const,
      find: "old SDK",
      replacement: "updated SDK",
      inputContains: "",
      outputContains: "",
      path: "",
    };
    const evaluation = await evals.save({
      responseOverrides: [rule],
      title: "Install",
      prompt: "Change the app",
      criteria: [{ description: "App changed" }],
      models: [model],
      judge: model,
      environmentId: environment.value.id,
      personaId: persona.value.id,
      skillIds: [skill.value.id],
    });

    await assert.rejects(catalog.delete("persona", persona.value.id));

    let judgeCalls = 0;
    const drift = {
      callId: "docs-1",
      outcome: "observed",
      explanation:
        'The agent wrote "updated SDK" to app.ts after reading the edited documentation.',
    };
    let expectedRules: ResponseRule[] = [rule];
    const adapter: Harness = {
      id: "pi",
      title: "Test",
      binary: null,
      provider: "openrouter",
      supportsMcp: true,
      judgeSupportsMcp: true,
      models: async () => [{ id: "test-model", name: "Test" }],
      run: async (input) => {
        await input.onRawEvent({ type: "test", label: input.label });

        if (input.label === "judge") {
          assert.equal(input.responseOverrides, undefined);
          assert.equal(input.onToolResponse, undefined);
          assert.match(input.prompt, /"callId":"docs-1"/);
          assert.match(
            input.prompt,
            /"original":"old SDK","delivered":"updated SDK"/,
          );
          assert.match(input.prompt, /Wrote updated SDK to app.ts/);
          judgeCalls++;
        } else {
          assert.deepEqual(input.responseOverrides, expectedRules);
          assert.match(input.persona ?? "", /Verify all changes/);
          assert.equal(
            await readFile(join(input.workspace, "app.ts"), "utf8"),
            "original",
          );
          assert.match(
            await readFile(join(input.skills[0] ?? "", "SKILL.md"), "utf8"),
            /Read app\.ts before making changes/,
          );
          await input.onToolResponse?.({
            callId: drift.callId,
            route: "web_fetch",
            target: { kind: "web", url: "https://example.org/sdk" },
            args: {},
            original: rule.find,
            delivered: rule.replacement,
            ruleId: rule.id,
          });
          await writeFile(join(input.workspace, "app.ts"), rule.replacement);
          await writeFile(
            join(input.directory, "messages.json"),
            JSON.stringify([
              { role: "assistant", content: "Wrote updated SDK to app.ts" },
            ]),
          );
        }

        return {
          label: input.label,
          status: "completed",
          durationMs: 1,
          text:
            input.label === "judge"
              ? JSON.stringify({
                  summary: "Changed correctly",
                  behaviorDrift: [drift],
                  decisions: evaluation.criteria.map((criterion) => ({
                    criterionId: criterion.id,
                    passed: true,
                    feedback: "The edit is in the transcript.",
                  })),
                })
              : "Done",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            total: 15,
            costUsd: 0.01,
          },
        };
      },
    };
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
          judgeSupportsMcp: true,
        },
      ],
    };
    const sessions = new PrismaSessionRepository(db);
    const artifacts = new ArtifactStore(db);
    const settings = new SettingsService(new PrismaSettingsRepository(db));

    await db.appSettings.create({
      data: { id: "local", sessionConcurrency: 4 },
    });
    const initialSettings = await settings.get();
    assert.equal(initialSettings.sessionConcurrency, 4);
    assert.equal(initialSettings.evaluationDefaults.models.length, 6);
    const evaluationDefaults = {
      models: [model],
      judge: { ...model, count: 1 },
    };
    await settings.update({ evaluationDefaults });
    await settings.update({ sessionConcurrency: 3 });
    assert.equal((await settings.get()).sessionConcurrency, 3);
    assert.deepEqual(
      (await new SettingsService(new PrismaSettingsRepository(db)).get())
        .evaluationDefaults,
      evaluationDefaults,
    );
    assert.deepEqual(
      (await evals.get(evaluation.id)).snapshot().models,
      evaluation.models,
    );
    await assert.rejects(
      settings.update({
        evaluationDefaults: {
          models: [{ ...model, maxTurns: 0 }],
          judge: null,
        },
      }),
    );
    assert.deepEqual(
      (await settings.get()).evaluationDefaults,
      evaluationDefaults,
    );

    const worker = new SessionWorker(
      sessions,
      artifacts,
      harnesses,
      vault,
      new DefaultWorkspaceRuntimeFactory(),
    );
    const starter = new StartSessions(
      new PrismaEvaluationRepository(db),
      catalog,
      sessions,
      artifacts,
      worker,
      harnesses,
      vault,
      settings,
      new SessionQueue(),
    );

    const baseline = await starter.start(evaluation.id);
    await starter.onModuleDestroy();

    const shellRule: ResponseRule = {
      ...rule,
      id: crypto.randomUUID(),
      target: {
        kind: "shell",
        match: "command",
        command: "grep posthog package.json",
      },
    };
    const withShell = await evals.addOverride(evaluation.id, shellRule);
    assert.equal(
      (await evals.addOverride(evaluation.id, shellRule)).revision,
      withShell.revision,
    );
    expectedRules = [rule, shellRule];
    const oldSession = await db.session.findFirstOrThrow({
      where: { batchId: baseline.batchId },
    });
    assert.ok(!JSON.stringify(oldSession.snapshot).includes(shellRule.id));
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

    const saved = await db.session.findMany({
      where: { batchId: batch.batchId },
      include: {
        decisions: true,
        events: true,
        artifacts: { select: { phase: true, path: true } },
      },
    });

    assert.equal(saved.length, 2);

    assert.equal(judgeCalls, 2);

    for (const session of saved) {
      assert.equal(session.status, "completed", session.error ?? "");
      assert.equal(session.decisions.length, 1);
      assert.equal(session.totalTokens, 30);
      assert.equal(session.costUsd, 0.02);
      assert.equal(session.events.length, 3);
      assert.deepEqual(session.behaviorDrift, [drift]);
      assert.ok(
        session.artifacts.some(
          (file) => file.phase === "output" && file.path === "app.ts",
        ),
      );
      assert.ok(!session.artifacts.some((file) => file.path === ".env"));
    }

    const duplicate = await evals.duplicate(evaluation.id);

    assert.notEqual(duplicate.id, evaluation.id);
    assert.equal(duplicate.revision, 1);
    assert.equal(duplicate.title, evaluation.title);
    assert.equal(duplicate.prompt, evaluation.prompt);
    assert.deepEqual(duplicate.models, evaluation.models);
    assert.deepEqual(duplicate.skillIds, evaluation.skillIds);
    assert.notEqual(duplicate.responseOverrides?.[0]?.id, rule.id);
    assert.equal(
      duplicate.responseOverrides?.[0]?.replacement,
      rule.replacement,
    );
    assert.notEqual(duplicate.criteria[0]?.id, evaluation.criteria[0]?.id);
    assert.equal(
      await db.session.count({ where: { evalId: duplicate.id } }),
      0,
    );

    const { id: _id, ...revision } = withShell;

    const revised = await evals.save(
      { ...revision, prompt: "A revised prompt", responseOverrides: [] },
      evaluation.id,
    );

    assert.equal(revised.revision, withShell.revision + 1);
    assert.deepEqual(revised.responseOverrides, []);
    assert.match(JSON.stringify(saved[0]?.snapshot), /updated SDK/);

    await assert.rejects(evals.save(revision, evaluation.id), /changed/);

    assert.match(JSON.stringify(saved[0]?.snapshot), /Change the app/);

    assert.equal(
      await readFile(join(f.workspace, "app.ts"), "utf8"),
      "original",
    );

    const app = await NestFactory.create(ApplicationModule, { logger: false });

    await app.init();
    try {
      const controller = app.get(SessionsController);
      const s = saved[0];
      assert.ok(s);
      const capture = {
        callId: "c1",
        route: "web_fetch",
        target: rule.target,
        args: {},
        original: "old SDK",
      };
      assert.deepEqual((await controller.get(s.id)).behaviorDrift, [drift]);
      assert.equal((await controller.get(s.id)).interceptedCalls, 1);
      await sessions.event(s.id, "response", capture);
      await sessions.event(s.id, "response", {
        ...capture,
        callId: "error",
        error: "Failed to apply rule",
      });
      await sessions.event(s.id, "judge", { ...capture, ruleId: rule.id });
      for (const callId of ["c1", "c1", "c2"])
        await sessions.event(s.id, "response", {
          ...capture,
          callId,
          ruleId: rule.id,
          delivered: "updated SDK",
        });
      assert.equal((await controller.get(s.id)).interceptedCalls, 3);
      assert.deepEqual(
        (await sessions.modifiedResponses(s.id)).map((call) => call.callId),
        [drift.callId, "c1", "c2"],
      );
      const history = await controller.history();
      assert.ok(history.some((row) => row.id === s.id));
      const summaries = await controller.historyPage(s.id);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]?.interceptedCalls, 3);
      assert.deepEqual(summaries[0]?.criteria, evaluation.criteria);
      assert.ok(!("agentResult" in (summaries[0] ?? {})));
      const listed = await controller.list(evaluation.id);
      for (const item of saved) {
        assert.equal(
          listed.find((row) => row.id === item.id)?.interceptedCalls,
          item.id === s.id ? 3 : 1,
        );
      }
    } finally {
      await app.close();
    }
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
