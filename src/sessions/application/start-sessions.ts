import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { z } from "zod";
import { AnalyticsService } from "../../analytics/analytics-service.js";
import {
  type ResourceLists,
  ResourceRepository,
} from "../../catalog/domain/resource-repository.js";
import {
  CredentialStore,
  type Provider,
  providers,
} from "../../credentials/provider.js";
import type {
  Evaluation,
  EvaluationData,
} from "../../evaluations/domain/evaluation.js";
import { EvaluationRepository } from "../../evaluations/domain/evaluation-repository.js";
import { HarnessRegistry } from "../../harnesses/domain/harness-registry.js";
import { redactText } from "../../harnesses/domain/redact-secrets.js";
import { SettingsService } from "../../settings/application/settings-service.js";
import { DEFAULT_DOCKERFILE } from "../domain/default-dockerfile.js";
import type {
  EditedSessionStart,
  ExecutionSnapshot,
} from "../domain/execution-snapshot.js";
import { Session } from "../domain/session.js";
import { parseSessionFile, type SessionFile } from "../domain/session-file.js";
import { SessionRepository } from "../domain/session-repository.js";
import { WorkspaceStore } from "../domain/workspace-store.js";
import { SessionQueue } from "./session-queue.js";
import { SessionWorker } from "./session-worker.js";

@Injectable()
export class StartSessions implements OnModuleDestroy {
  private readonly active = new Map<
    string,
    {
      session: Session;
      controller: AbortController;
      task: Promise<void> | undefined;
    }
  >();

