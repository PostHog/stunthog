import { Button } from "@posthog/quill";
import { ModelReference } from "../models/ModelReference.js";
import type { ModelSettingsData } from "../types.js";

export function ModelSummary({
  value,
  judge,
  synthetic,
  label,
  onEdit,
  onRemove,
}: {
  value: ModelSettingsData;
  judge?: boolean;
  synthetic?: boolean;
  label: string;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="model-summary">
      <div className="model-summary-info">
        <ModelReference harness={value.harness} model={value.model} />
        <p className="muted">
          {synthetic && "Synthetic · "}
          {value.harness} · {value.effort} effort · {value.maxTurns} turns ·{" "}
          {value.timeoutSeconds}s timeout
        </p>
      </div>
      {!judge && (
        <span className="session-count">
          {value.count} {value.count === 1 ? "session" : "sessions"}
        </span>
      )}
      <div className="actions">
        <Button type="button" aria-label={label} onClick={onEdit}>
          Edit
        </Button>
        {onRemove && (
          <Button
            type="button"
            aria-label={label.replace("Edit", "Remove")}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
