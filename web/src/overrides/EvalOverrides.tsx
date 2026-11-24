import { Button } from "@posthog/quill";
import { useState } from "react";
import type { ResponseRule } from "../../../src/overrides/domain/response-override.js";
import type { EvalDraft, Resources } from "../types.js";
import { OverrideDialog } from "./OverrideDialog.js";

export function EvalOverrides({
  value,
  onChange,
  resources,
  refreshResources,
}: {
  value: EvalDraft;
  onChange: (next: EvalDraft) => void;
  resources?: Resources;
  refreshResources?: () => void;
}) {
  const [editing, setEditing] = useState<ResponseRule | "new" | null>(null);
  const rules = value.responseOverrides ?? [];
  const [created, setCreated] = useState<{ id: string; title: string }[]>([]);
  const servers = [
    ...(resources?.mcps ?? []),
    ...created.filter((s) => !resources?.mcps.some((m) => m.id === s.id)),
  ];
  const update = (responseOverrides: ResponseRule[], attach?: string) =>
    onChange({
      ...value,
      responseOverrides,
      mcpIds:
        attach && !value.mcpIds.includes(attach)
          ? [...value.mcpIds, attach]
          : value.mcpIds,
    });
  return (
    <section>
      <div className="section-heading">
        <h2>
          Response overrides <span className="muted">({rules.length})</span>
        </h2>
        <Button
          type="button"
          variant="outline"
          onClick={() => setEditing("new")}
        >
          Add override
        </Button>
      </div>
      <p className="muted">
        {rules.length
          ? "The first rule that changes a response applies."
          : "Change the response from a shell command, a web page, or an MCP tool."}
      </p>
      {rules.length > 0 && (
        <ol className="criteria-editor-list model-summary-list">
          {rules.map((rule, i) => (
            <li key={rule.id}>
              <Button
                type="button"
                className="criterion-summary"
                onClick={() => setEditing(rule)}
              >
                <span className="muted">{i + 1}</span>
                <span>
                  {rule.target.kind === "web"
                    ? rule.target.url || "All managed web fetches"
                    : rule.target.kind === "shell"
                      ? rule.decision
                        ? "Shell calls"
                        : rule.target.command
                      : rule.target.tool || "MCP tools"}
                  {rule.decision && (
                    <small className="muted">
                      Jev · {rule.decision.prompt}
                    </small>
                  )}
                  <small className="muted">
                    {rule.llmEdit
                      ? `LLM edit · ${rule.llmEdit.prompt}`
                      : `Find ${rule.find}`}
                  </small>
                </span>
              </Button>
              {i > 0 && (
                <Button
                  type="button"
                  aria-label={`Move override ${i + 1} up`}
                  onClick={() => {
                    const reordered = rules.slice();
                    reordered.splice(i, 1);
                    reordered.splice(i - 1, 0, rule);
                    update(reordered);
                  }}
                >
                  Move up
                </Button>
              )}
              <Button
                type="button"
                onClick={() => update(rules.filter((r) => r.id !== rule.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <OverrideDialog
          evaluationTitle={value.title}
          initial={editing === "new" ? undefined : editing}
          servers={servers}
          selectedServerIds={value.mcpIds}
          onCreateServer={(s) => {
            setCreated((previous) => [...previous, s]);
            refreshResources?.();
          }}
          onClose={() => setEditing(null)}
          onApply={(rule) =>
            update(
              editing === "new"
                ? [...rules, rule]
                : rules.map((r) => (r.id === rule.id ? rule : r)),
              rule.target.kind === "mcp" ? rule.target.serverId : undefined,
            )
          }
        />
      )}
    </section>
  );
}
