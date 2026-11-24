import type { OverrideEvidence } from "../../../src/overrides/domain/response-override.js";

export function ModelEvidence({ decisions, rationale }: OverrideEvidence) {
  if (!decisions?.length && !rationale) return null;
  return (
    <dl className="override-evidence">
      {decisions?.map((decision) => (
        <div key={decision.ruleId}>
          <dt>
            {decision.model} · {decision.condition}
          </dt>
          <dd>
            {decision.probability > 0.5 ? "Match" : "No match"} ·{" "}
            {Intl.NumberFormat(undefined, {
              style: "percent",
              maximumFractionDigits: 2,
            }).format(decision.probability)}{" "}
            match probability
          </dd>
        </div>
      ))}
      {rationale && (
        <div>
          <dt>Edit rationale</dt>
          <dd>{rationale}</dd>
        </div>
      )}
    </dl>
  );
}
