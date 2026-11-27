import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@posthog/quill";
import { useEffect, useState } from "react";
import { useApi } from "../api.js";
import { Choice } from "../Choice.js";
import {
  CheckBar,
  duration,
  Field,
  money,
  Notice,
  number,
  Status,
} from "../components.js";
import { ModelReference, useModelName } from "../models/ModelReference.js";
import { EmptyState, RequestState } from "../PageState.js";
import { StatusIcon } from "../status/StatusIcon.js";
import { Tooltip } from "../Tooltip.js";
import type { Session } from "../types.js";
import { filterSessions, isActive } from "./session-filters.js";

type HistoryIndex = Pick<Session, "id" | "model" | "harness" | "status"> & {
  title: string;
  environment: string | null;
  review: boolean;
};
type Summary = Pick<
  Session,
  | "id"
  | "evalId"
  | "model"
  | "harness"
  | "status"
  | "createdAt"
  | "durationMs"
  | "costUsd"
  | "verdict"
  | "error"
  | "eval"
  | "origin"
  | "memo"
  | "branchCount"
  | "interceptedCalls"
> & {
  criteria: Session["snapshot"]["evaluation"]["criteria"];
  decisions: Pick<
    Session["decisions"][number],
    "passed" | "criterionSnapshotId"
  >[];
};
export function SessionList() {
  const { data, error, refresh } = useApi<HistoryIndex[]>(
    "/sessions/history",
    true,
  );

  return (
    <>
      <header className="session-list-header">
        <h1>Agent sessions</h1>
        <p className="muted">Review agent activity and judge results.</p>
      </header>
      {data ? (
        <>
          <Notice error={error} />
          <HistoryTable sessions={data} />
        </>
      ) : (
        <RequestState error={error} retry={refresh} />
      )}
    </>
  );
}

