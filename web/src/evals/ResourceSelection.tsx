import { Button, Checkbox, Input } from "@posthog/quill";
import { useId, useState } from "react";
import { useApi } from "../api.js";
import { Choice } from "../Choice.js";
import { McpConnection } from "../resources/McpConnection.js";
import { type ResourceKind, resourceInfo } from "../resources/resource-info.js";
import type { EvalDraft, Harness, Resource } from "../types.js";

export type ResourceTarget = "agent" | "judge";

// The judge MCP picker is hidden for judges without MCP support, so clear the selection
// on a harness change. Otherwise nothing on screen could remove the IDs that block saving.
export function withJudgeMcpSupport(
  value: EvalDraft,
  harnesses: Harness[] | undefined,
): EvalDraft {
  const judgeHarness = harnesses?.find(
    (harness) => harness.id === value.judge?.harness,
  );

  return judgeHarness &&
    !judgeHarness.judgeSupportsMcp &&
    value.judgeMcpIds.length
    ? { ...value, judgeMcpIds: [], judgeMcpTools: {} }
    : value;
}

// Judge MCP tools are auto-approved, so the judge may call only the tools named here.
export function missingJudgeMcpTools(value: EvalDraft): boolean {
  return value.judgeMcpIds.some((id) => !value.judgeMcpTools[id]?.length);
}

function RemoteJudgeTools({
  resource,
  selected,
  onChange,
}: {
  resource: Resource;
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const prefix = useId();
  const { data, error, refresh } = useApi<{
    status: string;
    tools?: { name: string; description: string; readOnly: boolean }[];
  }>(`/resources/${resource.id}/connection?tools=1`);
  return (
    <fieldset>
      <legend>Allowed judge tools</legend>
      <Button type="button" onClick={refresh}>
        Refresh tool list
      </Button>
      {error || data?.status !== "ready" ? (
        <p>
          {data || error
            ? "Connect the server to load its tools."
            : "Loading tools…"}
        </p>
      ) : (
        !data.tools?.length && <p>This server lists no tools.</p>
      )}
      {[
        ...new Set([
          ...selected,
          ...(data?.tools ?? []).map((tool) => tool.name),
        ]),
      ].map((name) => {
        const tool = data?.tools?.find((tool) => tool.name === name);
        return (
          <label className="checkbox" key={name} htmlFor={prefix + name}>
            <Checkbox
              id={prefix + name}
              checked={selected.includes(name)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, name]
                    : selected.filter((item) => item !== name),
                )
              }
            />
            {name} {tool?.readOnly && "(read-only)"} {tool?.description}
          </label>
        );
      })}
    </fieldset>
  );
}
function JudgeMcpTools({
  resource,
  tools,
  onChange,
}: {
  resource: Resource;
  tools: string[];
  onChange: (tools: string[]) => void;
}) {
  // Keep the typed text so separators are not dropped while the user types.
  const [text, setText] = useState(tools.join(", "));

  if (resource.url)
    return (
      <RemoteJudgeTools
        resource={resource}
        selected={tools}
        onChange={onChange}
      />
    );
  return (
    <Input
      className="judge-mcp-tools"
      aria-label={`Tools the judge may call from ${resource.title}`}
      placeholder="Allowed tools, comma separated (required)"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange([
          ...new Set(
            event.target.value
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean),
          ),
        ]);
      }}
    />
  );
}

// Agent and judge selections reuse the same library but save to separate fields.
export function selectionField(
  kind: "skills" | "mcps",
  target: ResourceTarget,
) {
  if (target === "judge")
    return kind === "skills" ? "judgeSkillIds" : "judgeMcpIds";

  return kind === "skills" ? "skillIds" : "mcpIds";
}

export function ResourceSelection({
  kind,
  resources,
  value,
  onChange,
  onCreate,
  loading,
  target = "agent",
  unavailable,
}: {
  kind: ResourceKind;
  resources: Resource[];
  value: EvalDraft;
  onChange: (value: EvalDraft) => void;
  onCreate: () => void;
  loading: boolean;
  target?: ResourceTarget;
  unavailable?: string;
}) {
  const id = useId();
  const multiple = kind === "skills" || kind === "mcps";
  const info = resourceInfo[kind];

  return (
    <div className="resource-selection">
      <div className="section-heading">
        <h3 id={id}>
          {multiple
            ? info.title
            : kind === "environments"
              ? "Environment"
              : "Persona"}
        </h3>
        <Button type="button" disabled={!!unavailable} onClick={onCreate}>
          Create {info.singular}
        </Button>
      </div>
      {unavailable ? (
        <p className="muted">{unavailable}</p>
      ) : multiple ? (
        <div className="resource-options">
          {resources.length === 0 && (
            <p className="muted">
              {loading
                ? "Loading resources…"
                : `No ${info.title.toLowerCase()} yet.`}
            </p>
          )}
          {resources.map((resource) => {
            const key = selectionField(kind, target);
            const checked = value[key].includes(resource.id);
            const judgeMcp = kind === "mcps" && target === "judge";

            return (
              <div key={resource.id}>
                <label className="checkbox" htmlFor={`${id}-${resource.id}`}>
                  <Checkbox
                    id={`${id}-${resource.id}`}
                    checked={checked}
                    onCheckedChange={(next) => {
                      const { [resource.id]: _removed, ...judgeMcpTools } =
                        value.judgeMcpTools;

                      onChange({
                        ...value,
                        [key]: next
                          ? [...value[key], resource.id]
                          : value[key].filter((id) => id !== resource.id),
                        ...(judgeMcp && !next ? { judgeMcpTools } : {}),
                      });
                    }}
                  />
                  {resource.title}
                </label>
                {kind === "mcps" && checked && resource.url && (
                  <McpConnection id={resource.id} />
                )}
                {judgeMcp && checked && (
                  <JudgeMcpTools
                    resource={resource}
                    tools={value.judgeMcpTools[resource.id] ?? []}
                    onChange={(tools) =>
                      onChange({
                        ...value,
                        judgeMcpTools: {
                          ...value.judgeMcpTools,
                          [resource.id]: tools,
                        },
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Choice
          aria-labelledby={id}
          value={
            (kind === "environments" ? value.environmentId : value.personaId) ??
            ""
          }
          onValueChange={(next) =>
            onChange({
              ...value,
              [kind === "environments" ? "environmentId" : "personaId"]:
                next || null,
            })
          }
          options={[
            {
              value: "",
              label: kind === "environments" ? "Empty workspace" : "No persona",
            },
            ...resources.map((resource) => ({
              value: resource.id,
              label: resource.title,
            })),
          ]}
        />
      )}
    </div>
  );
}
