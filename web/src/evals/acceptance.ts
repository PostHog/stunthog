import type { Session } from "../types.js";

export function passesSession(session: {
  status: string;
  decisions: { passed: boolean }[];
}): boolean {
  return (
    session.status === "completed" &&
    session.decisions.length > 0 &&
    session.decisions.every((decision) => decision.passed)
  );
}

// A setup failure has no behavioral result. Other missing checks keep their existing denominator.
export function criterionDecisions(
  sessions: (Pick<Session, "decisions"> &
    Partial<Pick<Session, "status" | "judgeResult">>)[],
  id: string,
) {
  return sessions
    .filter(
      (session) =>
        !(
          session.status === "failed" &&
          session.judgeResult === null &&
          session.decisions.length === 0
        ),
    )
    .map((session) => ({
      passed:
        session.decisions.find(
          (decision) => decision.criterionSnapshotId === id,
        )?.passed ?? false,
    }));
}
