import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@posthog/quill";
import { useState } from "react";
import { api, useApi } from "../api.js";
import { Choice } from "../Choice.js";
import { Acceptance, Field, Notice, PageTitle } from "../components.js";
import { ModelKey } from "../models/ModelReference.js";
import { ResponseOverrideList } from "../overrides/ResponseOverrideList.js";
import { Feedback, RequestState } from "../PageState.js";
import { SessionsTable } from "../sessions/SessionList.js";
import { isActive } from "../sessions/session-filters.js";
import { UsageSummary } from "../sessions/UsageSummary.js";
import { RunProgress } from "../status/RunProgress.js";
import { StatusIcon } from "../status/StatusIcon.js";
import type { EvaluationData, Resources, Session } from "../types.js";
import { criterionDecisions } from "./acceptance.js";
import { EvalConfiguration } from "./EvalConfiguration.js";
import { LoadSessionDialog } from "./LoadSessionDialog.js";
import { RunComparison } from "./RunComparison.js";

export function EvalDetail({ id }: { id: string }) {
  const {
    data: evaluation,
    error,
    refresh: refreshEval,
  } = useApi<EvaluationData>(`/evals/${id}`);
  const {
    data: allSessions,
    error: sessionsError,
    refresh,
  } = useApi<Session[]>(`/sessions?evalId=${id}`, true);
  const { data: resources } = useApi<Resources>("/resources");
  const [loadingFile, setLoadingFile] = useState(false);
  const [runError, setRunError] = useState("");
  const [starting, setStarting] = useState(false);
  const [selectedRunOnly, setSelectedRunOnly] = useState(false);
  const [batch, setBatch] = useState("latest");
  const [message, setMessage] = useState("");

  const [selection, setSelection] = useState<number[] | null>(null);
  async function run() {
    setStarting(true);
    setRunError("");
    setMessage("");

    try {
      await api(`/evals/${id}/run`, {
        method: "POST",
        body: JSON.stringify({
          ...(selection && {
            selection: { revision: evaluation?.revision, models: selection },
          }),
        }),
      });
      setBatch("latest");
      setMessage("Run created. Results update here as sessions finish.");
      refresh();
    } catch (error) {
      setRunError(String(error));
    } finally {
      setStarting(false);
    }
  }

  if (!evaluation) return <RequestState error={error} retry={refreshEval} />;

  const originals = allSessions ?? [];
  const batches = [...new Set(originals.map((session) => session.batchId))];
  const sessions = originals.filter(
    (session) => session.batchId === (batch === "latest" ? batches[0] : batch),
  );
  const definition = sessions[0]?.snapshot.evaluation ?? evaluation;
  const finished = sessions.filter((session) => !isActive(session));
  const activeElsewhere = (allSessions ?? []).filter(
    (session) => isActive(session) && session.batchId !== sessions[0]?.batchId,
  );
  const running = (allSessions ?? []).some(isActive);
  const count = evaluation.models.reduce(
    (sum, model, index) =>
      sum + (selection === null || selection.includes(index) ? model.count : 0),
    0,
  );
  const models = [
    ...new Set(
      (sessions ?? []).map((session) => `${session.harness}/${session.model}`),
    ),
  ];

  return (
    <>
      <PageTitle title={evaluation.title}>
        <Button
          nativeButton={false}
          variant="outline"
          render={<a href={`#evals/${id}/edit`}>Edit evaluation</a>}
        />
        <Button
          type="button"
          variant={evaluation.models.length ? "outline" : "primary"}
          onClick={() => setLoadingFile(true)}
        >
          Load session file
        </Button>
        {evaluation.models.length > 0 && (
          <Button
            type="button"
            variant="primary"
            disabled={starting || count === 0}
            onClick={() => void run()}
          >
            {starting && <StatusIcon name="spinner" />}
            {starting
              ? "Preparing sessions..."
              : `Run ${count} ${running ? "more " : ""}${count === 1 ? "session" : "sessions"}`}
          </Button>
        )}
      </PageTitle>
      {loadingFile && (
        <LoadSessionDialog
          onClose={() => setLoadingFile(false)}
          onLoad={async ({ file, memo }) => {
            const body = new FormData();
            body.set("file", file);
            body.set("memo", memo);
            const { batchId } = await api<{ batchId: string }>(
              `/evals/${id}/session-file`,
              { method: "POST", body },
            );
            setLoadingFile(false);
            setBatch(batchId);
            setRunError("");
            setMessage(
              "Organic session loaded. The judge will check the recorded activity.",
            );
            refresh();
          }}
        />
      )}
      {evaluation.models.length > 1 && (
        <details className="section-note">
          <summary>Select models for this run</summary>
          <fieldset disabled={starting}>
            <legend>Session models</legend>
            {evaluation.models.map((config, index) => (
              <label
                className="checkbox"
                key={`${config.harness}/${config.model}/${index}`}
              >
                <input
                  type="checkbox"
                  checked={selection === null || selection.includes(index)}
                  onChange={(event) => {
                    const current =
                      selection ?? evaluation.models.map((_, i) => i);
                    setSelection(
                      event.target.checked
                        ? [...current, index]
                        : current.filter((i) => i !== index),
                    );
                  }}
                />
                <ModelKey value={`${config.harness}/${config.model}`} /> ·{" "}
                {config.effort} · {config.count}{" "}
                {config.count === 1 ? "session" : "sessions"}
              </label>
            ))}
          </fieldset>
        </details>
      )}
      <Notice error={runError || (allSessions ? sessionsError : undefined)} />
      <Feedback message={message} />
      {starting && (
        <output className="loading-state">
          <StatusIcon name="spinner" />
          Preparing workspaces and starting sessions…
        </output>
      )}
      {activeElsewhere.length > 0 && (
        <div className="active-run-notice">
          <span className="status-note">
            <StatusIcon name="spinner" />
            {activeElsewhere.length}{" "}
            {activeElsewhere.length === 1 ? "session is" : "sessions are"}{" "}
            active in other runs.
          </span>
          <Button
            type="button"
            onClick={() => setBatch(activeElsewhere[0]?.batchId ?? "latest")}
          >
            View active run
          </Button>
        </div>
      )}
      <p className="section-note">
        Synthetic sessions run the agent and the judge. Organic sessions use a
        recorded log and run only the judge.
      </p>
      <div className="toolbar">
        <Field label="Run">
          <Choice
            value={batch}
            disabled={batches.length === 0}
            onValueChange={setBatch}
            options={[
              { value: "latest", label: "Latest run" },
              ...batches.map((id) => {
                const run = originals.filter(
                  (session) => session.batchId === id,
                );
                const [first] = run;
                if (!first) return { value: id, label: id };
                const count =
                  first.snapshot.evaluation.responseOverrides?.length ?? 0;
                return {
                  value: id,
                  label: `${new Date(first.createdAt).toLocaleString()} · ${first.origin === "organic" ? "Organic · " : ""}Revision ${first.snapshot.evaluation.revision} · ${count} ${count === 1 ? "override" : "overrides"} · ${run.length} ${run.length === 1 ? "session" : "sessions"}`,
                };
              }),
            ]}
          />
        </Field>
        <span className="muted">
          This report shows revision {definition.revision}. The current revision
          is {evaluation.revision}.
        </span>
      </div>
      {definition.revision !== evaluation.revision && (
        <p className="info-note">
          You are viewing saved results from revision {definition.revision}.
          Editing or running this evaluation uses the current revision{" "}
          {evaluation.revision}.
        </p>
      )}
      <RunProgress sessions={sessions} />
      <div className="overview">
        <section>
          <h2>Prompt</h2>
          <p className="prompt-block">{definition.prompt}</p>
          <Collapsible className="criteria-disclosure" defaultOpen>
            <CollapsibleTrigger>
              Criteria{" "}
              <span className="muted">{definition.criteria.length} checks</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="table-scroll">
                <Table fullWidth size="sm">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Criterion</TableHead>
                      {models.map((model) => (
                        <TableHead key={model}>
                          <ModelKey value={model} />
                        </TableHead>
                      ))}
                      <TableHead>Finished sessions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {definition.criteria.map((criterion, index) => (
                      <TableRow key={criterion.id}>
                        <TableCell>
                          {index + 1}. {criterion.description}
                        </TableCell>
                        {models.map((model) => (
                          <TableCell key={model}>
                            <Acceptance
                              decisions={criterionDecisions(
                                finished.filter(
                                  (session) =>
                                    `${session.harness}/${session.model}` ===
                                    model,
                                ),
                                criterion.id,
                              )}
                            />
                          </TableCell>
                        ))}
                        <TableCell>
                          <Acceptance
                            decisions={criterionDecisions(
                              finished,
                              criterion.id,
                            )}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </section>
        <EvalConfiguration
          {...(sessions[0]?.origin === "organic" && { recordedModels: models })}
          definition={definition}
          resources={resources}
          snapshot={sessions[0]?.snapshot}
        />
      </div>
      <ResponseOverrideList
        title={
          sessions.length
            ? "Overrides used in this run"
            : "Current response overrides"
        }
        rules={definition.responseOverrides}
        servers={sessions[0]?.snapshot.mcps ?? resources?.mcps}
      />
      {sessions.length > 0 && <UsageSummary sessions={sessions} />}
      <section className="section">
        <div className="section-heading">
          <h2>Agent sessions</h2>
          {batches.length > 1 && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selectedRunOnly}
                onChange={(event) => setSelectedRunOnly(event.target.checked)}
              />
              Selected run only
            </label>
          )}
        </div>
        {allSessions ? (
          <SessionsTable sessions={selectedRunOnly ? sessions : allSessions} />
        ) : (
          <RequestState error={sessionsError} retry={refresh} />
        )}
      </section>
      <RunComparison sessions={sessions} definition={definition} />
    </>
  );
}
