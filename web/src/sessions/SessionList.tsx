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
import { ModelReference } from "../models/ModelReference.js";
import { EmptyState, RequestState } from "../PageState.js";
import type { Session } from "../types.js";
import { filterSessions } from "./session-filters.js";

export function SessionList() {
  const { data, error, refresh } = useApi<Session[]>("/sessions", true);

  return (
    <>
      <header className="session-list-header">
        <h1>Agent sessions</h1>
        <p className="muted">Review agent activity and judge results.</p>
      </header>
      {data ? (
        <>
          <Notice error={error} />
          <SessionsTable sessions={data} rememberFilters />
        </>
      ) : (
        <RequestState error={error} retry={refresh} />
      )}
    </>
  );
}

export function SessionsTable({
  sessions,
  rememberFilters = false,
}: {
  sessions: Session[];
  rememberFilters?: boolean;
}) {
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
  const models = [
    ...new Set(
      sessions.map((session) => `${session.harness}/${session.model}`),
    ),
  ];
  const filtered = filterSessions(sessions, search, model, status);

  function clear() {
    setModel("");
    setStatus("");
    setSearch("");
  }

  if (sessions.length === 0)
    return (
      <EmptyState title="No sessions yet">
        <p>Run an evaluation to compare models and inspect their work here.</p>
      </EmptyState>
    );

  return (
    <>
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
          {filtered.length} of {sessions.length} sessions
        </output>
        {(search || model || status) && (
          <Button type="button" variant="outline" onClick={clear}>
            Clear filters
          </Button>
        )}
      </div>
      {filtered.length > 0 && (
        <div className="table-scroll">
          <Table fullWidth size="sm">
            <TableHeader>
              <TableRow>
                <TableHead>Harness / model</TableHead>
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
                    </small>
                  </TableCell>
                  <TableCell>
                    <a href={`#evals/${session.evalId}`}>
                      {session.eval.title}
                    </a>
                  </TableCell>
                  <TableCell>
                    <CheckBar
                      decisions={session.decisions}
                      criteria={session.snapshot.evaluation.criteria}
                    />
                  </TableCell>
                  <TableCell className="verdict-preview">
                    <p className="cell-description">
                      {session.error ?? session.verdict ?? "Awaiting judgment"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Status value={session.status} />
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
      {filtered.length === 0 && (
        <EmptyState title="No sessions match these filters">{null}</EmptyState>
      )}
    </>
  );
}
