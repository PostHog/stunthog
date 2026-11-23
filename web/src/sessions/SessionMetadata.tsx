import {
  IconCalendar,
  IconClock,
  IconDatabase,
  IconFolder,
  IconListCheck,
  IconPerson,
  IconPlug,
  IconReceipt,
  IconShuffle,
  IconSort,
  IconStack,
} from "@posthog/icons";
import { duration, money, number } from "../components.js";
import type { Session } from "../types.js";

function DetailLabel({
  icon: Icon,
  children,
}: {
  icon: typeof IconPerson;
  children: string;
}) {
  return (
    <dt>
      <Icon aria-hidden="true" />
      {children}
    </dt>
  );
}

export function SessionMetadata({ session }: { session: Session }) {
  const snapshot = session.snapshot;

  return (
    <dl className="session-metadata">
      <div>
        <DetailLabel icon={IconPerson}>Persona</DetailLabel>
        <dd>{snapshot.persona?.title ?? "None"}</dd>
      </div>
      <div>
        <DetailLabel icon={IconFolder}>Environment</DetailLabel>
        <dd>{snapshot.environment?.title ?? "Empty workspace"}</dd>
      </div>
      <div>
        <DetailLabel icon={IconPlug}>Skills / MCP servers</DetailLabel>
        <dd>
          {snapshot.skills.length} / {snapshot.mcps.length}
        </dd>
      </div>
      <div>
        <DetailLabel icon={IconShuffle}>Intercepted calls</DetailLabel>
        <dd>{number(session.interceptedCalls)}</dd>
      </div>
      <div>
        <DetailLabel icon={IconCalendar}>Started</DetailLabel>
        <dd>
          {session.startedAt
            ? new Date(session.startedAt).toLocaleString()
            : "Not started"}
        </dd>
      </div>
      <div>
        <DetailLabel icon={IconClock}>Duration</DetailLabel>
        <dd>{duration(session.durationMs)}</dd>
      </div>
      <div>
        <DetailLabel icon={IconSort}>Tokens in / out</DetailLabel>
        <dd>
          {number(session.inputTokens)} / {number(session.outputTokens)}
        </dd>
      </div>
      <div>
        <DetailLabel icon={IconDatabase}>Cache read / write</DetailLabel>
        <dd>
          {number(session.cacheRead)} / {number(session.cacheWrite)}
        </dd>
      </div>
      <div>
        <DetailLabel icon={IconStack}>Total tokens</DetailLabel>
        <dd>{number(session.totalTokens)}</dd>
      </div>
      <div>
        <DetailLabel icon={IconReceipt}>Estimated USD</DetailLabel>
        <dd>{money(session.costUsd)}</dd>
      </div>
      <div>
        <DetailLabel icon={IconListCheck}>Evaluation</DetailLabel>
        <dd className="eval-outcome">
          <span className="pass">
            {session.decisions.filter((decision) => decision.passed).length}{" "}
            passed
          </span>{" "}
          ·{" "}
          <span className="fail">
            {session.decisions.filter((decision) => !decision.passed).length}{" "}
            failed
          </span>{" "}
          ·{" "}
          <span className="muted">
            {Math.max(
              0,
              snapshot.evaluation.criteria.length - session.decisions.length,
            )}{" "}
            not assessed
          </span>
        </dd>
      </div>
    </dl>
  );
}
