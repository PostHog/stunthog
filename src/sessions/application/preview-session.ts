import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AnalyticsService } from "../../analytics/analytics-service.js";
import type { Provider } from "../../credentials/provider.js";
import {
  ModelSettings,
  modelSettingsSchema,
} from "../../evaluations/domain/model-settings.js";
import { Database } from "../../infrastructure/database.js";
import type {
  EditedSessionStart,
  ExecutionSnapshot,
} from "../domain/execution-snapshot.js";
import { SessionRepository } from "../domain/session-repository.js";
import {
  branchEdit,
  editBackground,
  editPoint,
  fullSessionPrompt,
  type PreviewMessage,
  type PreviewReply,
  previewHistory,
  type TraceEdit,
  type TraceEditPoint,
  traceTurns,
} from "../domain/trace-edit.js";
import { withResponses } from "../domain/transcript/response-entries.js";
import { buildTranscript } from "../domain/transcript/transcript.js";
import type { TraceEvent } from "../domain/transcript/types.js";

const functionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});
type FunctionSchema = z.infer<typeof functionSchema>;

export abstract class PreviewModel {
  abstract next(
    provider: Provider,
    model: string,
    messages: PreviewMessage[],
    tools: FunctionSchema[],
    signal: AbortSignal,
  ): Promise<PreviewReply>;
  abstract models(provider: Provider): Promise<{ id: string; name: string }[]>;
}

