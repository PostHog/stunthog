import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@posthog/quill";
import { ModelReference } from "../models/ModelReference.js";
import type { Session } from "../types.js";

type Snapshot = Session["snapshot"];

function Resources({
  skills,
  mcps,
}: {
  skills: Snapshot["skills"];
  mcps: NonNullable<Snapshot["judgeMcps"]>;
}) {
  return (
    <dl className="configuration-fields">
      <div>
        <dt>Skills</dt>
        <dd>
          {skills.length ? (
            <ul>
              {skills.map((skill, index) => (
                <li key={`${index}-${skill.title}`}>{skill.title}</li>
              ))}
            </ul>
          ) : (
            "None"
          )}
        </dd>
      </div>
      <div>
        <dt>MCP servers</dt>
        <dd>
          {mcps.length ? (
            <ul>
              {mcps.map((mcp, index) => (
                <li key={`${index}-${mcp.title}`}>
                  {mcp.title}
                  <small>{mcp.url ?? mcp.command}</small>
                  {mcp.allowedTools !== undefined && (
                    <small>
                      Allowed tools: {mcp.allowedTools.join(", ") || "None"}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            "None"
          )}
        </dd>
      </div>
    </dl>
  );
}

export function ConfigurationPanel({ session }: { session: Session }) {
  const { snapshot } = session;
  const { evaluation, environment, persona } = snapshot;
  const { judge } = evaluation;

  return (
    <div className="configuration-summary">
      <section className="configuration-group">
        <h2>Evaluation</h2>
        <p className="muted">
          This session uses revision {evaluation.revision}. Later edits do not
          change these settings.
        </p>
        {session.origin !== "organic" && (
          <dl className="configuration-fields">
            <div>
              <dt>Environment</dt>
              <dd>{environment?.title ?? "Empty workspace"}</dd>
            </div>
            <div>
              <dt>Execution engine</dt>
              <dd>
                {environment?.executionMode === "docker" ? "Docker" : "Local"}
              </dd>
            </div>
            <div>
              <dt>Workspace source</dt>
              <dd>
                {environment?.repositoryUrl ??
                  environment?.workspacePath ??
                  "Empty workspace"}
              </dd>
            </div>
            {environment?.executionMode === "docker" && (
              <div>
                <dt>Dockerfile</dt>
                <dd>
                  {environment.dockerfilePath ??
                    (environment.dockerfileContent
                      ? "Inline Dockerfile"
                      : "Built-in image")}
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>
      <section className="configuration-group">
        <h2>Agent</h2>
        <ModelReference harness={session.harness} model={session.model} />
        {session.origin === "organic" ? (
          <p className="muted">The agent ran outside this evaluation.</p>
        ) : (
          <>
            <dl className="configuration-fields">
              <div>
                <dt>Persona</dt>
                <dd>
                  {persona?.title ?? "None"}
                  {persona && (
                    <p className="preserve-lines">{persona.description}</p>
                  )}
                </dd>
              </div>
            </dl>
            <Resources skills={snapshot.skills} mcps={snapshot.mcps} />
          </>
        )}
      </section>
      <section className="configuration-group">
        <h2>Judge</h2>
        <ModelReference harness={judge.harness} model={judge.model} />
        <Resources
          skills={snapshot.judgeSkills ?? []}
          mcps={snapshot.judgeMcps ?? []}
        />
      </section>
      <Collapsible>
        <CollapsibleTrigger>Full configuration (JSON)</CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="configuration">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
