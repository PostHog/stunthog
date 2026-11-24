import { Tooltip } from "./Tooltip.js";

type Decision = {
  passed: boolean;
  criterionSnapshotId?: string;
  criterionDescription?: string;
};

export function CheckBar({
  decisions,
  criteria,
}: {
  decisions: Decision[];
  criteria?: { id: string; description: string }[];
}) {
  const items =
    criteria?.map((criterion) => ({
      id: criterion.id,
      name: criterion.description,
      passed: decisions.find(
        (decision) => decision.criterionSnapshotId === criterion.id,
      )?.passed,
    })) ??
    decisions.map((decision, index) => ({
      id: String(index),
      name: decision.criterionDescription ?? `Criterion ${index + 1}`,
      passed: decision.passed,
    }));

  return (
    <fieldset
      className="check-bar"
      aria-label={`${items.filter((item) => item.passed).length} of ${items.length} criteria passed`}
    >
      {items.map((item, index) => {
        const status =
          item.passed === undefined
            ? "not assessed"
            : item.passed
              ? "passed"
              : "failed";

        return (
          <Tooltip
            key={item.id}
            text={`${index + 1}. ${item.name} — ${status}`}
          >
            <span
              className={`criterion-mark ${item.passed === undefined ? "unassessed" : status}`}
              aria-hidden="true"
            >
              {item.passed === undefined ? "" : item.passed ? "✓" : "×"}
            </span>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
