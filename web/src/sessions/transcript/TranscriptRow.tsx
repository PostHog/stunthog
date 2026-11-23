import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@posthog/quill";
import type { ReactNode } from "react";
import type { ResponseCapture } from "../../../../src/overrides/domain/response-override.js";
import { ResponseComparison } from "../../overrides/ResponseComparison.js";
import { displayResponse } from "../../overrides/response-text.js";
import { StatusIcon } from "../../status/StatusIcon.js";
import { Markdown } from "../Markdown.js";
import {
  highlightParts,
  type MatchRanges,
  type TranscriptMatches,
} from "./search.js";
import type { TranscriptEntry } from "./types.js";

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges?: MatchRanges | undefined;
}) {
  return highlightParts(text, ranges).map((part) =>
    part.match ? <mark key={part.start}>{part.text}</mark> : part.text,
  );
}

export function TranscriptRow({
  entry,
  matches,
  onOverride,
  editing = false,
  children,
}: {
  entry: TranscriptEntry;
  editing?: boolean;
  children?: ReactNode;
  onOverride?: (capture: ResponseCapture, selection: string) => void;
  matches?: TranscriptMatches | undefined;
}) {
  const capture = entry.capture;
  const modified = capture?.ruleId ? capture : undefined;
  const tool = entry.kind === "tool" || entry.kind === "web";

  return (
    <article
      className={`transcript-row transcript-${entry.kind}`}
      data-modified={modified ? true : undefined}
      id={`event-${entry.sequence}`}
    >
      <span className="transcript-sequence">{entry.sequence}</span>
      {tool ? (
        <div className="transcript-tool">
          <div className="tool-command">
            <span
              className={`tool-state ${entry.status}`}
              title={entry.status}
              role="img"
              aria-label={`Tool ${entry.status ?? "status unavailable"}`}
            >
              <StatusIcon
                name={
                  entry.status === "running"
                    ? "spinner"
                    : entry.status === "failed"
                      ? "error"
                      : entry.status === "passed"
                        ? "check"
                        : "info"
                }
              />
            </span>
            <strong>
              <Highlighted text={entry.title} ranges={matches?.title} />
            </strong>
            <code>
              <Highlighted text={entry.text} ranges={matches?.text} />
            </code>
            {capture && onOverride && (
              <Button
                type="button"
                variant="outline"
                className="trace-intercept-action"
                id={`intercept-${entry.id}`}
                aria-expanded={editing}
                aria-label={`Intercept ${entry.title} response`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  const selected = window.getSelection();
                  const text =
                    selected?.anchorNode &&
                    event.currentTarget
                      .closest("article")
                      ?.contains(selected.anchorNode)
                      ? selected.toString()
                      : "";
                  onOverride(capture, text);
                }}
              >
                Intercept
              </Button>
            )}
          </div>
          {modified && (
            <span className="modified-label">Response modified</span>
          )}
          {entry.capture?.error && (
            <span className="error">{entry.capture.error}</span>
          )}
          {entry.output || entry.capture ? (
            <Collapsible
              className="tool-output"
              key={matches?.output ? "match" : "idle"}
              defaultOpen={Boolean(matches?.output)}
            >
              <CollapsibleTrigger>
                <span className={`tool-result-status ${entry.status}`}>
                  {entry.status === "failed" ? "Failed" : "Result"}
                </span>{" "}
                {(entry.output ?? "").replaceAll(/\s+/g, " ").slice(0, 180)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                {modified ? (
                  <Tabs defaultValue="diff" className="trace-result-tabs">
                    <TabsList aria-label="Tool response">
                      <TabsTrigger value="diff">Response diff</TabsTrigger>
                      <TabsTrigger value="original">Original</TabsTrigger>
                      <TabsTrigger value="modified">Modified</TabsTrigger>
                    </TabsList>
                    <TabsContent value="diff">
                      <ResponseComparison
                        before={displayResponse(modified.original)}
                        after={entry.output ?? ""}
                      />
                    </TabsContent>
                    <TabsContent value="original">
                      <pre>{displayResponse(modified.original)}</pre>
                    </TabsContent>
                    <TabsContent value="modified">
                      <pre>
                        <Highlighted
                          text={entry.output ?? ""}
                          ranges={matches?.output}
                        />
                      </pre>
                    </TabsContent>
                  </Tabs>
                ) : (
                  <pre>
                    <Highlighted
                      text={entry.output ?? ""}
                      ranges={matches?.output}
                    />
                  </pre>
                )}
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <span className="tool-pending">
              {entry.status === "running"
                ? "Running…"
                : entry.status === "failed"
                  ? "Failed · No output"
                  : "No output"}
            </span>
          )}
          {children}
        </div>
      ) : entry.kind === "thinking" ? (
        <Collapsible
          className="thinking-block"
          key={matches?.text ? "match" : "idle"}
          defaultOpen={Boolean(matches?.text)}
        >
          <CollapsibleTrigger>Thinking…</CollapsibleTrigger>
          <CollapsibleContent>
            <Markdown text={entry.text} matches={matches?.text} />
          </CollapsibleContent>
        </Collapsible>
      ) : entry.kind === "system" ? (
        <p className="transcript-error">
          <Highlighted text={entry.title} ranges={matches?.title} />{" "}
          <Highlighted text={entry.text} ranges={matches?.text} />
        </p>
      ) : (
        <Markdown text={entry.text} matches={matches?.text} />
      )}
    </article>
  );
}