@Injectable()
export class PreviewSession {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PreviewModel) private readonly provider: PreviewModel,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Optional()
    @Inject(AnalyticsService)
    private readonly analytics?: AnalyticsService,
  ) {}

  private async trace(sessionId: string) {
    const session = await this.db.session.findUnique({
      where: { id: sessionId },
      select: {
        snapshot: true,
        origin: true,
        model: true,
        harness: true,
        status: true,
        promptCheckpointReady: true,
      },
    });
    if (!session) throw new NotFoundException("Session not found.");
    if (["queued", "running"].includes(session.status))
      throw new Error("Wait for the agent to finish.");
    const snapshot = session.snapshot as unknown as ExecutionSnapshot;
    // Streaming deltas repeat full messages and can exceed the size of the readable trace many times over.
    const rows = await this.db.$queryRaw<
      (Omit<TraceEvent, "event"> & { phase: string; payload: string })[]
    >`
      SELECT id, sequence, phase, CAST(event AS TEXT) AS payload FROM SessionEvent
      WHERE sessionId=${sessionId} AND phase IN ('agent','response')
      AND COALESCE(json_extract(event,'$.type'),'') NOT IN (${Prisma.join(["message_update", "message_start", "turn_start", "turn_end", "agent_start", "agent_end"])})
      ORDER BY sequence`;
    const events = rows.map(({ id, sequence, phase, payload }) => ({
      id: Number(id),
      sequence: Number(sequence),
      phase,
      event: JSON.parse(payload),
    }));
    const entries = withResponses(
      buildTranscript(events.filter((e) => e.phase === "agent")),
      events.filter((e) => e.phase === "response"),
      snapshot,
    );
    const artifact = await this.db.sessionArtifact.findUnique({
      where: {
        sessionId_phase_path: {
          sessionId,
          phase: "agent-runtime",
          path: "effective.json",
        },
      },
      select: { content: true },
    });
    const effective = artifact
      ? JSON.parse(Buffer.from(artifact.content).toString())
      : {};
    const system =
      typeof effective.systemPrompt === "string"
        ? effective.systemPrompt
        : undefined;
    const tools =
      z.array(functionSchema).safeParse(effective.toolSchemas).data ?? [];
    const init = events.find(
      (row) =>
        row.phase === "agent" &&
        row.event?.type === "system" &&
        row.event?.subtype === "init",
    );
    const toolNames =
      z.array(z.string()).safeParse(effective.tools ?? init?.event.tools)
        .data ?? [];
    const builtins: Record<string, string[]> = {
      codex: ["command_execution", "file_change", "web_search"],
      opencode: ["bash", "read", "write", "edit", "grep", "glob", "webfetch"],
      claude: ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch"],
      pi: ["bash", "read", "write", "edit", "grep", "find", "ls", "web_fetch"],
    };
    const configuredNames =
      toolNames.length || session.origin === "organic"
        ? toolNames
        : (builtins[session.harness] ?? []);
    const inherited = snapshot.editedStart?.hasBackground
      ? await this.sessions.background(sessionId)
      : [];
    const prompt =
      session.origin === "synthetic"
        ? fullSessionPrompt(snapshot.evaluation.prompt, inherited)
        : undefined;
    const prefix =
      session.origin === "synthetic" &&
      session.harness !== "pi" &&
      snapshot.persona
        ? `Persona:\n${snapshot.persona.title}\n${snapshot.persona.description}\n\n`
        : "";
    return {
      session,
      snapshot,
      inherited,
      recordedSettings:
        effective.harness === session.harness
          ? modelSettingsSchema.safeParse(effective.settings).data
          : undefined,
      turns: traceTurns(entries, prompt, prefix),
      prefix,
      system,
      tools,
      toolNames: configuredNames,
      provider:
        session.harness === "claude"
          ? ("anthropic" as const)
          : session.harness === "codex"
            ? ("openai" as const)
            : ("openrouter" as const),
    };
  }

  async point(sessionId: string, entryId: string): Promise<TraceEditPoint> {
    const { session, turns, system, tools, snapshot, provider } =
      await this.trace(sessionId);
    const point = editPoint(turns, entryId);
    const models = await this.provider.models(provider);
    const candidate = session.model.replace(/^openrouter\//, "");
    const id =
      provider === "openrouter"
        ? candidate
        : candidate.replace(new RegExp(`^${provider}/`), "");
    return {
      harness: session.harness,
      workspace:
        snapshot.editedStart?.workspace ??
        (session.origin === "organic" ? "empty" : "initial"),
      text: point.text,
      sequence: point.entry.sequence,
      toolName: point.toolName,
      recordedFollowUp: point.recordedFollowUp,
      args: point.args,
      result: point.result,
      tool: point.tool,
      next: point.next,
      needsFollowUp: point.needsFollowUp,
      kind: point.entry.kind,
      provider,
      models,
      model: models.some((m) => m.id === id) ? id : "",
      canBranch:
        session.promptCheckpointReady &&
        !!snapshot.promptCheckpoint &&
        point.index === 0 &&
        point.entry.kind === "user" &&
        point.text === snapshot.evaluation.prompt,
      context: [
        ...(!system
          ? ["The trace lacks the original system instructions."]
          : []),
        ...(!tools.length
          ? ["The preview uses approximate tool definitions."]
          : []),
        ...(session.origin === "organic"
          ? ["The imported file supplies the conversation history."]
          : []),
      ],
    };
  }

  async startingPoint(id: string) {
    const child = await this.db.session.findUnique({
      where: { id },
      select: { parentSessionId: true, branchEntryId: true, snapshot: true },
    });
    if (!child?.parentSessionId || !child.branchEntryId)
      throw new NotFoundException("This session has no branch starting point.");
    const snapshot = child.snapshot as unknown as ExecutionSnapshot;
    const [{ turns }, background] = await Promise.all([
      this.trace(child.parentSessionId),
      snapshot.editedStart?.hasBackground ? this.sessions.background(id) : [],
    ]);
    return branchEdit(
      editPoint(turns, child.branchEntryId),
      background,
      snapshot.evaluation.prompt,
      snapshot.editedStart?.field,
    );
  }

  async prepareFullSession(
    sessionId: string,
    edit: TraceEdit,
    selectedModel: string,
  ) {
    const { session, turns, snapshot, inherited, recordedSettings } =
      await this.trace(sessionId);
    const point = editPoint(turns, edit.entryId);
    const history = editBackground(turns, edit, inherited);
    const firstPrompt = history.length === 1 && history[0]?.role === "user";
    const original =
      snapshot.agentSettings ??
      snapshot.promptCheckpoint ??
      recordedSettings ??
      snapshot.evaluation.models.find(
        (m) => m.harness === session.harness && m.model === session.model,
      );
    const model =
      session.harness === "opencode"
        ? `openrouter/${selectedModel.replace(/^openrouter\//, "")}`
        : selectedModel;
    const settings = ModelSettings.create({
      ...original,
      harness: session.harness,
      model,
      count: 1,
    }).value;
    const start: EditedSessionStart = {
      settings,
      task: firstPrompt ? edit.replacement : snapshot.evaluation.prompt,
      background: firstPrompt ? [] : history,
      label: `${point.toolName || (point.entry.kind === "user" ? "User message" : "Agent message")} · Entry ${point.entry.sequence}`,
      field: edit.field,
      change:
        edit.replacement.trim().replace(/\s+/g, " ").slice(0, 160) ||
        "Empty result",
      workspace:
        snapshot.editedStart?.workspace ??
        (session.origin === "organic" ? "empty" : "initial"),
    };
    if (
      Buffer.byteLength(fullSessionPrompt(start.task, start.background)) >
      4 * 1024 * 1024
    )
      throw new Error(
        "The session background exceeds 4 MiB. Choose an earlier entry.",
      );
    return { start, evaluation: snapshot.evaluation };
  }

  async requirePromptCheckpoint(sessionId: string, entryId: string) {
    const { session, turns, snapshot } = await this.trace(sessionId);
    const point = editPoint(turns, entryId);
    if (
      !session.promptCheckpointReady ||
      point.index !== 0 ||
      point.entry.kind !== "user" ||
      point.text !== snapshot.evaluation.prompt
    )
      throw new Error("This entry has no live checkpoint.");
  }
  async run(
    sessionId: string,
    edit: TraceEdit,
    model: string,
    signal: AbortSignal,
  ) {
    const { turns, tools, system, toolNames, snapshot, provider, prefix } =
      await this.trace(sessionId);
    const { messages, names, next } = previewHistory(turns, edit);
    if (!(await this.provider.models(provider)).some((m) => m.id === model))
      throw new Error("Choose a model from the preview catalog.");
    const first = messages[0];
    if (prefix && first?.role === "user")
      first.content = prefix + first.content;
    const instructions = system || (!prefix && snapshot.persona?.description);
    if (instructions)
      messages.unshift({ role: "system", content: instructions });
    const functions = new Map(tools.map((t) => [t.name, t]));
    for (const name of [...toolNames, ...names]) {
      if (!functions.has(name) && /^[\w-]{1,128}$/.test(name))
        functions.set(name, {
          name,
          description: "Tool recorded in the agent session.",
          parameters: { type: "object", additionalProperties: true },
        });
    }
    if (
      Buffer.byteLength(JSON.stringify([messages, ...functions.values()])) >
      4 * 1024 * 1024
    )
      throw new Error("This preview exceeds 4 MiB. Choose an earlier entry.");
    const response = await this.provider.next(
      provider,
      model,
      messages,
      [...functions.values()],
      signal,
    );
    this.analytics?.capture("session edit previewed", {
      session_id: sessionId,
      field: edit.field,
      provider,
      model: response.model,
      total_tokens: response.tokens,
      cost_usd: response.cost,
    });
    return { ...response, next };
  }
}
