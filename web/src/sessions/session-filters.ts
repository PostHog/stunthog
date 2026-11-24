import type { Session } from "../types.js";

export const isActive = (session: { status: string }) =>
  ["queued", "running", "judging"].includes(session.status);

export function needsReview(session: Pick<Session, "status" | "decisions">) {
  return (
    !isActive(session) &&
    (session.status !== "completed" ||
      session.decisions.length === 0 ||
      session.decisions.some((decision) => !decision.passed))
  );
}

export function filterSessions(
  sessions: Session[],
  query: string,
  model: string,
  status: string,
  displayName: (harness: string, model: string) => string = (_, model) => model,
) {
  const search = query.trim().toLowerCase();

  return sessions.filter(
    (session) =>
      (!model || `${session.harness}/${session.model}` === model) &&
      (!status ||
        (status === "active"
          ? isActive(session)
          : status === "review"
            ? needsReview(session)
            : session.status === status)) &&
      `${session.eval.title} ${displayName(session.harness, session.model)} ${session.model} ${session.harness} ${session.snapshot.environment?.title ?? ""}`
        .toLowerCase()
        .includes(search),
  );
}