  constructor(
    @Inject(EvaluationRepository) private readonly evals: EvaluationRepository,
    @Inject(ResourceRepository) private readonly catalog: ResourceRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(WorkspaceStore) private readonly artifacts: WorkspaceStore,
    @Inject(SessionWorker) private readonly worker: SessionWorker,
    @Inject(HarnessRegistry) private readonly harnesses: HarnessRegistry,
    @Inject(CredentialStore) private readonly keys: CredentialStore,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SessionQueue) private readonly queue: SessionQueue,
    @Optional()
    @Inject(AnalyticsService)
    private readonly analytics?: AnalyticsService,
  ) {}

  async loadFiles(
    target: string | Evaluation,
    files: { filename: string; content: string; memo?: string }[],
  ) {
    if (!files.length) throw new Error("Choose a session file.");
    const secrets = await this.providerSecrets();
    const recordings = files.map(({ filename, content, memo }, index) => {
      try {
        return parseSessionFile(filename, redactText(content, secrets), memo);
      } catch (error) {
        throw new Error(
          `Session file ${index + 1}. ${error instanceof Error ? error.message : "Cannot read this session file."}`,
        );
      }
    });
    return this.schedule(target, undefined, recordings);
  }

  start(
    evalId: string,
    selection?: { revision: number; models: number[] },
    recordCheckpoints = false,
  ) {
    return this.schedule(evalId, selection, undefined, recordCheckpoints);
  }

  private async schedule(
    target: string | Evaluation,
    selection?: { revision: number; models: number[] },
    recordings?: SessionFile[],
    recordCheckpoints = false,
  ) {
    const evaluation =
      typeof target === "string" ? await this.evals.find(target) : target;

    if (!evaluation) throw new NotFoundException("Evaluation not found.");

    const data = evaluation.snapshot();
    if (
      selection &&
      (selection.revision !== data.revision ||
        !selection.models.length ||
        selection.models.some(
          (index) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= data.models.length,
        ))
    )
      throw new Error("Reload the evaluation and select models for this run.");
    const models = recordings
      ? []
      : selection
        ? data.models.filter((_, index) => selection.models.includes(index))
        : data.models;
    if (!recordings && !models.length)
      throw new Error("Add a model before you start a synthetic session.");
    this.queue.setConcurrency((await this.settings.get()).sessionConcurrency);

    await this.checkModels(data, models);
    const resources = await this.catalog.list();
    const environment =
      resources.environments.find((entry) => entry.id === data.environmentId) ??
      null;
    const persona =
      resources.personas.find((entry) => entry.id === data.personaId) ?? null;
    const snapshot: ExecutionSnapshot = {
      evaluation: recordings ? { ...data, responseOverrides: [] } : data,
      environment: recordings
        ? null
        : environment?.executionMode === "docker" &&
            !environment.dockerfilePath &&
            !environment.dockerfileContent
          ? { ...environment, dockerfileContent: DEFAULT_DOCKERFILE }
          : environment,
      persona: recordings ? null : persona,
      skills: recordings
        ? []
        : await resolveSkills(resources.skills, data.skillIds),
      mcps: recordings ? [] : resolveMcps(resources.mcps, data.mcpIds),
      judgeSkills: await resolveSkills(resources.skills, data.judgeSkillIds),
      judgeMcps: resolveMcps(resources.mcps, data.judgeMcpIds).map((mcp) => ({
        ...mcp,
        allowedTools: data.judgeMcpTools[mcp.id] ?? [],
      })),
    };
    const batchId = randomUUID();
    const created: Session[] = [];

    try {
      if (recordings) {
        const entries = recordings.map((file) => ({
          session: new Session(data, file.model),
          file,
        }));
        await this.sessions.insertRecordings(
          entries,
          snapshot,
          batchId,
          typeof target === "string" ? undefined : data,
        );
        created.push(...entries.map((entry) => entry.session));
      } else {
        for (const model of models) {
          for (let index = 0; index < model.count; index++) {
            const session = new Session(data, model);

            await this.sessions.insert(
              session,
              this.runSnapshot(session, snapshot, recordCheckpoints),
              batchId,
            );
            created.push(session);
          }
        }
        await this.artifacts.prepare(
          created.map((session) => session.id),
          snapshot,
        );
      }
    } catch (error) {
      for (const session of created) {
        session.fail(String(error));
        await this.sessions.save(session);
      }

      throw error;
    }

    for (const session of created)
      this.enqueue(
        session,
        this.runSnapshot(session, snapshot, recordCheckpoints),
      );

    this.analytics?.capture("evaluation run started", {
      evaluation_id: data.id,
      origin: recordings ? "organic" : "synthetic",
      batch_id: batchId,
      session_count: created.length,
      environment_mode: snapshot.environment?.executionMode ?? "local",
      judge_skill_count: data.judgeSkillIds.length,
      judge_mcp_count: data.judgeMcpIds.length,
    });
    this.analytics?.info("Evaluation run started", {
      session_count: created.length,
      environment_mode: snapshot.environment?.executionMode ?? "local",
    });

    return { batchId, sessionIds: created.map((session) => session.id) };
  }

  private async checkModels(
    data: EvaluationData,
    models: EvaluationData["models"],
  ) {
    // Validate the complete batch before creating records or spending provider credits.
    const catalog = await this.harnesses.catalog();

    for (const settings of [...models, data.judge]) {
      const harness = catalog.find((entry) => entry.id === settings.harness);

      if (!harness?.installed)
        throw new Error(
          `Install the ${settings.harness} harness before running this evaluation.`,
        );
      if (!harness.models.some((model) => model.id === settings.model))
        throw new Error(
          `Choose a supported ${settings.harness} model: ${settings.model}`,
        );
      if (
        !(await this.keys.read(this.harnesses.get(settings.harness).provider))
      )
        throw new Error(
          `Add the ${harness.provider} API key before running this evaluation.`,
        );
    }

    const judgeHarness = catalog.find(
      (entry) => entry.id === data.judge.harness,
    );

    if (data.judgeMcpIds.length && !judgeHarness?.judgeSupportsMcp)
      throw new Error(
        `The ${judgeHarness?.title ?? data.judge.harness} judge cannot use MCP servers. Choose another judge harness or remove the judge MCP servers.`,
      );

    if (data.judgeMcpIds.some((id) => !data.judgeMcpTools[id]?.length))
      throw new Error(
        "Name at least one tool the judge may call from each judge MCP server.",
      );
  }

  private runSnapshot(
    session: Session,
    snapshot: ExecutionSnapshot,
    record: boolean,
  ): ExecutionSnapshot {
    if ("origin" in session.model) return snapshot;
    return record
      ? { ...snapshot, promptCheckpoint: { ...session.model } }
      : { ...snapshot, agentSettings: { ...session.model } };
  }

  private async providerSecrets() {
    const stored = await Promise.all(
      (Object.keys(providers) as Provider[]).map((p) => this.keys.read(p)),
    );
    return [
      ...stored,
      ...Object.values(providers).map((key) => process.env[key]),
    ].filter((key): key is string => !!key);
  }

  async startEdited(
    parentId: string,
    entryId: string,
    requestId: string,
    prepared: { start: EditedSessionStart; evaluation: EvaluationData },
  ) {
    const { start, evaluation } = prepared;
    const payload = JSON.stringify([start.task, start.background]);
    if ((await this.providerSecrets()).some((key) => payload.includes(key)))
      throw new Error("Remove the provider key from the session background.");
    await this.checkModels(evaluation, [start.settings]);
    return this.branch(parentId, entryId, start, requestId);
  }

  async branch(
    parentId: string,
    entryId: string,
    start: string | EditedSessionStart,
    requestId: string,
  ) {
    this.queue.setConcurrency((await this.settings.get()).sessionConcurrency);
    const { id, job } = await this.sessions.branch(
      parentId,
      entryId,
      start,
      requestId,
    );
    if (job) {
      try {
        if (typeof start === "string") {
          const model = job.snapshot.promptCheckpoint;
          if (!model) throw new Error("This session has no saved checkpoint.");
          await this.checkModels(job.snapshot.evaluation, [model]);
        }
      } catch (error) {
        job.session.fail(
          error instanceof Error ? error.message : String(error),
        );
        await this.sessions.save(job.session);
        throw error;
      }
      this.enqueue(job.session, job.snapshot);
      this.analytics?.capture("session branch created", {
        session_id: id,
        parent_session_id: parentId,
      });
    }
    return { id };
  }

  private enqueue(session: Session, snapshot: ExecutionSnapshot) {
    const job = {
      session,
      controller: new AbortController(),
      task: undefined as Promise<void> | undefined,
    };

    this.active.set(session.id, job);
    job.task = this.queue
      .run(() => this.worker.execute(session, snapshot, job.controller.signal))
      .catch(async (error: unknown) => {
        this.analytics?.exception(error, "session_queue");
        if (!["failed", "cancelled", "completed"].includes(session.status))
          session.fail(String(error));

        await this.sessions.save(session);
      })
      .finally(() => this.active.delete(session.id));
  }

  cancel(id: string): void {
    const job = this.active.get(id);

    if (!job) throw new NotFoundException("No active session with this ID.");

    job.controller.abort(new Error("Cancelled by the user."));
  }

  async onModuleDestroy(): Promise<void> {
    for (const job of this.active.values())
      job.controller.abort(new Error("Application stopped."));

    await Promise.allSettled([...this.active.values()].map((job) => job.task));
  }
}

// Freeze skill text at run start so later library edits cannot change a queued session.
function resolveSkills(skills: ResourceLists["skills"], ids: string[]) {
  return Promise.all(
    ids.map(async (id) => {
      const skill = skills.find((entry) => entry.id === id);

      if (!skill) throw new Error(`Skill not found: ${id}`);

      const content =
        skill.content ??
        (skill.filePath ? await readFile(skill.filePath, "utf8") : "");

      return { title: skill.title, content };
    }),
  );
}

function resolveMcps(mcps: ResourceLists["mcps"], ids: string[]) {
  return ids.map((id) => {
    const mcp = mcps.find((entry) => entry.id === id);

    if (!mcp) throw new Error(`MCP not found: ${id}`);

    return { ...mcp, arguments: z.array(z.string()).parse(mcp.arguments) };
  });
}
