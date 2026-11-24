import { Button, Input } from "@posthog/quill";
import { useRef, useState } from "react";
import { useApi } from "../api.js";
import { Choice } from "../Choice.js";
import { Field, Notice } from "../components.js";
import { ResponseComparison } from "../overrides/ResponseComparison.js";
import { EmptyState, LoadingState, RequestState } from "../PageState.js";
import type { Artifact } from "../types.js";
import { FilePreview } from "./FilePreview.js";

export function FilesPanel({ id, active }: { id: string; active: boolean }) {
  const { data, error, refresh } = useApi<Artifact[]>(
    `/sessions/${id}/files`,
    active,
  );
  const [phase, setPhase] = useState("output");
  const [selected, setSelected] = useState<Artifact>();
  const [text, setText] = useState<string>();
  const [failure, setFailure] = useState("");
  const [search, setSearch] = useState("");
  const [comparison, setComparison] = useState<string>();
  const [comparing, setComparing] = useState(false);
  const request = useRef(0);
  const files = data?.filter((file) => file.phase === phase) ?? [];
  const filtered = files.filter((file) =>
    file.path.toLowerCase().includes(search.trim().toLowerCase()),
  );

  async function read(file: Artifact) {
    const version = ++request.current;

    setSelected(file);
    setComparison(undefined);
    setComparing(false);
    setText(undefined);
    setFailure("");

    try {
      const response = await fetch(`/api/sessions/${id}/files/${file.id}`);

      if (!response.ok) throw new Error("Cannot read this file.");

      const content = await response.text();

      if (version === request.current) setText(content);
    } catch (error) {
      if (version === request.current) {
        setFailure(String(error));
        setText("");
      }
    }
  }

  const otherPhase = phase === "input" ? "output" : "input";
  const other =
    (phase === "input" || phase === "output") &&
    data?.find(
      (file) => file.phase === otherPhase && file.path === selected?.path,
    );
  async function compare(file: Artifact) {
    const version = ++request.current;
    setComparing(true);
    setFailure("");
    try {
      const response = await fetch(`/api/sessions/${id}/files/${file.id}`);
      if (!response.ok) throw new Error("Cannot compare the saved files.");
      const content = await response.text();
      if (version === request.current) setComparison(content);
    } catch (error) {
      if (version === request.current) setFailure(String(error));
    } finally {
      if (version === request.current) setComparing(false);
    }
  }
  return (
    <>
      <div className="toolbar">
        <Field label="Files">
          <Choice
            value={phase}
            onValueChange={(next) => {
              request.current++;
              setPhase(next);
              setSelected(undefined);
              setFailure("");
              setComparison(undefined);
              setComparing(false);
              const same = data?.find(
                (file) => file.phase === next && file.path === selected?.path,
              );
              if (same) void read(same);
            }}
            options={[
              { value: "input", label: "Original input" },
              { value: "output", label: "Final workspace" },
              { value: "agent-runtime", label: "Agent runtime" },
              { value: "judge-runtime", label: "Judge runtime" },
            ]}
          />
        </Field>
        <Input
          type="search"
          aria-label="Search file paths"
          placeholder="Search file paths"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="muted">
          {filtered.length} of {files.length} files
        </span>
      </div>
      <Notice error={failure || (data ? error : undefined)} />
      {!data ? (
        <RequestState error={error} retry={refresh} />
      ) : files.length === 0 ? (
        <EmptyState title="No saved files in this phase">
          <p>
            {active
              ? "Check this phase again after the session finishes."
              : "This phase has no saved files. Choose another phase."}
          </p>
        </EmptyState>
      ) : (
        <div className="file-browser">
          <nav aria-label="Session files">
            {filtered.map((file) => (
              <Button
                type="button"
                key={file.id}
                className={selected?.id === file.id ? "selected" : ""}
                aria-current={selected?.id === file.id ? "true" : undefined}
                onClick={() => void read(file)}
              >
                {file.path}
              </Button>
            ))}
            {filtered.length === 0 && (
              <p className="muted">
                No matching files.{" "}
                <Button type="button" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              </p>
            )}
          </nav>
          <section>
            {selected ? (
              <>
                <div className="toolbar">
                  <h3>{selected.path}</h3>
                  {other && text !== undefined && (
                    <Button
                      type="button"
                      disabled={comparing}
                      onClick={() =>
                        comparison === undefined
                          ? void compare(other)
                          : setComparison(undefined)
                      }
                    >
                      {comparing
                        ? "Comparing…"
                        : comparison === undefined
                          ? "Compare snapshots"
                          : "View file"}
                    </Button>
                  )}
                  <a
                    href={`/api/sessions/${id}/files/${selected.id}`}
                    download={selected.path.split("/").pop()}
                  >
                    Download
                  </a>
                </div>
                {!failure &&
                  (text === undefined ? (
                    <LoadingState label="Loading file…" />
                  ) : comparison !== undefined ? (
                    <>
                      {comparison === text && <p>The file has no changes.</p>}
                      <ResponseComparison
                        beforeTitle="Original input"
                        afterTitle="Final workspace"
                        before={phase === "input" ? text : comparison}
                        after={phase === "input" ? comparison : text}
                      />
                    </>
                  ) : (
                    <FilePreview
                      key={selected.id}
                      path={selected.path}
                      text={text}
                    />
                  ))}
              </>
            ) : (
              <p className="empty">Choose a file to read its saved contents.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
