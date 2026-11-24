import { Button, Input, Textarea } from "@posthog/quill";
import { type FormEvent, useState } from "react";
import type {
  ApplicationSettingsData,
  EvaluationDefaultsData,
} from "../../../src/settings/domain/application-settings.js";
import { api, useApi } from "../api.js";
import { Field, Notice, PageTitle } from "../components.js";
import { EvalOverrides } from "../overrides/EvalOverrides.js";
import { RequestState } from "../PageState.js";
import { StatusIcon } from "../status/StatusIcon.js";
import type {
  EvalDraft,
  EvaluationData,
  Harness,
  Resources,
} from "../types.js";
import { EvalCriteria } from "./EvalCriteria.js";
import { EvalModels } from "./EvalModels.js";
import { EvalResources } from "./EvalResources.js";
import {
  missingJudgeMcpTools,
  withJudgeMcpSupport,
} from "./ResourceSelection.js";

export function EvalEditor({ id }: { id?: string }) {
  return id ? <ExistingEditor key={id} id={id} /> : <NewEditor />;
}

function NewEditor() {
  const { data, error, refresh } = useApi<ApplicationSettingsData>("/settings");

  return data ? (
    <Editor defaults={data.evaluationDefaults} />
  ) : (
    <RequestState error={error} retry={refresh} />
  );
}

function ExistingEditor({ id }: { id: string }) {
  const { data, error, refresh } = useApi<EvaluationData>(`/evals/${id}`);

  return data ? (
    <Editor initial={data} />
  ) : (
    <RequestState error={error} retry={refresh} />
  );
}

// Drafts belong to this tab and the revision the author opened.
const drafts = new Map<string, EvalDraft>();
function Editor({
  initial,
  defaults,
}: {
  initial?: EvaluationData;
  defaults?: EvaluationDefaultsData;
}) {
  const draftKey = initial
    ? `${initial.id}/${initial.revision}`
    : `new/${JSON.stringify(defaults)}`;
  const [value, update] = useState<EvalDraft>(
    () =>
      drafts.get(draftKey) ??
      initial ?? {
        title: "",
        prompt: "",
        criteria: [],
        environmentId: null,
        personaId: null,
        skillIds: [],
        mcpIds: [],
        judgeSkillIds: [],
        judgeMcpIds: [],
        judgeMcpTools: {},
        models: defaults?.models ?? [],
        judge: defaults?.judge ?? null,
      },
  );
  const {
    data: resources,
    error: resourceError,
    refresh: refreshResources,
    loading: resourcesLoading,
  } = useApi<Resources>("/resources");
  const {
    data: harnesses,
    error: harnessError,
    refresh: refreshHarnesses,
  } = useApi<Harness[]>("/harnesses");
  function setValue(next: EvalDraft) {
    drafts.set(draftKey, next);
    update(next);
  }
  const judgeHarness = harnesses?.find(
    (harness) => harness.id === value.judge?.harness,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();

    if (!value.criteria.length) {
      setError("Add at least one criterion before saving the evaluation.");
      return;
    }

    if (value.criteria.some((criterion) => !criterion.description.trim())) {
      setError("Add text to each criterion before saving the evaluation.");

      return;
    }

    if (!value.models.length) {
      setError("Add at least one model before saving the evaluation.");

      return;
    }

    if (!value.judge) {
      setError("Add a judge before saving the evaluation.");

      return;
    }

    if (
      value.judgeMcpIds.length &&
      judgeHarness &&
      !judgeHarness.judgeSupportsMcp
    ) {
      setError(
        `The ${judgeHarness.title} judge cannot use MCP servers. Remove the judge MCP servers or choose another judge harness.`,
      );

      return;
    }

    if (missingJudgeMcpTools(value)) {
      setError(
        "Name at least one tool the judge may call from each judge MCP server.",
      );

      return;
    }

    setSaving(true);
    setError("");

    try {
      const { id: _id, ...input } = { ...value, id: initial?.id };
      const saved = await api<EvaluationData>(
        initial ? `/evals/${initial.id}` : "/evals",
        { method: initial ? "PUT" : "POST", body: JSON.stringify(input) },
      );

      drafts.delete(draftKey);
      location.hash = `evals/${saved.id}`;
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageTitle title={initial ? "Edit evaluation" : "New evaluation"}>
        <Button
          nativeButton={false}
          variant="outline"
          render={
            <a
              onClick={() => drafts.delete(draftKey)}
              href={initial ? `#evals/${initial.id}` : "#evals"}
            >
              Cancel
            </a>
          }
        />
      </PageTitle>
      <p className="description">
        Define the task, criteria, and models for this evaluation.
      </p>
      <Notice error={resourceError || harnessError} />
      {harnessError && (
        <Button type="button" onClick={refreshHarnesses}>
          Retry loading harnesses
        </Button>
      )}
      <form onSubmit={save} className="editor eval-editor">
        <section>
          <h2>Task</h2>
          <p className="muted">
            Describe what the agent should do in each session.
          </p>
          <Field label="Title">
            <Input
              required
              maxLength={200}
              placeholder="Add analytics to a Next.js app"
              value={value.title}
              onChange={(event) =>
                setValue({ ...value, title: event.target.value })
              }
            />
          </Field>
          <Field label="Prompt">
            <Textarea
              required
              rows={5}
              placeholder="Configure PostHog. Capture an event when a user completes signup."
              value={value.prompt}
              onChange={(event) =>
                setValue({ ...value, prompt: event.target.value })
              }
            />
          </Field>
        </section>
        <EvalCriteria value={value} onChange={setValue} />
        <EvalModels
          value={value}
          onChange={(next) => setValue(withJudgeMcpSupport(next, harnesses))}
          harnesses={harnesses}
          showDefaultsLink={!initial}
        />
        <EvalResources
          value={value}
          onChange={setValue}
          resources={resources}
          refreshResources={refreshResources}
          resourcesLoading={resourcesLoading}
          judgeHarness={judgeHarness}
        />
        <EvalOverrides
          refreshResources={refreshResources}
          value={value}
          onChange={setValue}
          resources={resources}
        />
        <div className="form-actions">
          <Notice error={error} />
          <div className="eval-save-row">
            <p className="section-note">
              {value.criteria.length}{" "}
              {value.criteria.length === 1 ? "criterion" : "criteria"} ·{" "}
              {value.models.reduce(
                (sum, model) =>
                  sum + (Number.isFinite(model.count) ? model.count : 0),
                0,
              )}{" "}
              sessions per run · one judgment per session
            </p>
            <Button
              variant="primary"
              disabled={saving || !harnesses}
              type="submit"
            >
              {saving && <StatusIcon name="spinner" />}
              {saving ? "Saving..." : "Save evaluation"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
