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
import { useState } from "react";
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
import type { Session } from "../types.js";
import { filterSessions, isActive } from "./session-filters.js";

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
          <SessionsTable sessions={data} />
        </>
      ) : (
        <RequestState error={error} retry={refresh} />
      )}
    </>
  );
}

export function SessionsTable({ sessions }: { sessions: Session[] }) {
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const models = [
    ...new Set(
      sessions.map((session) => `${session.harness}/${session.model}`),
    ),
  ];
  const displayName = useModelName();
  const filtered = filterSessions(sessions, search, model, status, displayName);

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
      {filtered.length === 0 && (
        <EmptyState title="No sessions match these filters">{null}</EmptyState>
      )}
    </>
  );
}
