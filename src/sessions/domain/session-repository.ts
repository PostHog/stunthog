import type { HarnessResult } from "../../harnesses/domain/harness.js";
import type { ResponseCapture } from "../../overrides/domain/response-override.js";
import type { ExecutionSnapshot } from "./execution-snapshot.js";
import type { Session } from "./session.js";

export abstract class SessionRepository {
  abstract insert(
    session: Session,
    snapshot: ExecutionSnapshot,
    batchId: string,
  ): Promise<void>;
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
