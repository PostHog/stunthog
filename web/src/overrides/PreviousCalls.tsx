import { Button, Input } from "@posthog/quill";
import { useEffect, useState } from "react";
import type {
  ToolExample,
  ToolExampleSummary,
} from "../../../src/sessions/domain/tool-example.js";
import { api } from "../api.js";
import { Choice } from "../Choice.js";
import { Notice } from "../components.js";
import { Dialog } from "../Dialog.js";
import { modelDisplayName } from "../models/ModelReference.js";
import { TranscriptFilterIcon } from "../sessions/transcript/TranscriptFilterIcon.js";
import { displayResponse, previewText } from "./response-text.js";

const harnesses: Record<string, string> = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export function callOrigin(call: ToolExample | ToolExampleSummary) {
  return [
    call.evaluation,
    harnesses[call.harness] ?? call.harness,
    call.phase === "judge" ? "Judge" : "Agent",
  ].join(" · ");
}

export function PreviousCalls({
  onChoose,
  onManual,
  onClose,
  returning,
}: {
  onChoose: (call: ToolExample) => void;
  onManual: () => void;
  onClose: () => void;
  returning: boolean;
}) {
  const [query, setQuery] = useState("");
  const [harness, setHarness] = useState("all");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState<number>();
  const [rows, setRows] = useState<ToolExampleSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number>();
  const [detail, setDetail] = useState<ToolExample>();
  const [detailError, setDetailError] = useState("");
  const id =
    rows.find((r) => r.id === selected)?.id ??
    rows.find((r) => r.hasOutput)?.id ??
    rows[0]?.id;
  const call = detail?.id === id ? detail : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setBusy(true);
    const timer = setTimeout(() => {
      void api<{ calls: ToolExampleSummary[]; next: number | null }>(
        "/tool-calls/search",
        {
          method: "POST",
          body: JSON.stringify({
            query,
            before: page,
            ...(harness !== "all" && { harness }),
            ...(kind !== "all" && { kind }),
          }),
          signal: controller.signal,
        },
      )
        .then((data) => {
          if (controller.signal.aborted) return;
          setRows((prev) => (page ? [...prev, ...data.calls] : data.calls));
          setNext(data.next);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, harness, kind, page]);

  useEffect(() => {
    setDetailError("");
    if (!id) return;
    const controller = new AbortController();
    void api<ToolExample>(`/tool-calls/${id}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setDetail(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setDetailError(String(err));
      });
    return () => controller.abort();
  }, [id]);

  function resetResults() {
    setPage(undefined);
    setRows([]);
    setNext(null);
    setSelected(undefined);
    setBusy(true);
  }
  return (
    <Dialog
      title="Choose a tool call"
      description="Select a call from a previous session to preview a response override."
      className="override-dialog"
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            className="override-footer-start"
            onClick={onManual}
          >
            Write a rule manually
          </Button>
          <Button type="button" onClick={onClose}>
            {returning ? "Back to editor" : "Cancel"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!call || call.output === null}
            onClick={() => call && onChoose(call)}
          >
            {call && !call.target ? "Use as sample" : "Use this call"}
          </Button>
        </>
      }
    >
      <div className="call-search">
        <Input
          type="search"
          aria-label="Search previous tool calls"
          value={query}
          placeholder="Search tool names, inputs, or outputs"
          onChange={(e) => {
            resetResults();
            setQuery(e.target.value);
          }}
        />
        <Choice
          aria-label="Filter by tool type"
          value={kind}
          options={[
            { value: "all", label: "All tools" },
            { value: "web", label: "Web fetch" },
            { value: "mcp", label: "MCP tools" },
            { value: "shell", label: "Shell commands" },
          ]}
          onValueChange={(v) => {
            if (v === kind) return;
            resetResults();
            setKind(v);
          }}
        />
        <Choice
          aria-label="Filter by harness"
          value={harness}
          options={[
            { value: "all", label: "All harnesses" },
            ...Object.entries(harnesses).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
          onValueChange={(v) => {
            if (v === harness) return;
            resetResults();
            setHarness(v);
          }}
        />
      </div>
      <Notice error={error} />
      <div className="call-browser">
        <section
          className="call-history"
          aria-label="Recorded calls"
          aria-busy={busy}
        >
          <h3>Recorded calls</h3>
          {rows.map((row) => (
            <button
              type="button"
              key={row.id}
              aria-pressed={row.id === id}
              className="call-example"
              onClick={() => setSelected(row.id)}
            >
              <span className="call-type">
                <TranscriptFilterIcon
                  kind={/^web_?fetch$/i.test(row.tool) ? "web" : "tool"}
                />
                {row.tool || row.name}
                <time dateTime={row.createdAt}>
                  {dateFormat.format(new Date(row.createdAt))}
                </time>
              </span>
              <code>{row.inputPreview || "No input"}</code>
              <span className="call-excerpt">
                <span>Output</span>{" "}
                {row.hasOutput
                  ? row.outputPreview || "Empty response"
                  : "No recorded output"}
              </span>
              <small>{callOrigin(row)}</small>
            </button>
          ))}
          {busy && <output>Loading calls…</output>}
          {!busy && !rows.length && !error && (
            <p className="muted">
              {query || kind !== "all" || harness !== "all"
                ? "No calls match these filters."
                : "Run an evaluation to record its tool calls."}
            </p>
          )}
          {!!next && !busy && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setPage(next)}
            >
              Show more calls
            </Button>
          )}
        </section>
        <section className="call-inspector" aria-label="Selected call">
          {call ? (
            <>
              <div className="call-inspector-title">
                <h3>{call.tool || call.name}</h3>
                <span className={call.status === "failed" ? "fail" : "muted"}>
                  {call.status}
                </span>
              </div>
              <p>{call.evaluation}</p>
              <div className="call-provenance">
                <span>
                  {[
                    harnesses[call.harness] ?? call.harness,
                    call.model && modelDisplayName(call.model),
                    call.phase === "judge" ? "Judge" : "Agent",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <a
                  href={`#sessions/${call.sessionId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open session
                </a>
              </div>
              {!call.target && (
                <p className="call-sample-note">
                  Use this output as a sample. Select the tool to change in the
                  editor.
                </p>
              )}
              {call.task && (
                <div className="call-task">
                  <h4>Session task</h4>
                  {call.task.length > 200 ? (
                    <details>
                      <summary>{call.task.slice(0, 180)}…</summary>
                      <p>{call.task}</p>
                    </details>
                  ) : (
                    <p>{call.task}</p>
                  )}
                </div>
              )}
              <h4>Call input</h4>
              <pre>{displayResponse(call.input)}</pre>
              <h4>Recorded output</h4>
              <pre>
                {call.output === null
                  ? "No recorded output"
                  : previewText(call.output, "") || "Empty response"}
              </pre>
            </>
          ) : (
            <>
              <h3>Call details</h3>
              <Notice error={detailError} />
              {!detailError && (
                <p className="muted">
                  {id
                    ? "Loading call…"
                    : "Select a recorded call to inspect its input and output."}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
