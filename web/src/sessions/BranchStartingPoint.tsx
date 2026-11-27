import { IconGitBranch } from "@posthog/icons";
import { Button } from "@posthog/quill";
import { diffWordsWithSpace } from "diff";
import { useMemo, useState } from "react";
import type { BranchEdit } from "../../../src/sessions/domain/trace-edit.js";
import { useApi } from "../api.js";
import { Notice } from "../components.js";
import type { Session } from "../types.js";
import { threadLink } from "./SessionBranches.js";

const fields = {
  "user-message": "user message",
  "agent-message": "agent message",
  "tool-arguments": "tool arguments",
  "tool-result": "tool result",
};

function EditComparison({ edit }: { edit: BranchEdit }) {
  const [expanded, setExpanded] = useState(false);
  const { before, after } = edit;
  const long = [before, after].some(
    (value) => value && (value.length > 320 || value.split("\n", 6).length > 5),
  );
  const [left, right] = useMemo(() => {
    if (expanded || !long) return [before, after] as const;
    // Keep the first changed line visible, even after a long block of unchanged output.
    let offset = 0;
    while (offset < after.length && before?.[offset] === after[offset])
      offset++;
    const start = Math.max(
      0,
      offset - 48,
      (before ?? "").slice(0, offset).lastIndexOf("\n") + 1,
    );
    function excerpt(text: string) {
      const clip = text
        .slice(start, start + 320)
        .split("\n", 5)
        .join("\n");
      return (
        (start ? "…" : "") +
        clip +
        (start + clip.length < text.length ? "…" : "")
      );
    }
    return [before === null ? null : excerpt(before), excerpt(after)] as const;
  }, [before, after, expanded, long]);
  const changes = useMemo(() => {
    if (left === null || left === right || left.length + right.length > 64_000)
      return;
    return diffWordsWithSpace(left, right, {
      timeout: 40,
      maxEditLength: 1500,
    });
  }, [left, right]);
  function value(edited: boolean) {
    const text = edited ? right : left;
    if (text === null) return <em>No recorded value</em>;
    if (text === "") return <em>Empty value</em>;
    if (!changes) return text;
    let offset = 0;
    return changes.map((part) => {
      offset += part.value.length;
      if (edited ? part.removed : part.added) return null;
      return part.added || part.removed ? (
        <mark key={offset}>{part.value}</mark>
      ) : (
        part.value
      );
    });
  }
  return (
    <>
      <dl>
        <div>
          <dt>Original {fields[edit.kind]}</dt>
          <dd>{value(false)}</dd>
        </div>
        <div data-edited>
          <dt>Edited {fields[edit.kind]}</dt>
          <dd>{value(true)}</dd>
        </div>
        {edit.followUp !== undefined && (
          <div>
            <dt>Follow-up message</dt>
            <dd>{edit.followUp}</dd>
          </div>
        )}
        {edit.kind === "tool-arguments" && (
          <div>
            <dt>Sample result</dt>
            <dd>
              {edit.sampleResult === undefined ? (
                <em>Pending tool call</em>
              ) : (
                edit.sampleResult || <em>Empty value</em>
              )}
            </dd>
          </div>
        )}
      </dl>
      {long && (
        <Button
          type="button"
          variant="link-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show excerpt" : "Show full values"}
        </Button>
      )}
    </>
  );
}

export function BranchStartingPoint({
  session,
  parent,
}: {
  session: Session;
  parent: string;
}) {
  const { data, error, refresh } = useApi<BranchEdit>(
    `/sessions/${session.id}/starting-point`,
  );
  const saved = session.snapshot.editedStart;
  return (
    <section
      className="branch-start ph-no-capture"
      data-ph-mask
      aria-label="Branch starting point"
    >
      <header>
        <h3>
          <IconGitBranch aria-hidden="true" />
          Branch starting point
        </h3>
        <a
          href={threadLink(
            session.rootSessionId ?? parent,
            parent,
            session.branchEntryId ?? undefined,
          )}
        >
          {saved?.label ?? "First user message"} in parent trace
        </a>
      </header>
      {data ? (
        <EditComparison edit={data} />
      ) : error ? (
        <>
          {saved?.change && <p>Saved edit preview · {saved.change}</p>}
          <Notice error={error} />
          <Button type="button" variant="link-muted" onClick={refresh}>
            Retry
          </Button>
        </>
      ) : (
        <output>Loading edit…</output>
      )}
    </section>
  );
}
