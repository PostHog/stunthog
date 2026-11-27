import { Button } from "@posthog/quill";
import { useState } from "react";
import { maxSessionFilesPerUpload } from "../../../src/sessions/domain/session-file.js";
import type { EvalDraft, Harness } from "../types.js";
import {
  LoadSessionDialog,
  type PendingSessionFile,
} from "./LoadSessionDialog.js";
import { defaultModel } from "./ModelPicker.js";
import { ModelSettingsDialog } from "./ModelSettingsDialog.js";
import { ModelSummary } from "./ModelSummary.js";

export function EvalModels<T extends Pick<EvalDraft, "models" | "judge">>({
  value,
  onChange,
  harnesses = [],
  saveTarget = "evaluation",
  recordings,
}: {
  value: T;
  onChange: (value: T) => void;
  harnesses?: Harness[];
  saveTarget?: "evaluation" | "settings";
  recordings?: {
    files: PendingSessionFile[];
    onChange: (files: PendingSessionFile[]) => void;
  };
}) {
  const [addingFile, setAddingFile] = useState(false);
  const [editing, setEditing] = useState<number | "new" | "judge" | null>(null);

  return (
    <>
      <section className="eval-model-section">
        <div className="section-heading">
          <h2>
            {recordings ? (
              "Agent sessions"
            ) : (
              <>
                Session models{" "}
                <span className="muted">({value.models.length})</span>
              </>
            )}
          </h2>
          <div className="actions">
            {recordings && (
              <Button
                type="button"
                variant="outline"
                disabled={recordings.files.length >= maxSessionFilesPerUpload}
                onClick={() => setAddingFile(true)}
              >
                Load session file
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={!harnesses.length}
              onClick={() => setEditing("new")}
            >
              Add model
            </Button>
          </div>
        </div>
        <p className="muted">
          {recordings ? (
            <>
              Load files for organic sessions. Add models for synthetic
              sessions. Models and judge start from your{" "}
              <a href="#settings">evaluation defaults</a>.
            </>
          ) : (
            "Choose the models that will perform the task."
          )}
        </p>
        {!value.models.length && !recordings?.files.length && (
          <div className="model-selection-empty">
            <strong>
              {recordings ? "No sessions selected" : "No models selected"}
            </strong>
            <p>
              {saveTarget === "settings"
                ? "Add a model to use it in new evaluations."
                : recordings
                  ? "Load a session file or add a model."
                  : "Add a model to run synthetic sessions."}
            </p>
          </div>
        )}
        <div className="model-summary-list">
          {value.models.map((model, index) => (
            <ModelSummary
              key={`${index}-${model.harness}`}
              synthetic={!!recordings}
              value={model}
              label={`Edit model configuration ${index + 1}`}
              onEdit={() => setEditing(index)}
              onRemove={() =>
                onChange({
                  ...value,
                  models: value.models.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            />
          ))}
          {recordings?.files.map(({ file, memo, id }) => (
            <div className="model-summary ph-no-capture" key={id}>
              <div className="model-summary-info">
                <strong>{file.name}</strong>
                <p className="muted">Organic{memo && <> · {memo}</>}</p>
              </div>
              <Button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  recordings.onChange(
                    recordings.files.filter((entry) => entry.id !== id),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        {recordings && recordings.files.length >= maxSessionFilesPerUpload && (
          <p className="muted">
            You can load more files after you save the evaluation.
          </p>
        )}
        {recordings && addingFile && (
          <LoadSessionDialog
            stage
            onClose={() => setAddingFile(false)}
            onLoad={(entry) => {
              recordings.onChange([...recordings.files, entry]);
              setAddingFile(false);
            }}
          />
        )}
      </section>
      <section className="eval-model-section">
        <div className="section-heading">
          <h2>Judge</h2>
          {!value.judge && (
            <Button
              type="button"
              variant="outline"
              disabled={!harnesses.length}
              onClick={() => setEditing("judge")}
            >
              Add judge
            </Button>
          )}
        </div>
        <p className="muted">
          This model checks each session against your criteria. Its usage adds
          to the session cost.
        </p>
        {value.judge ? (
          <ModelSummary
            value={value.judge}
            judge
            label="Edit judge"
            onEdit={() => setEditing("judge")}
            onRemove={() => onChange({ ...value, judge: null })}
          />
        ) : (
          <div className="model-selection-empty">
            <strong>No judge selected</strong>
            <p>Add a judge to assess the results.</p>
          </div>
        )}
      </section>
      {editing !== null && (
        <ModelSettingsDialog
          saveTarget={saveTarget}
          title={
            editing === "judge"
              ? value.judge
                ? "Edit judge"
                : "Add judge"
              : editing === "new"
                ? "Add model"
                : "Edit model configuration"
          }
          initial={
            editing === "judge"
              ? (value.judge ?? defaultModel)
              : editing === "new"
                ? defaultModel
                : (value.models[editing] ?? defaultModel)
          }
          judge={editing === "judge"}
          harnesses={harnesses}
          onClose={() => setEditing(null)}
          onApply={(model) => {
            onChange(
              editing === "judge"
                ? { ...value, judge: model }
                : {
                    ...value,
                    models:
                      editing === "new"
                        ? [...value.models, model]
                        : value.models.map((item, index) =>
                            index === editing ? model : item,
                          ),
                  },
            );

            setEditing(null);
          }}
        />
      )}
    </>
  );
}
