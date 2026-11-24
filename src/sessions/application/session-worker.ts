import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AnalyticsService } from "../../analytics/analytics-service.js";
import { observedHarness } from "../../analytics/observed-harness.js";
import { McpAuthorization } from "../../catalog/application/mcp-authorization.js";
import { CredentialStore, providers } from "../../credentials/provider.js";
import type { ModelSettingsData } from "../../evaluations/domain/model-settings.js";
import type {
  HarnessInput,
  HarnessResult,
} from "../../harnesses/domain/harness.js";
import { HarnessRegistry } from "../../harnesses/domain/harness-registry.js";
import { redactEvent } from "../../harnesses/domain/redact-secrets.js";
import { ModelRewriter } from "../../overrides/application/model-rewriter.js";
import type { ResponseCapture } from "../../overrides/domain/response-override.js";
import type { ExecutionSnapshot } from "../domain/execution-snapshot.js";
import { judgingPrompt } from "../domain/judging-prompt.js";
import type { Session } from "../domain/session.js";
import { SessionRepository } from "../domain/session-repository.js";
import { WorkspaceRuntimeFactory } from "../domain/workspace-runtime.js";
import { WorkspaceStore } from "../domain/workspace-store.js";
import { judgeSession } from "./judge-session.js";

@Injectable()
export class SessionWorker {
  constructor(
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(WorkspaceStore) private readonly artifacts: WorkspaceStore,
    @Inject(HarnessRegistry) private readonly harnesses: HarnessRegistry,
    @Inject(CredentialStore) private readonly keys: CredentialStore,
    @Inject(WorkspaceRuntimeFactory)
    private readonly runtimes: WorkspaceRuntimeFactory,
    @Optional()
    @Inject(AnalyticsService)
    private readonly analytics?: AnalyticsService,
    @Optional()
    @Inject(McpAuthorization)
    private readonly mcpAuthorization?: McpAuthorization,
    @Inject(ModelRewriter) private readonly rewriter?: ModelRewriter,
  ) {}

  async execute(
    session: Session,
    snapshot: ExecutionSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const started = new Date();
    // Restore inputs, execute one harness, judge only its evidence, then persist the final state.
    const root = await mkdtemp(join(tmpdir(), "stunthog-session-"));
    let agent: HarnessResult | undefined;
    let judge: HarnessResult | undefined;
    let agentRuntime:
      | Awaited<ReturnType<WorkspaceRuntimeFactory["create"]>>
      | undefined;
    let judgeRuntime:
      | Awaited<ReturnType<WorkspaceRuntimeFactory["create"]>>
      | undefined;

    try {
      signal.throwIfAborted();
      session.start();
      await this.sessions.save(session);
      await this.artifacts.restore(session.id, root, "input");

      const workspace = join(root, "workspace");
      const adapter = this.harnesses.get(session.model.harness);

      await mkdir(workspace, { recursive: true });
      agentRuntime = await this.runtimes.create(
        snapshot.environment,
        root,
        workspace,
        signal,
        adapter.id,
      );

      const skills = snapshot.skills.map((_, index) =>
        join(root, "skills", String(index)),
      );
      if (adapter.id !== "pi") {
        const { cp } = await import("node:fs/promises");
        const skillRoot =
          adapter.id === "claude"
            ? ".claude/skills"
            : adapter.id === "opencode"
              ? ".opencode/skills"
              : ".agents/skills";

        for (const [index, path] of skills.entries())
          await cp(path, join(workspace, skillRoot, `eval-${index}`), {
            recursive: true,
          });
      }

      const agentHarness = this.analytics
        ? observedHarness(
            adapter,
            this.analytics.captureAi,
            session.id,
            "agent",
          )
        : adapter;
      agent = await agentHarness.run(
        await this.input(
          session,
          session.model,
          root,
          workspace,
          skills,
          snapshot.evaluation.prompt,
          snapshot,
          signal,
          "agent",
          agentRuntime,
        ),
      );
      await this.artifacts.capture(session.id, workspace, "output");
      await this.artifacts.capture(
        session.id,
        join(root, "agent"),
        "agent-runtime",
      );
      await agentRuntime.close();
      agentRuntime = undefined;
      await this.sessions.save(session, agent);
      signal.throwIfAborted();
      session.beginJudging(
        agent.status === "failed"
          ? (agent.error ?? "The agent execution failed.")
          : null,
      );
      await this.sessions.save(session, agent);

      const piMessages =
        adapter.id === "pi"
          ? await readFile(join(root, "agent", "messages.json"), "utf8").catch(
              () => undefined,
            )
          : undefined;
      const evidence =
        piMessages ??
        JSON.stringify(await this.sessions.events(session.id, "agent"));
      const judgeWorkspace = join(root, "judge-workspace");
      const intercepts = await this.sessions.modifiedResponses(session.id);
      const interceptedIds = intercepts.map((call) => call.callId);

      judgeRuntime = await this.runtimes.create(
        null,
        root,
        judgeWorkspace,
        signal,
        snapshot.evaluation.judge.harness,
      );
      const judgeInput = await this.input(
        session,
        snapshot.evaluation.judge,
        root,
        judgeWorkspace,
        [],
        judgingPrompt(snapshot, agent, evidence, intercepts),
        snapshot,
        signal,
        "judge",
        judgeRuntime,
      );

      const judgeHarness = this.harnesses.get(
        snapshot.evaluation.judge.harness,
      );
      judge = await judgeSession(
        this.analytics
          ? observedHarness(
              judgeHarness,
              this.analytics.captureAi,
              session.id,
              "judge",
            )
          : judgeHarness,
        judgeInput,
        snapshot.evaluation.criteria.map((criterion) => criterion.id),
        interceptedIds,
      );

      await this.artifacts.capture(
        session.id,
        join(root, "judge"),
        "judge-runtime",
      );

      if (judge.status !== "completed")
        throw new Error(judge.error ?? "The judge failed.");

      await judgeRuntime.close();
      judgeRuntime = undefined;

      signal.throwIfAborted();
      session.complete(JSON.parse(judge.text), interceptedIds);
      await this.sessions.save(session, agent, judge);
    } catch (error) {
      this.analytics?.exception(error, "session_execute");
      if (!["cancelled", "completed", "failed"].includes(session.status)) {
        if (signal.aborted) session.cancel();
        else
          session.fail(error instanceof Error ? error.message : String(error));
      }

      await this.sessions.save(session, agent, judge);
    } finally {
      await Promise.allSettled([
        ...(agentRuntime ? [agentRuntime.close()] : []),
        ...(judgeRuntime ? [judgeRuntime.close()] : []),
      ]);

      for (const phase of session.status === "completed"
        ? []
        : ["agent", "judge"]) {
        await this.artifacts
          .capture(session.id, join(root, phase), `${phase}-runtime`)
          .catch((error: unknown) =>
            this.sessions.event(session.id, phase, {
              type: "artifact_error",
              message: String(error),
            }),
          );
      }
      await rm(root, { recursive: true, force: true });
      const result = session.snapshot();
      const decisions = result.judgment?.decisions ?? [];

      this.analytics?.capture("agent session finished", {
        session_id: session.id,
        harness: session.model.harness,
        model: session.model.model,
        status: session.status,
        criteria_passed: decisions.filter((decision) => decision.passed).length,
        criteria_total: decisions.length,
      });
      this.analytics?.info("Agent session finished", {
        harness: session.model.harness,
        status: session.status,
      });
      this.analytics?.captureAi(
        "$ai_trace",
        {
          $ai_trace_id: session.id,
          $ai_session_id: null,
          $ai_span_name: "Evaluation session",
          $ai_latency: (Date.now() - started.getTime()) / 1000,
          $ai_is_error: session.status === "failed",
          status: session.status,
          evaluation_id: snapshot.evaluation.id,
          harness: session.model.harness,
          criteria_passed: decisions.filter((decision) => decision.passed)
            .length,
          criteria_total: snapshot.evaluation.criteria.length,
        },
        started,
      );
    }
  }

