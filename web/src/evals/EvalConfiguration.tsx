import { ModelKey, ModelReference } from "../models/ModelReference.js";
import type { EvaluationData, Resources, Session } from "../types.js";

export function EvalConfiguration({
  definition,
  snapshot,
  resources: data,
  recordedModels,
}: {
  recordedModels?: string[];
  definition: EvaluationData;
  resources: Resources | undefined;
  snapshot?: Session["snapshot"];
}) {
  const environment = snapshot
    ? snapshot.environment?.title
    : data?.environments.find((item) => item.id === definition.environmentId)
        ?.title;
  const persona = snapshot
    ? snapshot.persona?.title
    : data?.personas.find((item) => item.id === definition.personaId)?.title;
  const skills =
    snapshot?.skills ??
    data?.skills.filter((item) => definition.skillIds.includes(item.id));
  const mcps =
    snapshot?.mcps ??
    data?.mcps.filter((item) => definition.mcpIds.includes(item.id));
  // Older evals and session snapshots have no judge resources.
  const judgeSkillIds = definition.judgeSkillIds ?? [];
  const judgeMcpIds = definition.judgeMcpIds ?? [];
  const judgeResources = [
    ...(snapshot
      ? (snapshot.judgeSkills ?? [])
      : (data?.skills.filter((item) => judgeSkillIds.includes(item.id)) ?? [])),
    ...(snapshot
      ? (snapshot.judgeMcps ?? [])
      : (data?.mcps.filter((item) => judgeMcpIds.includes(item.id)) ?? [])),
  ];
  const judgeResourceCount = judgeSkillIds.length + judgeMcpIds.length;

  return (
    <aside className="context-panel">
      <h2>{snapshot ? "Run configuration" : "Configuration"}</h2>
      <dl>
        <dt>Revision</dt>
        <dd>{definition.revision}</dd>
        {recordedModels ? (
          <>
            <dt>Recorded {recordedModels.length === 1 ? "agent" : "agents"}</dt>
            {recordedModels.map((model) => (
              <dd key={model}>
                <ModelKey value={model} />
              </dd>
            ))}
          </>
        ) : (
          <>
            <dt>Environment</dt>
            <dd>
              {environment ??
                (definition.environmentId ? "Unavailable" : "Empty workspace")}
            </dd>
            <dt>Persona</dt>
            <dd>
              {persona ?? (definition.personaId ? "Unavailable" : "None")}
            </dd>
            <dt>Skills</dt>
            <dd>
              {skills?.map((item) => item.title).join(", ") ||
                (definition.skillIds.length
                  ? `${definition.skillIds.length} selected`
                  : "None")}
            </dd>
            <dt>MCP servers</dt>
            <dd>
              {mcps?.map((item) => item.title).join(", ") ||
                (definition.mcpIds.length
                  ? `${definition.mcpIds.length} selected`
                  : "None")}
            </dd>
            {!!definition.responseOverrides?.length && (
              <>
                <dt>Response overrides</dt>
                <dd>{definition.responseOverrides.length}</dd>
              </>
            )}
            <dt>Session models</dt>
            {!definition.models.length && <dd>None</dd>}
            {definition.models.map((model, index) => (
              <dd key={`${index}-${model.model}`}>
                <ModelReference harness={model.harness} model={model.model} />
                <small>
                  {model.count} {model.count === 1 ? "session" : "sessions"} ·{" "}
                  {model.effort} effort
                </small>
              </dd>
            ))}
          </>
        )}
        <dt>Judge</dt>
        <dd>
          <ModelReference
            harness={definition.judge.harness}
            model={definition.judge.model}
          />
          {(judgeResources.length > 0 || judgeResourceCount > 0) && (
            <small>
              {judgeResources.map((item) => item.title).join(", ") ||
                `${judgeResourceCount} judge resources selected`}
            </small>
          )}
        </dd>
      </dl>
    </aside>
  );
}
