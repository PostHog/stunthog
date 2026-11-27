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
import { HarnessRegistry } from "../src/harnesses/domain/harness-registry.js";
import { ApiErrorFilter } from "../src/http/api-error-filter.js";
import { SessionsController } from "../src/http/sessions-controller.js";
import { Database } from "../src/infrastructure/database.js";
import { migrateDatabase } from "../src/infrastructure/migrations.js";
import type { ResponseRule } from "../src/overrides/domain/response-override.js";
import {
  PreviewModel,
  PreviewSession,
} from "../src/sessions/application/preview-session.js";
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
    const agentPrompts = new Map<string, string>();
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
          agentPrompts.set(input.label, input.prompt);
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
    const batch = await starter.start(evaluation.id, undefined, true);

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

    const { id: subsetId, ...copy } = duplicate;
    const multi = await evals.save(
      {
        ...copy,
        models: [model, { ...model, model: "unselected-model" }],
      },
      subsetId,
    );
    for (const selection of [
      { revision: multi.revision - 1, models: [0] },
      { revision: multi.revision, models: [2] },
    ])
      await assert.rejects(
        starter.start(subsetId, selection),
        /Reload the evaluation/,
      );
    const subset = await starter.start(subsetId, {
      revision: multi.revision,
      models: [0],
    });
    await starter.onModuleDestroy();
    assert.equal(subset.sessionIds.length, model.count);
    assert.deepEqual(
      (await evals.get(subsetId)).snapshot().models,
      multi.models,
    );
    const subsetSessions = await db.session.findMany({
      where: { batchId: subset.batchId },
      select: { model: true },
    });
    assert.ok(subsetSessions.every((session) => session.model === model.model));

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

    // biome-ignore lint/correctness/useHookAtTopLevel: This method configures the Nest server.
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
    try {
      const controller = app.get(SessionsController);
      // Exercise the browser upload route with a judge that cannot run an agent or contact a provider.
      const judgePrompts: string[] = [];
      const importJudge: Harness = {
        ...adapter,
        run: async (input) => {
          assert.equal(input.label, "judge");
          judgePrompts.push(input.prompt);
          const criteria = /^Criteria: (.+)$/m.exec(input.prompt)?.[1];
          assert.ok(criteria);
          return {
            label: input.label,
            status: "completed",
            durationMs: 1,
            text: JSON.stringify({
              summary: "Verified the version",
              decisions: (JSON.parse(criteria) as { id: string }[]).map(
                (c) => ({
                  criterionId: c.id,
                  passed: true,
                  feedback: "The tool returned version 1.",
                }),
              ),
            }),
            usage: {
              input: 2,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              total: 3,
              costUsd: 0.01,
            },
          };
        },
      };
      Object.assign(app.get(HarnessRegistry), {
        catalog: harnesses.catalog,
        get: () => importJudge,
      });
      await app.listen(0, "127.0.0.1");
      const uploadUrl = `${await app.getUrl()}/api/evals/${multi.id}/session-file`;
      const upload = (body: FormData) =>
        fetch(uploadUrl, { method: "POST", body });
      const before = await db.session.count();
      const form = new FormData();
      form.set("memo", "A private memo");
      assert.equal((await upload(form)).status, 400);
      form.set("file", new Blob(["invalid"]), "log.jsonl");
      assert.equal((await upload(form)).status, 400);
      assert.equal(await db.session.count(), before);
      const recorded = {
        type: "assistant",
        message: {
          role: "assistant",
          model: "recorded-model",
          content: [
            { type: "text", text: "The version is 1. test-secret" },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "hog version" },
            },
          ],
        },
      };
      form.set("file", new Blob([JSON.stringify(recorded)]), "log.jsonl");
      const response = await upload(form);
      const report = (await response.json()) as {
        sessionIds: string[];
        message?: string;
      };
      assert.equal(response.status, 201, report.message);
      assert.equal(report.sessionIds.length, 1);
      const importedId = report.sessionIds[0];
      assert.ok(importedId);
      for (let attempt = 0; attempt < 200; attempt++) {
        const row = await controller.get(importedId);
        if (!["queued", "running", "judging"].includes(row.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(judgePrompts.length, 1);
      assert.ok(judgePrompts[0]?.includes("The version is 1. [redacted]"));
      assert.doesNotMatch(judgePrompts[0] ?? "", /A private memo|test-secret/);
      const imported = await controller.get(importedId);
      assert.equal(imported.status, "completed", imported.error ?? "");
      assert.equal(imported.agentResult, null);
      assert.equal(imported.decisions.length, multi.criteria.length);
      assert.equal(imported.totalTokens, 3);
      assert.equal(imported.costUsd, 0.01);
      assert.equal(imported.harness, "claude");
      assert.equal(imported.model, "recorded-model");
      assert.equal(imported.origin, "organic");
      assert.equal(
        (await controller.historyPage(importedId))[0]?.memo,
        "A private memo",
      );
      assert.deepEqual(
        (await controller.files(importedId))
          .filter((f) => f.phase !== "judge-runtime")
          .map((f) => [f.phase, f.path]),
        [["session-file", "log.jsonl"]],
      );
      assert.equal(
        await db.toolCall.count({
          where: { sessionId: importedId, phase: "agent", name: "Bash" },
        }),
        1,
      );
      const createUrl = `${await app.getUrl()}/api/evals/with-session-files`;
      const createForm = new FormData();
      const definition = {
        title: "Organic installation",
        prompt: "Install the CLI",
        criteria: [{ description: "Reports version 1" }],
        models: [],
        judge: model,
      };
      createForm.set("evaluation", JSON.stringify(definition));
      createForm.set(
        "memos",
        JSON.stringify(["First installation", "Second installation"]),
      );
      const sample = new Blob([JSON.stringify(recorded)]);
      createForm.append("files", sample, "first.jsonl");
      createForm.append("files", new Blob(["invalid"]), "second.jsonl");
      const evalCount = await db.eval.count();
      assert.equal(
        (await fetch(createUrl, { method: "POST", body: createForm })).status,
        400,
      );
      assert.equal(await db.eval.count(), evalCount);
      assert.equal(await db.session.count(), before + 1);
      createForm.delete("files");
      createForm.append("files", sample, "first.jsonl");
      createForm.append("files", sample, "second.jsonl");
      const createResponse = await fetch(createUrl, {
        method: "POST",
        body: createForm,
      });
      const created = (await createResponse.json()) as {
        id: string;
        models: unknown[];
        message?: string;
      };
      assert.equal(createResponse.status, 201, created.message);
      assert.deepEqual(created.models, []);
      const loaded = await controller.list(created.id);
      assert.deepEqual(loaded.map((s) => s.memo).sort(), [
        "First installation",
        "Second installation",
      ]);
      assert.ok(
        loaded.every(
          (s) => s.origin === "organic" && s.batchId === loaded[0]?.batchId,
        ),
      );
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          (await controller.list(created.id)).every(
            (s) => s.status === "completed",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        (await controller.list(created.id)).every(
          (s) => s.status === "completed" && s.decisions[0]?.passed,
        ),
      );
      const runUrl = `${await app.getUrl()}/api/evals/${created.id}/run`;
      const emptyRun = await fetch(runUrl, { method: "POST" });
      assert.equal(emptyRun.status, 400);
      assert.match(await emptyRun.text(), /Add a model/);
      assert.equal((await controller.list(created.id)).length, 2);
      assert.deepEqual(
        new Set((await controller.list(multi.id)).map((s) => s.origin)),
        new Set(["synthetic", "organic"]),
      );
      await migrateDatabase(data);
      const reopened = new Database();
      try {
        const persisted = await reopened.session.findUniqueOrThrow({
          where: { id: importedId },
        });
        assert.equal(persisted.memo, "A private memo");
        assert.equal(persisted.origin, "organic");
      } finally {
        await reopened.$disconnect();
      }
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
      const edited = await controller.events(s.id, "0", "intercepts");
      assert.ok(edited.length > 0);
      assert.ok(
        edited.every(
          (row) => row.phase === "response" && typeof row.event === "object",
        ),
      );
      assert.doesNotThrow(() => JSON.stringify(edited));
      const judgeEvents = await controller.events(s.id, "0", "judge");
      assert.ok(judgeEvents.every((row) => row.phase === "judge"));
      for (const item of saved) {
        assert.equal(
          listed.find((row) => row.id === item.id)?.interceptedCalls,
          item.id === s.id ? 3 : 1,
        );
      }

      // A branch owns its inputs and judgment, even after the source folder and evaluation change.
      Object.assign(app.get(HarnessRegistry), harnesses);
      const root = saved[0];
      assert.ok(root);
      const prefix = `${await app.getUrl()}/api/sessions/`;
      const post = async (path: string, body: unknown) =>
        fetch(prefix + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      let previews = 0;
      const modelPort: PreviewModel = {
        models: async () => [{ id: "test-model", name: "Test model" }],
        next: async (provider, selected, messages) => {
          previews++;
          assert.equal(provider, "openrouter");
          assert.equal(selected, "test-model");
          assert.equal(messages.at(-1)?.content, "Try the CLI");
          assert.ok(!JSON.stringify(messages).includes("Wrote updated SDK"));
          return {
            action: { kind: "tool", text: 'bash {"command":"hog --version"}' },
            model: selected,
            tokens: 9,
            cost: null,
          };
        },
      };
      Object.assign(app.get(PreviewModel), modelPort);
      const edit = {
        field: "text",
        entryId: "initial-prompt",
        replacement: "Try the CLI",
      };
      const n = await db.session.count();
      const preview = await post(`${root.id}/previews`, {
        edit,
        model: "test-model",
      });
      assert.equal(preview.status, 201);
      assert.equal(
        ((await preview.json()) as { action: { kind: string } }).action.kind,
        "tool",
      );
      assert.equal(previews, 1);
      assert.equal(await db.session.count(), n);
      const importedPoint = await app.get(PreviewSession).point(
        importedId,
        (
          await import("../src/sessions/domain/transcript/transcript.js")
        ).buildTranscript(
          await db.sessionEvent.findMany({
            where: { sessionId: importedId, phase: "agent" },
            orderBy: { sequence: "asc" },
          }),
        )[0]?.id ?? "",
      );
      assert.equal(importedPoint.canBranch, false);
      const key = crypto.randomUUID();
      const request = {
        entryId: "initial-prompt",
        prompt: "Run the CLI",
        confirmLiveTools: true,
        requestId: key,
      };
      assert.equal(
        (
          await post(`${root.id}/branches`, {
            ...request,
            confirmLiveTools: false,
          })
        ).status,
        400,
      );
      assert.equal(
        (await post(`${root.id}/branches`, { ...request, entryId: "missing" }))
          .status,
        400,
      );
      await writeFile(join(f.workspace, "app.ts"), "source has changed");
      const started = await post(`${root.id}/branches`, request);
      assert.equal(
        started.status,
        201,
        started.status === 201 ? "" : await started.text(),
      );
      const { id } = (await started.json()) as { id: string };
      const repeated = await post(`${root.id}/branches`, request);
      assert.deepEqual(await repeated.json(), { id });
      assert.deepEqual(
        await (await fetch(`${prefix + id}/starting-point`)).json(),
        {
          kind: "user-message",
          before: evaluation.prompt,
          after: request.prompt,
        },
      );
      for (let i = 0; i < 300; i++) {
        const row = await controller.get(id);
        if (!["queued", "running", "judging"].includes(row.status)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const child = await controller.get(id);
      assert.equal(child.parentSessionId, root.id);
      assert.equal(child.rootSessionId, root.id);
      assert.equal(child.batchId, root.batchId);
      assert.equal(child.status, "completed", child.error ?? "");
      assert.equal(child.costUsd, 0.02);
      assert.equal(child.decisions.length, 1);
      assert.equal((await controller.get(root.id)).costUsd, 0.02);
      assert.match(JSON.stringify(child.snapshot), /Run the CLI/);
      const family = await controller.branches(id);
      assert.deepEqual(
        family.map((s) => s.id),
        [root.id, id],
      );
      assert.equal(family[1]?.prompt, "Run the CLI");
      assert.equal(family[1]?.assessed, 1);
      assert.ok(
        !(await controller.list(root.evalId)).some((row) => row.id === id),
      );
      assert.equal(
        (await controller.list(root.evalId)).find((row) => row.id === root.id)
          ?.branchCount,
        1,
      );
      assert.equal(
        await readFile(join(f.workspace, "app.ts"), "utf8"),
        "source has changed",
      );
      const grand = await post(`${id}/branches`, {
        ...request,
        prompt: "Read the version",
        requestId: crypto.randomUUID(),
      });
      assert.equal(grand.status, 201);
      const grandId = ((await grand.json()) as { id: string }).id;
      assert.equal((await controller.get(grandId)).rootSessionId, root.id);
      assert.equal((await controller.get(grandId)).parentSessionId, id);
      const branchIds = new Set([id, grandId]);
      for (const rows of [
        await controller.list(),
        await controller.list(root.evalId),
        await controller.history(),
        await controller.historyPage([root.id, id, grandId].join(",")),
      ]) {
        assert.ok(rows.some((row) => row.id === root.id));
        assert.ok(rows.every((row) => !branchIds.has(row.id)));
      }
      assert.equal((await controller.historyPage(root.id))[0]?.branchCount, 2);
      const reopenedBranches = new Database();
      try {
        const branch = await reopenedBranches.session.findUniqueOrThrow({
          where: { id },
          select: {
            rootSessionId: true,
            promptCheckpointReady: true,
            artifacts: { where: { phase: "input", path: "workspace/app.ts" } },
          },
        });
        assert.equal(branch.rootSessionId, root.id);
        assert.equal(branch.promptCheckpointReady, true);
        assert.ok(branch.artifacts[0]);
        assert.notEqual(
          Buffer.from(branch.artifacts[0].content).toString(),
          "source has changed",
        );
      } finally {
        await reopenedBranches.$disconnect();
      }

      // Older recordings can start an independent harness with a revised tool result.
      const historical = saved[1];
      assert.ok(historical);
      await db.session.update({
        where: { id: historical.id },
        data: { promptCheckpointReady: false },
      });
      await sessions.event(historical.id, "agent", {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "version",
        args: { command: "hog --version" },
      });
      await sessions.event(historical.id, "agent", {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "version",
        result: { content: [{ type: "text", text: "stale version" }] },
      });
      await sessions.event(historical.id, "agent", {
        type: "assistant",
        message: { content: "Later parent reply" },
      });
      const full = {
        edit: {
          entryId: "tool-version",
          field: "result",
          replacement: "CLI version 22",
        },
        model: "test-model",
        requestId: crypto.randomUUID(),
        confirmLiveTools: true,
      };
      const url = `${historical.id}/branches`;
      const rejectedCount = await db.session.count();
      assert.equal(
        (await post(url, { ...full, model: "unknown" })).status,
        400,
      );
      assert.equal(
        (
          await post(url, {
            ...full,
            edit: { ...full.edit, replacement: "test-secret" },
          })
        ).status,
        400,
      );
      assert.equal(await db.session.count(), rejectedCount);
      const launched = await post(url, full);
      assert.equal(
        launched.status,
        201,
        launched.status === 201 ? "" : await launched.text(),
      );
      const branchId = ((await launched.json()) as { id: string }).id;
      assert.deepEqual(
        await (await fetch(`${prefix + branchId}/starting-point`)).json(),
        {
          kind: "tool-result",
          before: "stale version",
          after: "CLI version 22",
        },
      );
      assert.deepEqual(await (await post(url, full)).json(), { id: branchId });
      assert.equal(
        (
          await post(url, {
            ...full,
            edit: { ...full.edit, replacement: "Different" },
          })
        ).status,
        400,
      );
      for (let i = 0; i < 300; i++) {
        const branch = await controller.get(branchId);
        if (!["queued", "running", "judging"].includes(branch.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ran = await controller.get(branchId);
      assert.equal(ran.status, "completed", ran.error ?? "");
      assert.equal(ran.harness, historical.harness);
      assert.equal(ran.parentSessionId, historical.id);
      assert.equal(
        (await controller.branches(historical.id)).find(
          (n) => n.id === branchId,
        )?.change,
        full.edit.replacement,
      );
      assert.equal(ran.decisions.length, 1);
      assert.match(agentPrompts.get(branchId) ?? "", /CLI version 22/);
      assert.doesNotMatch(
        agentPrompts.get(branchId) ?? "",
        /Later parent reply|stale version/,
      );
      assert.match(
        JSON.stringify(await sessions.background(branchId)),
        /CLI version 22/,
      );
      assert.equal(
        (await controller.list(historical.evalId)).some(
          (s) => s.id === branchId,
        ),
        false,
      );
      assert.ok(
        (await controller.files(branchId)).some(
          (f) => f.phase === "output" && f.path === "app.ts",
        ),
      );

      // An import supplies conversation history and has no original input workspace.
      const organic = await app.get(PreviewSession).prepareFullSession(
        importedId,
        {
          entryId: `message-1-text-0`,
          field: "text",
          replacement: "The CLI is missing.",
        },
        "claude-test",
      );
      assert.equal(organic.start.settings.harness, "claude");
      assert.equal(organic.start.workspace, "empty");
      assert.match(
        JSON.stringify(organic.start.background),
        /The CLI is missing/,
      );
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
