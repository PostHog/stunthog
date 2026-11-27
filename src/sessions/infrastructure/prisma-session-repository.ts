import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { EvaluationData } from "../../evaluations/domain/evaluation.js";
import { evaluationValues } from "../../evaluations/infrastructure/prisma-evaluation-repository.js";
import type { HarnessResult } from "../../harnesses/domain/harness.js";
import { Database } from "../../infrastructure/database.js";
import type { ResponseCapture } from "../../overrides/domain/response-override.js";
import type {
  EditedSessionStart,
  ExecutionSnapshot,
} from "../domain/execution-snapshot.js";
import { Session } from "../domain/session.js";
import type { SessionFile } from "../domain/session-file.js";
import { SessionRepository } from "../domain/session-repository.js";
import { callUpdates } from "../domain/tool-call.js";
import { toolCallRows, upsertCall } from "./tool-call-index.js";

export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));

@Injectable()
export class PrismaSessionRepository extends SessionRepository {
  constructor(@Inject(Database) private readonly db: Database) {
    super();
  }

  async insert(
    session: Session,
    snapshot: ExecutionSnapshot,
    batchId: string,
  ): Promise<void> {
    await this.db.session.create({
      data: sessionValues(session, snapshot, batchId),
    });
  }

  async markPromptCheckpoint(id: string, image: string | null) {
    await this.db.session.update({
      where: { id },
      data: { promptCheckpointReady: true, checkpointImage: image },
    });
  }

  async background(
    sessionId: string,
  ): Promise<EditedSessionStart["background"]> {
    const file = await this.db.sessionArtifact.findUniqueOrThrow({
      where: {
        sessionId_phase_path: {
          sessionId,
          phase: "branch-context",
          path: "transcript.json",
        },
      },
      select: { content: true },
    });
    return JSON.parse(Buffer.from(file.content).toString("utf8"));
  }

  async branch(
    parentId: string,
    entryId: string,
    start: string | EditedSessionStart,
    requestId: string,
  ) {
    const edited = typeof start === "string" ? undefined : start;
    const fingerprint = edited
      ? createHash("sha256")
          .update(
            JSON.stringify({ ...edited, change: undefined, field: undefined }),
          )
          .digest("hex")
      : undefined;
    return this.db.$transaction(async (tx) => {
      const previous = await tx.session.findUnique({
        where: { branchRequestId: requestId },
        select: {
          id: true,
          parentSessionId: true,
          branchEntryId: true,
          snapshot: true,
        },
      });
      if (previous) {
        const saved = previous.snapshot as unknown as ExecutionSnapshot;
        if (
          previous.parentSessionId !== parentId ||
          previous.branchEntryId !== entryId ||
          saved.editedStart?.fingerprint !== fingerprint ||
          (saved.editedStart?.field !== undefined &&
            saved.editedStart.field !== edited?.field) ||
          (typeof start === "string" && saved.evaluation.prompt !== start)
        )
          throw new Error("This request belongs to a different branch.");
        return { id: previous.id };
      }
      const parent = await tx.session.findUniqueOrThrow({
        where: { id: parentId },
      });
      const snapshot = parent.snapshot as unknown as ExecutionSnapshot;
      const model = edited?.settings ?? snapshot.promptCheckpoint;
      if (
        !model ||
        (!edited &&
          (!parent.promptCheckpointReady || parent.origin !== "synthetic")) ||
        ["queued", "running"].includes(parent.status)
      )
        throw new Error(
          "This session has no saved checkpoint for its first prompt.",
        );
      snapshot.evaluation.prompt =
        typeof start === "string" ? start : start.task;
      if (edited && fingerprint) {
        snapshot.editedStart = {
          label: edited.label,
          field: edited.field,
          change: edited.change,
          fingerprint,
          workspace: edited.workspace,
          hasBackground: edited.background.length > 0,
        };
        snapshot.agentSettings = model;
        delete snapshot.promptCheckpoint;
      } else {
        delete snapshot.editedStart;
      }
      if (snapshot.environment?.executionMode === "docker") {
        if (parent.checkpointImage)
          snapshot.environment.restoredImage = parent.checkpointImage;
        else if (!edited)
          throw new Error("This checkpoint lacks the Docker image ID.");
      }
      const session = new Session(snapshot.evaluation, model);
      await tx.session.create({
        data: {
          ...sessionValues(session, snapshot, parent.batchId),
          parentSessionId: parent.id,
          rootSessionId: parent.rootSessionId ?? parent.id,
          branchEntryId: entryId,
          branchRequestId: requestId,
          ...(edited?.background.length && {
            artifacts: {
              create: {
                phase: "branch-context",
                path: "transcript.json",
                content: Buffer.from(JSON.stringify(edited.background)),
              },
            },
          }),
        },
      });
      // Copy the frozen inputs inside the same transaction as the new session.
      await tx.$executeRaw`INSERT INTO SessionArtifact(id,sessionId,phase,path,content)
        SELECT lower(hex(randomblob(16))),${session.id},phase,path,content FROM SessionArtifact WHERE sessionId=${parent.id} AND phase='input'`;
      return { id: session.id, job: { session, snapshot } };
    });
  }

