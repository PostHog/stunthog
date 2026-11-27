import type { EvaluationData } from "../../evaluations/domain/evaluation.js";
import type { HarnessResult } from "../../harnesses/domain/harness.js";
import type { ResponseCapture } from "../../overrides/domain/response-override.js";
import type {
  EditedSessionStart,
  ExecutionSnapshot,
} from "./execution-snapshot.js";
import type { Session } from "./session.js";

import type { SessionFile } from "./session-file.js";

export abstract class SessionRepository {
  abstract insert(
    session: Session,
    snapshot: ExecutionSnapshot,
    batchId: string,
  ): Promise<void>;
  abstract insertRecordings(
    recordings: { session: Session; file: SessionFile }[],
    snapshot: ExecutionSnapshot,
    batchId: string,
    newEvaluation?: EvaluationData,
  ): Promise<void>;
  abstract background(
    sessionId: string,
  ): Promise<EditedSessionStart["background"]>;
  abstract markPromptCheckpoint(
    sessionId: string,
    image: string | null,
  ): Promise<void>;
  abstract branch(
    parentId: string,
    entryId: string,
    start: string | EditedSessionStart,
    requestId: string,
  ): Promise<{
    id: string;
    job?: { session: Session; snapshot: ExecutionSnapshot };
  }>;
  abstract save(
    session: Session,
    agent?: HarnessResult,
    judge?: HarnessResult,
  ): Promise<void>;
  abstract event(
    sessionId: string,
    phase: string,
    event: unknown,
  ): Promise<void>;
  abstract events(sessionId: string, phase: string): Promise<unknown[]>;
  abstract modifiedResponses(sessionId: string): Promise<ResponseCapture[]>;
}
