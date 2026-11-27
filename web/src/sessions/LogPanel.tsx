import { IconGitBranch } from "@posthog/icons";
import { Button, Input } from "@posthog/quill";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResponseCapture } from "../../../src/overrides/domain/response-override.js";
import {
  backgroundInstruction,
  initialPromptId,
} from "../../../src/sessions/domain/trace-edit.js";
import { api } from "../api.js";
import { Notice } from "../components.js";
import { ModelReference } from "../models/ModelReference.js";
import { OverrideDialog } from "../overrides/OverrideDialog.js";
import { LoadingState } from "../PageState.js";
import type { Session } from "../types.js";
import { BranchStartingPoint } from "./BranchStartingPoint.js";
import { markdownText } from "./Markdown.js";
import { type ThreadNode, threadLink } from "./SessionBranches.js";
import { TraceEditDialog } from "./TraceEditDialog.js";
import {
  type TranscriptMatches,
  transcriptSearch,
} from "./transcript/search.js";
import { TranscriptFilterIcon } from "./transcript/TranscriptFilterIcon.js";
import { TranscriptRow } from "./transcript/TranscriptRow.js";
import { terminalText } from "./transcript/terminal-text.js";
import type { TranscriptEntry } from "./transcript/types.js";

const filters = [
  "focus",
  "all",
  "message",
  "user",
  "thinking",
  "tool",
  "web",
  "system",
] as const;