function TableControls({
  search,
  model,
  status,
  setSearch,
  setModel,
  setStatus,
  models,
  count,
  total,
}: {
  search: string;
  model: string;
  status: string;
  setSearch: (s: string) => void;
  setModel: (s: string) => void;
  setStatus: (s: string) => void;
  models: string[];
  count: number;
  total: number;
}) {
  return (
    <>
      {" "}
      <div className="session-list-filters">
        <Field label="Search sessions">
          <Input
            type="search"
            placeholder="Evaluation, model, or environment"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="Harness / model">
          <Choice
            value={model}
            onValueChange={setModel}
            options={[
              { value: "", label: "All models" },
              ...models.map((model) => ({ value: model, label: model })),
            ]}
          />
        </Field>
        <Field label="Result">
          <Choice
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "", label: "All sessions" },
              { value: "active", label: "In progress" },
              { value: "review", label: "Needs review" },
              { value: "completed", label: "Completed" },
              { value: "failed", label: "Failed session" },
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
        </Field>
      </div>
      <div className="session-list-summary">
        <output className="muted">
          {count} of {total} sessions
        </output>
        {(search || model || status) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setModel("");
              setStatus("");
              setSearch("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    </>
  );
}

function ResultTable({ filtered }: { filtered: Summary[] }) {
  return (
    <>
      {" "}
      {filtered.length > 0 && (
        <div className="table-scroll">
          <Table fullWidth size="sm">
            <TableHeader>
              <TableRow>
                <TableHead>Harness / model</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Evaluation</TableHead>
                <TableHead>Criteria</TableHead>
                <TableHead>Judge verdict</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Intercepted calls</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Est. cost</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <ModelReference
                      harness={session.harness}
                      model={session.model}
                    />
                    <small>
                      <a
                        aria-label={`View ${session.model} session for ${session.eval.title}`}
                        href={`#sessions/${session.id}`}
                      >
                        View session
                      </a>
                      {!!session.branchCount && (
                        <>
                          {" "}
                          ·{" "}
                          <a href={`#sessions/${session.id}?branches=1`}>
                            {session.branchCount}{" "}
                            {session.branchCount === 1 ? "branch" : "branches"}
                          </a>
                        </>
                      )}
                    </small>
                  </TableCell>
                  <TableCell>
                    <span className="status-note ph-no-capture">
                      {session.origin === "organic" ? "Organic" : "Synthetic"}
                      {session.memo && (
                        <Tooltip text={session.memo}>
                          <StatusIcon name="info" />
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <a href={`#evals/${session.evalId}`}>
                      {session.eval.title}
                    </a>
                  </TableCell>
                  <TableCell>
                    <CheckBar
                      decisions={session.decisions}
                      criteria={session.criteria}
                    />
                  </TableCell>
                  <TableCell className="verdict-preview">
                    <p className="cell-description">
                      {session.verdict ??
                        (isActive(session)
                          ? "Awaiting judgment"
                          : "No judgment")}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Status value={session.status} />
                    {session.error && (
                      <p className="cell-description">{session.error}</p>
                    )}
                  </TableCell>
                  <TableCell>{number(session.interceptedCalls)}</TableCell>
                  <TableCell>{duration(session.durationMs)}</TableCell>
                  <TableCell>{money(session.costUsd)}</TableCell>
                  <TableCell>
                    {new Date(session.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!filtered.length && (
        <EmptyState title="No sessions match these filters">{null}</EmptyState>
      )}
    </>
  );
}

function useFilters(rememberFilters = false) {
  const saved = new URLSearchParams(
    rememberFilters ? location.hash.split("?")[1] : "",
  );
  const [model, setModel] = useState(() => saved.get("model") ?? "");
  const [status, setStatus] = useState(() => saved.get("status") ?? "");
  const [search, setSearch] = useState(() => saved.get("q") ?? "");
  useEffect(() => {
    if (!rememberFilters) return;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ model, status, q: search }))
      if (value) query.set(key, value);
    history.replaceState(
      history.state,
      "",
      query.size ? `#sessions?${query}` : "#sessions",
    );
  }, [rememberFilters, model, status, search]);
  return { model, status, search, setModel, setStatus, setSearch };
}
function NoSessions() {
  return (
    <EmptyState title="No sessions yet">
      <p>Run an evaluation to compare models and inspect their work here.</p>
    </EmptyState>
  );
}

export function SessionsTable({ sessions }: { sessions: Session[] }) {
  const filters = useFilters();
  const displayName = useModelName();
  const filtered = filterSessions(
    sessions,
    filters.search,
    filters.model,
    filters.status,
    displayName,
  );
  return sessions.length ? (
    <>
      <TableControls
        {...filters}
        models={[...new Set(sessions.map((s) => s.harness + "/" + s.model))]}
        count={filtered.length}
        total={sessions.length}
      />
      <ResultTable
        filtered={filtered.map((row) => ({
          ...row,
          criteria: row.snapshot.evaluation.criteria,
        }))}
      />
    </>
  ) : (
    <NoSessions />
  );
}

function HistoryTable({ sessions }: { sessions: HistoryIndex[] }) {
  const displayName = useModelName();
  const filters = useFilters(true);
  const [offset, setOffset] = useState(0);
  const query = filters.search.trim().toLowerCase();
  const filtered = sessions.filter(
    (row) =>
      (!filters.model || row.harness + "/" + row.model === filters.model) &&
      (!filters.status ||
        (filters.status === "review"
          ? row.review
          : filters.status === "active"
            ? isActive(row)
            : row.status === filters.status)) &&
      [
        row.title,
        row.environment,
        row.model,
        displayName(row.harness, row.model),
        row.harness,
      ].some((x) => x?.toLowerCase().includes(query)),
  );
  const start = Math.min(
    offset,
    Math.max(0, Math.floor((filtered.length - 1) / 25) * 25),
  );
  const page = filtered.slice(start, start + 25);
  const controls = {
    ...filters,
    setModel: (s: string) => {
      filters.setModel(s);
      setOffset(0);
    },
    setStatus: (s: string) => {
      filters.setStatus(s);
      setOffset(0);
    },
    setSearch: (s: string) => {
      filters.setSearch(s);
      setOffset(0);
    },
  };
  return sessions.length ? (
    <>
      <TableControls
        {...controls}
        models={[...new Set(sessions.map((s) => s.harness + "/" + s.model))]}
        count={filtered.length}
        total={sessions.length}
      />
      {page.length ? (
        <HistoryPage
          key={page.map((s) => s.id).join(",")}
          ids={page.map((s) => s.id)}
        />
      ) : (
        <EmptyState title="No sessions match these filters">{null}</EmptyState>
      )}
      {filtered.length > 25 && (
        <div className="toolbar">
          <Button disabled={start === 0} onClick={() => setOffset(start - 25)}>
            Previous page
          </Button>
          <span>
            {start + 1}–{start + page.length} of {filtered.length}
          </span>
          <Button
            disabled={start + 25 >= filtered.length}
            onClick={() => setOffset(start + 25)}
          >
            Next page
          </Button>
        </div>
      )}
    </>
  ) : (
    <NoSessions />
  );
}
function HistoryPage({ ids }: { ids: string[] }) {
  const { data, error, refresh } = useApi<Summary[]>(
    `/sessions/history/page?ids=${ids.join(",")}`,
    true,
  );
  return data ? (
    <>
      <Notice error={error} />
      <ResultTable filtered={data} />
    </>
  ) : (
    <RequestState error={error} retry={refresh} />
  );
}