  private async input(
    session: Session,
    settings: ModelSettingsData,
    root: string,
    workspace: string,
    skills: string[],
    prompt: string,
    snapshot: ExecutionSnapshot,
    signal: AbortSignal,
    phase: "agent" | "judge",
    runtime: Awaited<ReturnType<WorkspaceRuntimeFactory["create"]>>,
  ): Promise<HarnessInput> {
    const adapter = this.harnesses.get(settings.harness);
    const apiKey = await this.keys.read(adapter.provider);
    const directory = join(root, phase);

    await mkdir(directory, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const servers =
      phase === "judge"
        ? (snapshot.judgeMcps ?? []).map((mcp) => ({
            ...mcp,
            allowedTools: mcp.allowedTools ?? [],
          }))
        : snapshot.mcps;
    const mcps = await Promise.all(
      servers.map(async (server) => ({
        ...server,
        accessToken: server.url
          ? await this.mcpAuthorization?.accessToken(server.url)
          : undefined,
      })),
    );
    const secrets = [
      apiKey,
      ...Object.values(providers).map((name) => process.env[name]),
      ...mcps.map((server) => server.accessToken),
    ].filter((secret): secret is string => Boolean(secret));

    return {
      directory,
      workspace,
      skills,
      prompt,
      model: settings.model,
      settings,
      effort: settings.effort,
      maxTurns: settings.maxTurns,
      timeout: settings.timeoutSeconds,
      signal,
      runtime,
      label: phase === "judge" ? "judge" : session.id,
      tools:
        phase === "judge"
          ? []
          : [
              "read",
              "write",
              "edit",
              "bash",
              "grep",
              "find",
              "ls",
              "web_fetch",
            ],
      ...(apiKey ? { apiKey } : {}),
      ...(phase === "agent" && snapshot.persona
        ? {
            persona: `${snapshot.persona.title}\n${snapshot.persona.description}`,
          }
        : {}),
      // The judge never gets built-in tools. It gets only the MCP servers selected for the judge.
      // Judge MCP tools are auto-approved, so the judge sees only the tools the author allowed.
      mcps,
      ...(phase === "agent" && {
        responseOverrides: snapshot.evaluation.responseOverrides ?? [],
        ...(this.rewriter && {
          rewrite: this.rewriter.forSession(secrets, signal),
        }),
        onToolResponse: (capture: ResponseCapture) =>
          this.sessions.event(
            session.id,
            "response",
            redactEvent(capture, secrets),
          ),
      }),
      onRawEvent: (event) =>
        this.sessions.event(session.id, phase, redactEvent(event, secrets)),
    };
  }
}