export function LogPanel({
  session,
  active,
  phase,
  entries: rawEntries,
  error,
  initialCallId,
  loadOlder,
  initialEntryId,
  branches,
  onBranchCreated,
}: {
  session: Session;
  active: boolean;
  phase: "agent" | "judge";
  entries: TranscriptEntry[];
  error: string;
  initialCallId?: string;
  loadOlder?: (() => void) | undefined;
  initialEntryId?: string;
  branches?: ThreadNode[];
  onBranchCreated?: () => void;
}) {
  const entries = useMemo(
    () =>
      rawEntries.map((entry) =>
        entry.output ? { ...entry, output: terminalText(entry.output) } : entry,
      ),
    [rawEntries],
  );
  const [filter, setFilter] = useState<string>("focus");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [more, setMore] = useState(!!initialCallId || !!initialEntryId);
  const [search, setSearch] = useState("");
  const container = useRef<HTMLElement>(null);
  const root = session.rootSessionId ?? session.id;
  const prompt = session.snapshot.evaluation.prompt;
  const first = entries.find(
    (e) => e.kind !== "thinking" && e.kind !== "system",
  );
  const persona = session.snapshot.persona;
  const recordedPrompt =
    first?.kind === "user" &&
    (first.text === prompt ||
      (persona &&
        session.harness !== "pi" &&
        first.text ===
          `Persona:\n${persona.title}\n${persona.description}\n\n${prompt}`))
      ? first
      : undefined;
  const childrenByEntry = useMemo(() => {
    const byEntry = new Map<string, ThreadNode[]>();
    for (const node of branches ?? []) {
      if (node.parentSessionId !== session.id || !node.branchEntryId) continue;
      const id =
        node.branchEntryId === initialPromptId
          ? (recordedPrompt?.id ?? initialPromptId)
          : node.branchEntryId;
      const children = byEntry.get(id) ?? [];
      children.push(node);
      byEntry.set(id, children);
    }
    return byEntry;
  }, [branches, session.id, recordedPrompt?.id]);
  const targetId =
    (initialEntryId === initialPromptId
      ? (recordedPrompt?.id ?? initialPromptId)
      : initialEntryId) ||
    (initialCallId &&
      entries.find((entry) => entry.capture?.callId === initialCallId)?.id);
  const targetLoaded =
    targetId === initialPromptId ||
    entries.some((entry) => entry.id === targetId);
  useEffect(() => {
    if (initialEntryId && !targetLoaded && !error) loadOlder?.();
  }, [initialEntryId, targetLoaded, error, loadOlder]);
  useEffect(() => {
    if (!targetId || !targetLoaded) return;
    const row = document.getElementById(`trace-${targetId}`);
    if (row) {
      row.tabIndex = -1;
      (row.querySelector<HTMLElement>(".tool-output button") ?? row).focus({
        preventScroll: true,
      });
    }
    row?.scrollIntoView({ block: "start" });
  }, [targetId, targetLoaded]);
  const [creating, setCreating] = useState<{
    entryId: string;
    sample: ResponseCapture;
    selection: string;
  } | null>(null);
  const [saved, setSaved] = useState<string>();
  const [editId, setEditId] = useState<string>();
  const [started, setStarted] = useState<{ entry: string; id: string }>();
  const editAction = (id: string) => {
    if (phase !== "agent" || active) return null;
    const children = childrenByEntry.get(id) ?? [];
    return (
      <div className="trace-branch-actions">
        <Button
          type="button"
          variant="link-muted"
          className="trace-edit-action"
          onClick={() => setEditId(id)}
        >
          Try an edit
        </Button>
        {children.map((child) => (
          <a
            className="trace-branch-link ph-no-capture"
            data-ph-mask
            key={child.id}
            href={threadLink(root, child.id)}
            title={child.change || child.prompt}
          >
            <IconGitBranch aria-hidden="true" />
            {child.name}
          </a>
        ))}
        {started?.entry === id &&
          !children.some((child) => child.id === started.id) && (
            <a
              className="trace-branch-link"
              href={threadLink(root, started.id)}
            >
              <IconGitBranch aria-hidden="true" />
              Open branch
            </a>
          )}
        {started?.entry === id && <output>Branch started.</output>}
      </div>
    );
  };
  const query = search.trim();
  const searching = query.length > 0;
  const searchIndex = useMemo(
    () =>
      searching
        ? transcriptSearch(entries, (entry) =>
            entry.kind === "tool" ||
            entry.kind === "web" ||
            entry.kind === "system"
              ? entry.text
              : markdownText(entry.text),
          )
        : null,
    [entries, searching],
  );
  const matches = useMemo(() => {
    const hits = new Map<string, TranscriptMatches>();
    for (const hit of searchIndex?.search(query) ?? []) {
      const fields: TranscriptMatches = {};
      for (const match of hit.matches ?? []) {
        const key = match.key;
        if (key === "title" || key === "text" || key === "output")
          fields[key] = match.indices;
      }
      hits.set(hit.item.entry.id, fields);
    }
    return hits;
  }, [query, searchIndex]);
  const visible = entries.filter(
    (entry) =>
      (filter === "all" ||
        (filter === "focus"
          ? entry.kind !== "system"
          : entry.kind === filter)) &&
      (!searching || matches.has(entry.id)),
  );
  const shown = more ? visible : visible.slice(0, 150);
  const model = phase === "agent" ? session : session.snapshot.evaluation.judge;
  const count = (kind: string) =>
    entries.filter(
      (entry) =>
        kind === "all" ||
        (kind === "focus" ? entry.kind !== "system" : entry.kind === kind),
    ).length;

  return (
    <div className="transcript">
      {editId && (
        <TraceEditDialog
          key={editId}
          session={session}
          entryId={editId}
          onClose={() => setEditId(undefined)}
          onBranchCreated={(id) => {
            setStarted({ entry: editId, id });
            setEditId(undefined);
            onBranchCreated?.();
          }}
        />
      )}
      <div className="transcript-toolbar">
        <fieldset className="transcript-filters" aria-label="Filter transcript">
          {filters.map((kind) => (
            <Button
              type="button"
              key={kind}
              className={`filter-${kind}`}
              aria-pressed={filter === kind}
              onClick={() => setFilter(kind)}
            >
              <TranscriptFilterIcon kind={kind} />
              {kind === "message"
                ? "messages"
                : kind === "tool"
                  ? "tools"
                  : kind}{" "}
              <span>{count(kind)}</span>
            </Button>
          ))}
        </fieldset>
        <div className="transcript-options">
          <Input
            type="search"
            aria-label="Search transcript"
            placeholder="Search transcript"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {showScrollTop && (
            <Button
              type="button"
              variant="outline"
              className="transcript-scroll-top"
              aria-label="Scroll to top"
              onClick={() => {
                container.current?.scrollTo({ top: 0 });
                container.current?.focus({ preventScroll: true });
              }}
            >
              <span aria-hidden="true">↑</span>
            </Button>
          )}
          {search && (
            <Button type="button" onClick={() => setSearch("")}>
              Clear search
            </Button>
          )}
        </div>
      </div>
      <Notice error={error} />
      <div className="transcript-body">
        <section
          className="transcript-scroll"
          ref={container}
          onScroll={(event) =>
            setShowScrollTop(event.currentTarget.scrollTop > 96)
          }
          aria-label="Session transcript"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll this pane.
          tabIndex={0}
        >
          {phase === "agent" && session.parentSessionId && (
            <BranchStartingPoint
              session={session}
              parent={session.parentSessionId}
            />
          )}
          <header className="transcript-intro">
            {phase === "agent" && session.parentSessionId && (
              <h3>Branch continuation</h3>
            )}
            <ModelReference harness={model.harness} model={model.model} />
          </header>
          {phase === "agent" &&
            session.origin !== "organic" &&
            !session.snapshot.editedStart?.hasBackground &&
            !recordedPrompt && (
              <div
                id={`trace-${initialPromptId}`}
                className="transcript-prompt"
              >
                {prompt}
                {editAction(initialPromptId)}
              </div>
            )}
          {shown.map((entry) => (
            <TranscriptRow
              key={entry.id}
              entry={entry}
              foldPrompt={
                phase === "agent" &&
                !!session.snapshot.editedStart?.hasBackground &&
                entry.kind === "user" &&
                entry.text.includes(`${prompt}\n\n${backgroundInstruction}`)
              }
              editAction={
                entry.kind !== "thinking" &&
                entry.kind !== "system" &&
                entry.status !== "running" &&
                editAction(entry.id)
              }
              revealResult={entry.id === targetId}
              matches={matches.get(entry.id)}
              editing={creating?.entryId === entry.id}
              onOverride={(sample, selection) => {
                setSaved(undefined);
                setCreating((current) =>
                  current?.entryId === entry.id
                    ? null
                    : { entryId: entry.id, sample, selection },
                );
              }}
            >
              {creating?.entryId === entry.id && (
                <OverrideDialog
                  inline
                  sample={creating.sample}
                  selection={creating.selection}
                  servers={session.snapshot.mcps
                    .map((s, i) => ({
                      id: s.id ?? session.snapshot.evaluation.mcpIds[i] ?? "",
                      title: s.title,
                    }))
                    .filter((s) => s.id)}
                  evaluationTitle={session.eval.title}
                  applyLabel="Save to evaluation"
                  onClose={() => {
                    setCreating((current) =>
                      current?.entryId === entry.id ? null : current,
                    );
                    const trigger = document.getElementById(
                      `intercept-${entry.id}`,
                    );
                    if (trigger?.getAttribute("aria-expanded") === "true")
                      trigger.focus({ preventScroll: true });
                  }}
                  onApply={async (rule) => {
                    await api(`/evals/${session.evalId}/response-overrides`, {
                      method: "POST",
                      body: JSON.stringify(rule),
                    });
                    setSaved(entry.id);
                  }}
                />
              )}
              {saved === entry.id && (
                <output className="trace-intercept-saved">
                  Saved for the next run.{" "}
                  <a href={`#evals/${session.evalId}`}>
                    View evaluation and run
                  </a>
                </output>
              )}
            </TranscriptRow>
          ))}
          {loadOlder && (
            <Button type="button" onClick={loadOlder}>
              {error ? "Retry loading events" : "Load more trace events"}
            </Button>
          )}
          {visible.length > shown.length && (
            <Button
              type="button"
              className="load-transcript"
              onClick={() => setMore(true)}
            >
              Show {visible.length - shown.length} more entries
            </Button>
          )}
          {visible.length === 0 &&
            (active && entries.length === 0 ? (
              <LoadingState label="Waiting for session activity…" />
            ) : (
              <p className="empty">
                {entries.length
                  ? "No entries match this filter and search."
                  : phase === "agent" && session.error
                    ? `The agent stopped before it recorded any activity. ${session.error}`
                    : `The ${phase} recorded no activity.`}
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}
