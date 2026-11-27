import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@posthog/quill";
import { CheckBar } from "../CheckBar.js";
import { StatusIcon } from "../status/StatusIcon.js";
import type { Session } from "../types.js";
import { isActive } from "./session-filters.js";

export function SessionJudgment({ session }: { session: Session }) {
  return (
    <aside className="judgment">
      <h2>Evaluation criteria</h2>
      <CheckBar
        decisions={session.decisions}
        criteria={session.snapshot.evaluation.criteria}
      />
      <p>
        {session.verdict ??
          (isActive(session)
            ? session.origin === "organic"
              ? "Waiting for the judge to assess the session file."
              : "The judge assesses this session after the agent finishes."
            : "No judgment is available. Check the session error and logs.")}
      </p>
      {session.snapshot.evaluation.criteria.map((criterion, index) => {
        const decision = session.decisions.find(
          (item) => item.criterionSnapshotId === criterion.id,
        );

        return (
          <Collapsible
            defaultOpen={decision ? !decision.passed : false}
            key={criterion.id}
            className="decision"
          >
            <CollapsibleTrigger>
              <span
                className={`status-note ${!decision ? "muted" : decision.passed ? "pass" : "fail"}`}
              >
                <StatusIcon
                  name={
                    !decision ? "clock" : decision.passed ? "check" : "error"
                  }
                />
                {!decision
                  ? "Not assessed"
                  : decision.passed
                    ? "Passed"
                    : "Failed"}
              </span>{" "}
              {index + 1}. {criterion.description}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p>
                {decision?.feedback ??
                  "The judge has not returned a decision for this criterion."}
              </p>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      <p className="muted">
        {session.origin === "organic"
          ? "Usage covers the judge for this import."
          : "Usage includes the task agent and judge."}{" "}
        Cost availability depends on the harness.
      </p>
    </aside>
  );
}
