import {
  Button,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@posthog/quill";
import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ResponseCapture,
  ResponseRule,
  RewriteResult,
  Target,
} from "../../../src/overrides/domain/response-override.js";
import {
  editFromSample,
  literalEdit,
  singlePassage,
} from "../../../src/overrides/domain/sample-edit.js";
import { shellCommands } from "../../../src/overrides/domain/shell-commands.js";
import type { ToolExample } from "../../../src/sessions/domain/tool-example.js";
import { api, useApi } from "../api.js";
import { Choice } from "../Choice.js";
import { Field, Notice } from "../components.js";
import { Dialog } from "../Dialog.js";
import { ResourceDialog } from "../evals/ResourceDialog.js";
import { TranscriptFilterIcon } from "../sessions/transcript/TranscriptFilterIcon.js";
import { ModelEvidence } from "./ModelEvidence.js";
import { OverrideEngines } from "./OverrideEngines.js";
import { callOrigin, PreviousCalls } from "./PreviousCalls.js";
import { RegexInput } from "./RegexInput.js";
import { ResponseComparison } from "./ResponseComparison.js";
import { displayResponse, previewText } from "./response-text.js";

type Server = { id: string; title: string };
function McpToolName({
  target,
  onChange,
}: {
  target: Extract<Target, { kind: "mcp" }>;
  onChange: (value: Target) => void;
}) {
  const { data } = useApi<string[]>(`/tool-calls/mcp/${target.serverId}/tools`);
  const id = useId();
  return (
    <>
      <Field label="Tool name">
        <Input
          list={id}
          placeholder="All tools on this server"
          value={target.tool ?? ""}
          onChange={(e) =>
            onChange({ ...target, tool: e.target.value || undefined })
          }
        />
      </Field>
      <datalist id={id}>
        {data?.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}
function defaultTarget(target: Target): Target {
  if (target.kind !== "shell") return target;
  const first = shellCommands(target.command)[0];
  return first ? { kind: "shell", match: "command", command: first } : target;
}

function ShellScope({
  batch,
  target,
  onChange,
}: {
  batch: string;
  target: Extract<Target, { kind: "shell" }>;
  onChange: (target: Target) => void;
}) {
  const commands = useMemo(() => shellCommands(batch), [batch]);
  const name = useId();
  const options = commands.map(
    (command) => ({ kind: "shell", match: "command", command }) as const,
  );
  return (
    <fieldset className="shell-scope">
      <legend>Match future shell calls</legend>
      {[
        ...options,
        { kind: "shell", match: "batch", command: batch } as const,
      ].map((option) => (
        <label key={option.match + option.command}>
          <input
            type="radio"
            name={name}
            checked={
              target.match === option.match && target.command === option.command
            }
            onChange={() => onChange(option)}
          />
          {option.match === "batch" ? (
            <span>Entire call</span>
          ) : (
            <code>{option.command}</code>
          )}
        </label>
      ))}
      <p className="muted">
        {target.match === "command"
          ? "Match any call that contains this command. Edit the combined output below."
          : "Match the full command line. Edit the combined output below."}
      </p>
    </fieldset>
  );
}
function initialRule(
  target: Target,
  original: unknown,
  selection?: string,
): ResponseRule {
  return {
    id: crypto.randomUUID(),
    target: defaultTarget(target),
    mode: "text",
    ...editFromSample(original, target, selection),
    inputContains: "",
    outputContains: "",
  };
}
export function OverrideDialog({
  initial,
  sample,
  selection,
  inline = false,
  servers,
  selectedServerIds,
  onCreateServer,
  onApply,
  onClose,
  evaluationTitle,
  applyLabel = "Apply override",
}: {
  initial?: ResponseRule | undefined;
  sample?: ResponseCapture | undefined;
  selection?: string | undefined;
  inline?: boolean;
  servers: Server[];
  selectedServerIds?: string[];
  onCreateServer?: (server: Server) => void;
  onApply: (rule: ResponseRule) => void | Promise<void>;
  onClose: () => void;
  evaluationTitle?: string;
  applyLabel?: string;
}) {
  const [rule, setRule] = useState(
    () =>
      initial ??
      initialRule(
        sample?.target ?? { kind: "web" },
        sample?.original,
        selection,
      ),
  );
  const [picked, setPicked] = useState<
    | {
        title: string;
        origin?: string;
        inputOmitted?: boolean | undefined;
        sessionId?: string;
        input: Record<string, unknown>;
        output: unknown;
        target?: Target;
      }
    | undefined
  >(() =>
    sample
      ? {
          title: sample.route,
          input: sample.args,
          inputOmitted: sample.inputOmitted,
          output: sample.original,
          target: sample.target,
        }
      : undefined,
  );
  const [step, setStep] = useState<"choose" | "edit" | "changeSample">(
    sample || initial ? "edit" : "choose",
  );
  const [targetChosen, setTargetChosen] = useState(Boolean(sample || initial));
  const [method, setMethod] = useState<"direct" | "pattern">(
    initial || selection ? "pattern" : "direct",
  );
  const [directText, setDirectText] = useState<string>();
  const [editIssue, setEditIssue] = useState("");
  const formId = useId();
  const passage = useMemo(() => {
    const field = singlePassage(picked?.output, picked?.target);
    if (!field) return;
    const newline = field.text.match(/\r\n|[\r\n]/)?.[0] ?? "\n";
    if (/[\r\n]/.test(field.text.replaceAll(newline, ""))) return;
    return { ...field, newline };
  }, [picked]);
  const usesModel = !!rule.decision;
  const direct = method === "direct" && !!passage;
  const [example, setExample] = useState("");
  const [args, setArgs] = useState("");
  const [newServer, setNewServer] = useState(false);
  const [result, setResult] = useState<RewriteResult>();
  const previewRequest = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const source = rule.target;
  const validServer =
    source.kind !== "mcp" ||
    servers.some((server) => server.id === source.serverId);
  const editedText = useRef(Boolean(initial || selection));
  const editedTarget = useRef(false);
  const change = (patch: Partial<ResponseRule>) => {
    if (patch.target) editedTarget.current = true;
    if (
      "find" in patch ||
      "replacement" in patch ||
      "mode" in patch ||
      ("path" in patch && !patch.target)
    ) {
      editedText.current = true;
    }
    setRule((r) => ({ ...r, ...patch }));
  };
  const sameText = rule.mode === "text" && rule.find === rule.replacement;
  const canApply =
    !busy &&
    (!rule.decision || Boolean(rule.decision.prompt.trim())) &&
    !editIssue &&
    !!rule.find &&
    !sameText &&
    targetChosen &&
    validServer &&
    (source.kind !== "shell" ||
      !!rule.decision ||
      Boolean(source.command.trim()));
  const hasSample = Boolean(picked) || Boolean(example);
  const preview = useMemo(() => {
    try {
      const input =
        picked?.input ??
        (args.trim()
          ? JSON.parse(args)
          : source.kind === "web" && source.url
            ? { url: source.url }
            : {});
      const sampleTarget =
        picked?.target ??
        (source.kind === "shell" && typeof input?.command === "string"
          ? { ...source, command: input.command }
          : source);
      let original: unknown = picked ? picked.output : example;
      if (sampleTarget.kind === "mcp") {
        if (typeof original === "string") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch {
            /* A single text block can be entered as plain text. */
          }
          original =
            parsed &&
            typeof parsed === "object" &&
            ("content" in parsed || "structuredContent" in parsed)
              ? parsed
              : { content: [{ type: "text", text: original }] };
        } else if (
          !original ||
          typeof original !== "object" ||
          !("content" in original || "structuredContent" in original)
        )
          original = {
            content: [{ type: "text", text: displayResponse(original) }],
          };
      } else if (typeof original !== "string")
        original = displayResponse(original);
      return {
        body: JSON.stringify({
          rule,
          target: sampleTarget,
          args: input,
          original,
        }),
        original: previewText(original, rule.path),
        issue: "",
      };
    } catch {
      return {
        body: "",
        original: example,
        issue: "Enter the call input as a JSON object.",
      };
    }
  }, [rule, source, picked, args, example]);
  async function previewWithModel() {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setChecking(true);
    setResult(undefined);
    setError("");
    try {
      if (preview.issue) throw new Error(preview.issue);
      const value = await api<RewriteResult>(
        "/evals/response-overrides/preview",
        { method: "POST", body: preview.body, signal: controller.signal },
      );
      if (!controller.signal.aborted) setResult(value);
    } catch (err) {
      if (!controller.signal.aborted) setError(String(err));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  useEffect(() => {
    setChecking(false);
    setError("");
    setResult(undefined);
    if (usesModel) return () => previewRequest.current?.abort();
    if (!rule.find || !hasSample || !validServer || sameText) return;
    if (preview.issue) {
      setError(preview.issue);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void api<NonNullable<typeof result>>(
          "/evals/response-overrides/preview",
          { method: "POST", body: preview.body, signal: controller.signal },
        )
          .then((value) => {
            if (!controller.signal.aborted) setResult(value);
          })
          .catch((err) => {
            if (!controller.signal.aborted) setError(String(err));
          }),
      180,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [preview, rule.find, hasSample, validServer, sameText, usesModel]);
  function choose(call: ToolExample) {
    setPicked({
      title: call.tool || call.name,
      origin: callOrigin(call),
      sessionId: call.sessionId,
      input: call.input,
      output: call.sample,
      ...(call.target && { target: call.target }),
    });
    setMethod(editedText.current ? "pattern" : "direct");
    setDirectText(undefined);
    setEditIssue("");
    if (!initial) {
      const keepTarget =
        targetChosen && (editedTarget.current || editedText.current);
      const target = keepTarget
        ? rule.target
        : call.target && defaultTarget(call.target);
      const draft = editedText.current
        ? rule
        : editFromSample(call.sample, call.target);
      setRule({
        ...rule,
        target: target ?? { kind: "web" },
        find: draft.find,
        replacement: draft.replacement,
        path: target?.kind === "mcp" ? draft.path : "",
      });
      setTargetChosen(Boolean(target));
    }
    setStep("edit");
  }
  async function apply(e: FormEvent) {
    e.preventDefault();
    if (!canApply) return;
    setBusy(true);
    setSaveError("");
    try {
      if (preview.issue) throw new Error(preview.issue);
      if (!usesModel) {
        const check = await api<{ error?: string; ruleId?: string }>(
          "/evals/response-overrides/preview",
          { method: "POST", body: preview.body },
        );
        if (check.error) throw new Error(check.error);
        if (inline && !check.ruleId)
          throw new Error("Edit text that matches this response.");
      }
      await onApply(rule);
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (step !== "edit")
    return (
      <PreviousCalls
        returning={step === "changeSample"}
        onClose={step === "changeSample" ? () => setStep("edit") : onClose}
        onChoose={choose}
        onManual={() => {
          setPicked(undefined);
          setDirectText(undefined);
          setEditIssue("");
          setMethod("pattern");
          setStep("edit");
        }}
      />
    );
  const delivered =
    result && !result.error
      ? previewText(result.value, rule.path)
      : preview.original;
  const destination = !targetChosen
    ? "Choose a destination"
    : source.kind === "web"
      ? (source.url ?? "All web fetches")
      : source.kind === "shell"
        ? rule.decision
          ? "Shell calls"
          : source.command || "Shell command"
        : [
            servers.find((s) => s.id === source.serverId)?.title ??
              "Choose an MCP server",
            source.tool ?? "All tools",
          ].join(" · ");
  const inputSummary =
    picked && (picked.input.command ?? picked.input.url ?? picked.input.query);
  const appliedPassage =
    direct && result?.ruleId
      ? (singlePassage(result.value, picked?.target)?.text ?? "")
      : undefined;
  function updateResponse(value: string) {
    if (!passage) return;
    const output = value.replaceAll("\n", passage.newline);
    setDirectText(output);
    const edit = literalEdit(passage.text, output);
    if (!edit) {
      change({ find: "", replacement: "" });
      setEditIssue(
        "This change exceeds the rule limit. Edit a shorter passage.",
      );
      return;
    }
    setEditIssue("");
    change({
      ...edit,
      mode: "text",
      path: source.kind === "mcp" ? passage.path : "",
    });
  }
  const status = !hasSample
    ? ""
    : editIssue ||
      error ||
      result?.error ||
      (usesModel
        ? checking
          ? "Checking the sample…"
          : result
            ? result.ruleId
              ? "The rule changes this sample."
              : "The rule leaves this sample unchanged."
            : ""
        : !rule.find || sameText
          ? direct
            ? "Edit the response for the agent."
            : "Enter the text to replace."
          : !validServer
            ? "Select an MCP server."
            : result?.ruleId
              ? "The rule changes this sample."
              : result
                ? "This rule leaves the sample unchanged."
                : "Checking this edit…");
  const footer = (
    <>
      <span className="override-footer-start muted">
        {evaluationTitle
          ? `Future agent sessions of ${evaluationTitle}`
          : "Applies to future agent sessions."}
      </span>
      <Button type="button" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button
        type="submit"
        form={formId}
        variant="primary"
        disabled={!canApply}
      >
        {applyLabel}
      </Button>
    </>
  );
  const shellScope =
    source.kind === "shell" && picked?.target?.kind === "shell" ? (
      <ShellScope
        batch={picked.target.command}
        target={source}
        onChange={(target) => change({ target })}
      />
    ) : null;
  const form = (
    <form id={formId} className="override-form" onSubmit={apply}>
      {!inline && (
        <div className="override-workbar">
          <div className="override-call-context">
            <span className="override-tool-icon">
              <TranscriptFilterIcon
                kind={picked?.target?.kind === "web" ? "web" : "tool"}
              />
            </span>
            <div>
              <div className="override-call-title">
                <strong>{picked?.title ?? "Sample response"}</strong>
                {typeof inputSummary === "string" && (
                  <code title={inputSummary}>{inputSummary}</code>
                )}
              </div>
              {picked?.origin && <small>{picked.origin}</small>}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep("changeSample")}
          >
            {picked ? "Change sample" : "Choose a call"}
          </Button>
        </div>
      )}
      {!inline && picked && (
        <details className="call-input-details">
          <summary>Call input</summary>
          <pre>
            {picked.inputOmitted
              ? "The input exceeds the recording limit."
              : displayResponse(picked.input)}
          </pre>
          {picked.sessionId && (
            <a
              href={`#sessions/${picked.sessionId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open session
            </a>
          )}
        </details>
      )}
      <section className="override-workspace">
        <OverrideEngines
          decision={rule.decision}
          change={(patch) => {
            setEditIssue("");
            change(patch);
          }}
        />
        {inline && !rule.decision && shellScope}
        <div className="override-workspace-heading">
          {!inline && (
            <details
              className="override-scope"
              data-needs-target={!targetChosen}
              key={picked ? "sample" : "manual"}
              open={!picked || undefined}
            >
              <summary>
                <TranscriptFilterIcon kind="settings" />
                <strong>Apply to</strong>
                <span>{destination}</span>
              </summary>
              <div className="override-target-settings">
                {!targetChosen && picked && (
                  <p className="muted">
                    {picked.title} supplies the sample. Select the tool that
                    should return the edited response.
                  </p>
                )}
                <Tabs
                  value={targetChosen ? source.kind : ""}
                  onValueChange={(v) => {
                    setTargetChosen(true);
                    change({
                      target:
                        v === "web"
                          ? { kind: "web" }
                          : v === "shell"
                            ? picked?.target?.kind === "shell"
                              ? defaultTarget(picked.target)
                              : { kind: "shell", match: "command", command: "" }
                            : { kind: "mcp", serverId: servers[0]?.id ?? "" },
                      path: "",
                    });
                  }}
                >
                  <TabsList aria-label="Tool source">
                    <TabsTrigger value="web">Web fetch</TabsTrigger>
                    <TabsTrigger value="mcp">MCP tool</TabsTrigger>
                    <TabsTrigger value="shell">Shell</TabsTrigger>
                  </TabsList>
                </Tabs>
                {!targetChosen ? null : source.kind === "web" ? (
                  <>
                    <Field label="Page URL">
                      <Input
                        type="url"
                        value={source.url ?? ""}
                        placeholder="https://posthog.com/docs"
                        onChange={(e) =>
                          change({
                            target: {
                              kind: "web",
                              url: e.target.value || undefined,
                            },
                          })
                        }
                      />
                    </Field>
                    <p className="muted">
                      Leave the URL empty to match all pages.
                    </p>
                  </>
                ) : source.kind === "shell" ? (
                  rule.decision ? null : (
                    (shellScope ?? (
                      <Field
                        label={
                          source.match === "batch"
                            ? "Full command line"
                            : "Command to match"
                        }
                      >
                        <Textarea
                          value={source.command}
                          placeholder="npm install posthog-js"
                          onChange={(e) =>
                            change({
                              target: { ...source, command: e.target.value },
                            })
                          }
                        />
                      </Field>
                    ))
                  )
                ) : (
                  <>
                    <div className="form-grid">
                      {servers.length > 0 && (
                        <Field label="MCP server">
                          <Choice
                            value={source.serverId}
                            options={servers.map((s) => ({
                              value: s.id,
                              label: s.title,
                            }))}
                            onValueChange={(serverId) =>
                              change({ target: { kind: "mcp", serverId } })
                            }
                          />
                        </Field>
                      )}
                      {source.serverId && validServer && (
                        <McpToolName
                          target={source}
                          onChange={(target) => change({ target })}
                        />
                      )}
                    </div>
                    {!validServer && (
                      <p className="muted">
                        {servers.length
                          ? "Select a saved MCP server."
                          : "Add an MCP server to select its tools."}
                      </p>
                    )}
                    {onCreateServer && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setNewServer(true)}
                      >
                        Add MCP server
                      </Button>
                    )}
                    {validServer &&
                      selectedServerIds &&
                      !selectedServerIds.includes(source.serverId) && (
                        <p className="muted">
                          Saving this rule adds the server to the agent
                          resources.
                        </p>
                      )}
                  </>
                )}
                {!rule.decision && (
                  <details
                    className="override-conditions"
                    open={
                      initial?.inputContains ||
                      initial?.outputContains ||
                      initial?.path
                        ? true
                        : undefined
                    }
                  >
                    <summary>Additional match conditions</summary>
                    <Field label="Only when the call input contains">
                      <Input
                        placeholder="A URL, file name, or search term"
                        value={rule.inputContains}
                        onChange={(e) =>
                          change({ inputContains: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Only when the response contains">
                      <Input
                        placeholder="Text that identifies the response"
                        value={rule.outputContains}
                        onChange={(e) =>
                          change({ outputContains: e.target.value })
                        }
                      />
                    </Field>
                    {source.kind === "mcp" && (
                      <Field label="Edit one field in the structured response (JSON Pointer)">
                        <Input
                          placeholder="/instructions/setup"
                          value={rule.path}
                          onChange={(e) => change({ path: e.target.value })}
                        />
                      </Field>
                    )}
                  </details>
                )}
              </div>
            </details>
          )}
          {passage && (
            <Tabs
              value={direct ? "direct" : "pattern"}
              onValueChange={(value) => {
                setDirectText(undefined);
                setEditIssue("");
                setMethod(value === "direct" ? "direct" : "pattern");
              }}
            >
              <TabsList aria-label="Edit method">
                <TabsTrigger value="direct">Edit response</TabsTrigger>
                <TabsTrigger value="pattern">Find and replace</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>
        {!direct && (
          <div className="override-pattern">
            <Tabs
              value={rule.mode}
              onValueChange={(v) =>
                change({ mode: v === "regex" ? "regex" : "text" })
              }
            >
              <TabsList aria-label="Match method">
                <TabsTrigger value="text">Exact text</TabsTrigger>
                <TabsTrigger value="regex">Regular expression</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="override-fields">
              {rule.mode === "text" ? (
                <Field label="Find in the response">
                  <Textarea
                    required
                    rows={picked && rule.find.includes("\n") ? 5 : 2}
                    placeholder="Text to find"
                    value={rule.find}
                    onChange={(e) => change({ find: e.target.value })}
                  />
                </Field>
              ) : (
                <div>
                  <strong>Find pattern</strong>
                  <RegexInput
                    value={rule.find}
                    onChange={(find) => change({ find })}
                  />
                </div>
              )}
              <Field label="Replace each match with">
                <Textarea
                  rows={picked && rule.replacement.includes("\n") ? 5 : 2}
                  value={rule.replacement}
                  placeholder="Leave empty to delete the match"
                  onChange={(e) => change({ replacement: e.target.value })}
                />
              </Field>
            </div>
            {rule.mode === "regex" && (
              <p className="muted">
                Use RE2 syntax. Use $1 in the replacement to insert the first
                capture group.
              </p>
            )}
          </div>
        )}
        {!picked && (
          <div className="manual-sample">
            <Field label="Sample output (optional)">
              <Textarea
                rows={3}
                value={example}
                placeholder="Paste the tool response to preview this rule."
                onChange={(e) => setExample(e.target.value)}
              />
            </Field>
            {(rule.inputContains || rule.decision) && (
              <Field label="Sample call input">
                <Input
                  value={args}
                  placeholder={
                    source.kind === "shell"
                      ? '{"command":"npm install lodash posthog-js"}'
                      : source.kind === "web"
                        ? '{"url":"https://posthog.com/docs"}'
                        : '{"query":"Next.js"}'
                  }
                  onChange={(e) => setArgs(e.target.value)}
                />
              </Field>
            )}
          </div>
        )}
        {usesModel && hasSample && (
          <Button
            type="button"
            variant="outline"
            disabled={checking || !canApply}
            onClick={previewWithModel}
          >
            {checking ? "Checking sample…" : "Preview with model"}
          </Button>
        )}
        {result && <ModelEvidence {...result} />}
        {hasSample && (
          <ResponseComparison
            before={direct ? passage.text : preview.original}
            after={
              direct
                ? (directText ?? appliedPassage ?? passage.text)
                : delivered
            }
            onEdit={direct ? updateResponse : undefined}
          />
        )}
        {status && (
          <output
            className="override-status"
            data-changed={!!result?.ruleId && !editIssue}
            data-error={!!(editIssue || error || result?.error)}
          >
            <span aria-hidden="true">
              {editIssue || error || result?.error
                ? "!"
                : result?.ruleId
                  ? "✓"
                  : "·"}
            </span>
            {status}
          </output>
        )}
      </section>
      <Notice error={saveError} />
    </form>
  );
  if (inline)
    return (
      <section
        className="trace-intercept-editor"
        aria-label="Create response override"
      >
        <h3>Intercept this response</h3>
        {form}
        <footer>{footer}</footer>
      </section>
    );
  return (
    <Dialog
      title={initial ? "Edit response override" : "Create response override"}
      className="override-dialog"
      busy={busy}
      onClose={onClose}
      footer={footer}
    >
      {form}
      {newServer && onCreateServer && (
        <ResourceDialog
          kind="mcps"
          onClose={() => setNewServer(false)}
          onSaved={(server) => {
            onCreateServer(server);
            change({ target: { kind: "mcp", serverId: server.id } });
            setNewServer(false);
          }}
        />
      )}
    </Dialog>
  );
}