  async insertRecordings(
    recordings: { session: Session; file: SessionFile }[],
    snapshot: ExecutionSnapshot,
    batchId: string,
    newEvaluation?: EvaluationData,
  ) {
    // Commit the evaluation and all recordings before any judge can start.
    const now = Date.now();
    await this.db.$transaction(
      async (tx) => {
        if (newEvaluation)
          await tx.eval.create({
            data: { id: newEvaluation.id, ...evaluationValues(newEvaluation) },
          });
        for (const { session, file: recording } of recordings) {
          await tx.session.create({
            data: {
              ...sessionValues(session, snapshot, batchId),
              memo: recording.memo,
              artifacts: {
                create: {
                  phase: "session-file",
                  path: recording.filename,
                  content: Buffer.from(recording.content),
                },
              },
              events: {
                createMany: {
                  data: recording.events.map((event, i) => ({
                    phase: "agent",
                    sequence: i + 1,
                    event: json(event),
                  })),
                },
              },
            },
          });
          for (const [i, event] of recording.events.entries()) {
            for (const values of toolCallRows(
              session.id,
              "agent",
              callUpdates(event),
              i + 1,
              now,
            ))
              await tx.$executeRawUnsafe(upsertCall, ...values);
          }
        }
      },
      { timeout: 30_000 },
    );
  }

  async save(
    session: Session,
    agent?: HarnessResult,
    judge?: HarnessResult,
  ): Promise<void> {
    const data = session.snapshot();
    const usages = [agent?.usage, judge?.usage].filter(
      (usage) => usage !== undefined,
    );
    const completeCost =
      usages.length === (session.origin === "organic" ? 1 : 2) &&
      usages.every((usage) => usage.costUsd !== null);
    const finished = ["completed", "failed", "cancelled"].includes(data.status);

    const previous = await this.db.session.findUniqueOrThrow({
      where: { id: session.id },
      select: { startedAt: true },
    });

    await this.db.session.update({
      where: { id: data.id },
      data: {
        status: data.status,
        error: data.error ?? agent?.error ?? null,
        ...(agent ? { agentResult: json(agent) } : {}),
        ...(judge ? { judgeResult: json(judge) } : {}),
        ...(usages.length
          ? {
              inputTokens: usages.reduce((sum, usage) => sum + usage.input, 0),
              outputTokens: usages.reduce(
                (sum, usage) => sum + usage.output,
                0,
              ),
              cacheRead: usages.reduce(
                (sum, usage) => sum + usage.cacheRead,
                0,
              ),
              cacheWrite: usages.reduce(
                (sum, usage) => sum + usage.cacheWrite,
                0,
              ),
              totalTokens: usages.reduce((sum, usage) => sum + usage.total, 0),
              costUsd: completeCost
                ? usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0)
                : null,
            }
          : {}),
        ...(data.status === "running" && !previous.startedAt
          ? { startedAt: new Date() }
          : {}),
        ...(finished
          ? {
              finishedAt: new Date(),
              durationMs: previous.startedAt
                ? Date.now() - previous.startedAt.getTime()
                : 0,
            }
          : {}),
        ...(data.judgment
          ? {
              verdict: data.judgment.summary,
              behaviorDrift: json(data.judgment.behaviorDrift ?? []),
              decisions: {
                deleteMany: {},
                create: data.judgment.decisions.map((decision) => ({
                  criterionSnapshotId: decision.criterionId,
                  criterionDescription:
                    data.evaluation.criteria.find(
                      (criterion) => criterion.id === decision.criterionId,
                    )?.description ?? "",
                  passed: decision.passed,
                  feedback: decision.feedback,
                })),
              },
            }
          : {}),
      },
    });
  }

  async event(sessionId: string, phase: string, event: unknown): Promise<void> {
    // Allocate the sequence in the insert. Parallel tool results share this stream.
    const insert = (db: Prisma.TransactionClient) => db.$queryRaw<
      { sequence: number }[]
    >`INSERT INTO SessionEvent (sessionId,phase,sequence,event)
      SELECT ${sessionId},${phase},COALESCE(MAX(sequence),0)+1,${JSON.stringify(event)}
      FROM SessionEvent WHERE sessionId=${sessionId} RETURNING sequence`;
    const updates = phase === "response" ? [] : callUpdates(event);
    if (!updates.length) {
      await insert(this.db);
      return;
    }
    await this.db.$transaction(async (tx) => {
      const [row] = await insert(tx);
      if (!row) throw new Error("Cannot record the tool call.");
      for (const values of toolCallRows(
        sessionId,
        phase,
        updates,
        row.sequence,
        Date.now(),
      ))
        await tx.$executeRawUnsafe(upsertCall, ...values);
    });
  }

  async events(sessionId: string, phase: string): Promise<unknown[]> {
    const events = await this.db.sessionEvent.findMany({
      where: { sessionId, phase },
      orderBy: { sequence: "asc" },
    });

    return events.map((entry) => entry.event);
  }

  async modifiedResponses(sessionId: string): Promise<ResponseCapture[]> {
    const rows = await this.db.$queryRaw<{ capture: string }[]>`
      SELECT CAST(event AS TEXT) AS capture FROM SessionEvent
      WHERE sessionId = ${sessionId} AND phase = 'response'
        AND json_type(event, '$.ruleId') = 'text'
        AND json_type(event, '$.delivered') IS NOT NULL ORDER BY sequence`;
    const calls = new Map<string, ResponseCapture>();
    for (const row of rows) {
      const capture: ResponseCapture = JSON.parse(row.capture);
      calls.set(capture.callId, capture);
    }
    return [...calls.values()];
  }
}

function sessionValues(
  session: Session,
  snapshot: ExecutionSnapshot,
  batchId: string,
) {
  return {
    id: session.id,
    evalId: snapshot.evaluation.id,
    batchId,
    model: session.model.model,
    harness: session.model.harness,
    status: session.status,
    origin: session.origin,
    snapshot: json(snapshot),
  };
}
