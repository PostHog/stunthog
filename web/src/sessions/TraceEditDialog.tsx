import { Button, Textarea } from "@posthog/quill";
import { useEffect, useRef, useState } from "react";

import type {
  TraceEditPoint as Point,
  PreviewReply,
  TraceAction,
  TraceEdit,
} from "../../../src/sessions/domain/trace-edit.js";
import { api } from "../api.js";
import { Choice } from "../Choice.js";
import { Field, money, Notice } from "../components.js";
import { Dialog } from "../Dialog.js";
import { harnessName, ModelReference } from "../models/ModelReference.js";
import { ModelSelect } from "../models/ModelSelect.js";
import { providerInfo } from "../resources/provider-info.js";
import type { Session } from "../types.js";

function Actions({ actions }: { actions: TraceAction[] }) {
  return actions.length ? (
    actions.map((a, i) => (
      <div key={a.kind + String(i)}>
        <small>
          {a.kind === "tool"
            ? "Tool call"
            : a.kind === "user"
              ? "User message"
              : "Agent message"}
        </small>
        <pre>{a.text}</pre>
      </div>
    ))
  ) : (
    <p className="muted">The recording ends here.</p>
  );
}

export function TraceEditDialog({
  session,
  entryId,
  onClose,
  onBranchCreated,
}: {
  session: Pick<Session, "id">;
  entryId: string;
  onClose: () => void;
  onBranchCreated: (id: string) => void;
}) {
  const [point, setPoint] = useState<Point>();
  const [field, setField] = useState<TraceEdit["field"]>("text");
  const [replacement, setReplacement] = useState("");
  const [result, setResult] = useState("");
  const [emptyResult, setEmptyResult] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [model, setModel] = useState("");
  const [choosingModel, setChoosingModel] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewReply>();
  const [confirm, setConfirm] = useState(false);
  const [retry, setRetry] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const branchRequest = useRef("");
  const baseUrl = `/sessions/${session.id}`;
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    api<Point>(`${baseUrl}/edit-point?attempt=${retry}`, {
      method: "POST",
      body: JSON.stringify({ entryId }),
      signal: abort.signal,
    })
      .then((p) => {
        if (abort.signal.aborted) return;
        setPoint(p);
        setField(p.tool ? "result" : "text");
        setReplacement(p.tool ? p.result : p.text);
        setModel(p.model);
        setChoosingModel(!p.model);
        setFollowUp(p.recordedFollowUp ?? "");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => {
      abort.abort();
      pending.current?.abort();
    };
  }, [baseUrl, entryId, retry]);
  function invalidate() {
    setPreview(undefined);
    setError("");
    setConfirm(false);
    branchRequest.current = "";
  }
  async function run(live: boolean) {
    if (pending.current || !point) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError("");
    try {
      const edit: TraceEdit = {
        entryId,
        field,
        replacement,
        ...(field === "arguments" && (result.length || emptyResult)
          ? { sampleResult: emptyResult ? "" : result }
          : {}),
        ...(followUp.trim() && { followUp }),
      };
      if (live) {
        branchRequest.current ||= crypto.randomUUID();
        const { id } = await api<{ id: string }>(`${baseUrl}/branches`, {
          method: "POST",
          body: JSON.stringify({
            edit,
            model,
            requestId: branchRequest.current,
            confirmLiveTools: true,
          }),
          signal: abort.signal,
        });
        if (!abort.signal.aborted) onBranchCreated(id);
      } else {
        const response = await api<PreviewReply>(`${baseUrl}/previews`, {
          method: "POST",
          body: JSON.stringify({ model, edit }),
          signal: abort.signal,
        });
        if (!abort.signal.aborted) setPreview(response);
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(String(e));
    } finally {
      pending.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  const allowFullRun = !!(
    point &&
    model &&
    (field === "result" || replacement.trim())
  );
  const allowPreview =
    allowFullRun &&
    (!point?.needsFollowUp || followUp.trim()) &&
    (field !== "arguments" || result.length || emptyResult);
  if (confirm && point)
    return (
      <Dialog
        title="Start a branch from this entry?"
        description={`${harnessName(point.harness)} will use the edited conversation through this entry as background.`}
        busy={busy}
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirm(false)}>
              Back to edit
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(true)}
            >
              {busy ? "Starting branch…" : "Start branch"}
            </Button>
          </>
        }
      >
        <Notice error={error} />
        <ModelReference model={model} harness={point.harness} />
        <p>
          {point.workspace === "empty"
            ? "The agent starts in an empty workspace. The imported log contains no workspace files."
            : "The agent starts with a fresh copy of the original input files."}
        </p>
        <p>
          The agent can run tools and call external services. The judge checks
          this branch. Provider charges apply.
        </p>
      </Dialog>
    );
  return (
    <Dialog
      title="Try an edit"
      description="Change this entry to start a branch. The original harness runs the branch to completion."
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !allowPreview}
            onClick={() => void run(false)}
          >
            {busy ? "Previewing…" : "Preview next action"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !allowFullRun}
            onClick={() => setConfirm(true)}
          >
            Run as branch
          </Button>
        </>
      }
    >
      {!point && !error && <output>Loading trace entry…</output>}
      <Notice error={error} />
      {!point && error && (
        <Button onClick={() => setRetry(retry + 1)}>Retry</Button>
      )}
      {point && (
        <div className="trace-edit ph-no-capture" data-ph-mask>
          <fieldset disabled={busy}>
            {point.tool && (
              <div className="trace-edit-source">
                <strong>{point.toolName}</strong>
                <code>{point.text}</code>
                <small>Entry {point.sequence}</small>
              </div>
            )}
            {point.tool && (
              <Field label="Edit">
                <Choice
                  value={field}
                  options={[
                    { value: "result", label: "Tool result" },
                    { value: "arguments", label: "Tool arguments" },
                  ]}
                  onValueChange={(v) => {
                    invalidate();
                    setField(v === "arguments" ? "arguments" : "result");
                    setReplacement(
                      v === "arguments"
                        ? JSON.stringify(point.args ?? {}, null, 2)
                        : point.result,
                    );
                  }}
                />
              </Field>
            )}
            <Field
              label={
                field === "arguments"
                  ? "Edited arguments (JSON)"
                  : field === "result"
                    ? "Edited tool result"
                    : point.kind === "user"
                      ? "Edited user message"
                      : "Edited agent message"
              }
            >
              <Textarea
                rows={5}
                value={replacement}
                onChange={(e) => {
                  invalidate();
                  setReplacement(e.target.value);
                }}
              />
            </Field>
            {field === "arguments" && (
              <>
                <Field label="Sample tool result">
                  <Textarea
                    rows={3}
                    disabled={emptyResult}
                    value={result}
                    placeholder="Leave empty to let the agent run the edited call in the branch"
                    onChange={(e) => {
                      invalidate();
                      setResult(e.target.value);
                    }}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={emptyResult}
                    onChange={(e) => {
                      invalidate();
                      setEmptyResult(e.target.checked);
                    }}
                  />{" "}
                  This call returns no text
                </label>
              </>
            )}
            {point.kind === "message" && (
              <Field
                label={
                  point.needsFollowUp
                    ? "Follow-up message (required for preview)"
                    : "Follow-up message (optional)"
                }
              >
                <Textarea
                  rows={2}
                  value={followUp}
                  placeholder="What should the agent do next?"
                  onChange={(e) => {
                    invalidate();
                    setFollowUp(e.target.value);
                  }}
                />
              </Field>
            )}
            <details
              open={choosingModel}
              onToggle={(event) => setChoosingModel(event.currentTarget.open)}
            >
              <summary>Model · {model || "Choose a model"}</summary>
              {choosingModel && (
                <ModelSelect
                  harness={{ models: point.models }}
                  value={model}
                  onChange={(v) => {
                    invalidate();
                    setModel(v);
                  }}
                />
              )}
            </details>
          </fieldset>
          <div className="trace-edit-comparison">
            <section>
              <h3>Recorded next action</h3>
              <Actions actions={point.next} />
            </section>
            <section aria-live="polite">
              <h3>Preview next action</h3>
              {preview ? (
                <>
                  <Actions actions={[preview.action]} />
                  <small>
                    {preview.model} · {preview.tokens ?? "Unknown"} tokens ·{" "}
                    {money(preview.cost)}
                  </small>
                </>
              ) : (
                <p className="muted">
                  Preview one model turn before you start a branch.
                </p>
              )}
              <details>
                <summary>About the preview</summary>
                <p className="muted">
                  {providerInfo[point.provider]?.name ?? point.provider}{" "}
                  receives the edited history. The preview shows proposed tool
                  calls. Provider charges apply.
                </p>
                {point.context.length > 0 && (
                  <p className="muted">{point.context.join(" ")}</p>
                )}
              </details>
            </section>
          </div>
        </div>
      )}
    </Dialog>
  );
}
