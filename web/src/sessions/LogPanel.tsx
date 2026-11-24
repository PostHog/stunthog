import { Button, Input } from "@posthog/quill";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResponseCapture } from "../../../src/overrides/domain/response-override.js";
import { api } from "../api.js";
import { Notice } from "../components.js";
import { ModelReference } from "../models/ModelReference.js";
import { OverrideDialog } from "../overrides/OverrideDialog.js";
import { LoadingState } from "../PageState.js";
import type { Session } from "../types.js";
import { markdownText } from "./Markdown.js";
import {
  type TranscriptMatches,
  transcriptSearch,
} from "./transcript/search.js";
import { TranscriptFilterIcon } from "./transcript/TranscriptFilterIcon.js";
import { TranscriptRow } from "./transcript/TranscriptRow.js";
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
  entries,
  error,
  initialCallId,
  loadOlder,
  initialEntryId,
}: {
  session: Session;
  active: boolean;
  phase: "agent" | "judge";
  entries: TranscriptEntry[];
  error: string;
  initialCallId?: string;
  loadOlder?: (() => void) | undefined;
  initialEntryId?: string;
}) {
  const [filter, setFilter] = useState<string>("focus");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [more, setMore] = useState(!!initialCallId || !!initialEntryId);
  const [search, setSearch] = useState("");
  const container = useRef<HTMLElement>(null);
  const targetId =
    initialEntryId ||
    (initialCallId &&
      entries.find((entry) => entry.capture?.callId === initialCallId)?.id);
  useEffect(() => {
    if (!targetId) return;
    const row = document.getElementById(`trace-${targetId}`);
    if (row) {
      row.tabIndex = -1;
      (row.querySelector<HTMLElement>(".tool-output button") ?? row).focus({
        preventScroll: true,
      });
    }
    row?.scrollIntoView({ block: "start" });
  }, [targetId]);
  const [creating, setCreating] = useState<{
    entryId: string;
    sample: ResponseCapture;
    selection: string;
  } | null>(null);
  const [saved, setSaved] = useState<string>();
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
  const prompt = session.snapshot.evaluation.prompt;
  const count = (kind: string) =>
    entries.filter(
      (entry) =>
        kind === "all" ||
        (kind === "focus" ? entry.kind !== "system" : entry.kind === kind),
    ).length;

  return (
    <div className="transcript">
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
          {search && (
            <Button type="button" onClick={() => setSearch("")}>
              Clear search
            </Button>
          )}
        </div>
      </div>
      <Notice error={error} />
      <div className="transcript-body">
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
          <header className="transcript-intro">
            <ModelReference harness={model.harness} model={model.model} />
          </header>
          {phase === "agent" &&
            !entries.some(
              (entry) => entry.kind === "user" && entry.text === prompt,
            ) && <div className="transcript-prompt">{prompt}</div>}
          {shown.map((entry) => (
            <TranscriptRow
              key={entry.id}
              entry={entry}
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
                  <a href={`#evals/${session.evalId}/edit`}>View evaluation</a>
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
              <p className="empty">No entries match this filter and search.</p>
            ))}
        </section>
      </div>
    </div>
  );
}
