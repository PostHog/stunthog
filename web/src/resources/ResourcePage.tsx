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
import { api, useApi } from "../api.js";
import { Notice, PageTitle } from "../components.js";
import { EmptyState, Feedback, RequestState } from "../PageState.js";
import type { Resource, Resources } from "../types.js";
import { connectMcp } from "./connect-mcp.js";
import { ResourceForm } from "./ResourceForm.js";
import { type ResourceKind, resourceInfo } from "./resource-info.js";

export function ResourcePage({ kind }: { kind: ResourceKind }) {
  const { data, error, refresh } = useApi<Resources>("/resources");
  const [editing, setEditing] = useState<Resource | "new" | null>(null);
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState("");
  const [connecting, setConnecting] = useState("");
  const info = resourceInfo[kind];
  const filtered =
    data?.[kind].filter((resource) =>
      `${resource.title} ${resource.description ?? ""} ${resource.filePath ?? ""} ${resource.workspacePath ?? ""} ${resource.repositoryUrl ?? ""} ${resource.executionMode ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ) ?? [];

  useEffect(() => {
    if (kind !== "mcps") return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [kind, refresh]);

  async function connect(resource: Resource) {
    setFailure("");
    setConnecting(resource.id);
    try {
      await connectMcp(resource.id);
    } catch (error) {
      setFailure(String(error));
    } finally {
      setConnecting("");
    }
  }

  async function remove(resource: Resource) {
    if (
      !confirm(
        `Delete ${resource.title}? You cannot delete a resource that an evaluation uses.`,
      )
    )
      return;

    setRemoving(resource.id);
    setFailure("");
    setMessage("");

    try {
      await api(`/resources/${info.kind}/${resource.id}`, { method: "DELETE" });
      setMessage(`${resource.title} was deleted.`);
      refresh();
    } catch (error) {
      setFailure(String(error));
    } finally {
      setRemoving("");
    }
  }

  return (
    <>
      <PageTitle title={info.title}>
        <Button
          type="button"
          variant="primary"
          disabled={editing !== null}
          onClick={() => setEditing("new")}
        >
          Add {info.singular}
        </Button>
      </PageTitle>
      <p className="description">{info.description}</p>
      <Notice error={failure || (data ? error : undefined)} />
      <Feedback message={message} />
      {editing !== null && (
        <ResourceForm
          key={editing === "new" ? "new" : editing.id}
          kind={kind}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMessage(
              "Saved. Select this resource when you edit an evaluation. Existing sessions keep their original configuration.",
            );
            refresh();
          }}
        />
      )}
      {!data ? (
        <RequestState error={error} retry={refresh} />
      ) : data[kind].length === 0 ? (
        editing === null && (
          <EmptyState title={`No ${info.title.toLowerCase()} yet`}>
            <p>{info.hint}</p>
            <Button type="button" onClick={() => setEditing("new")}>
              Add {info.singular}
            </Button>
          </EmptyState>
        )
      ) : (
        <>
          <div className="toolbar">
            <Input
              type="search"
              aria-label={`Search ${info.title.toLowerCase()}`}
              placeholder={`Search ${info.title.toLowerCase()}`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span className="muted">
              {filtered.length} of {data[kind].length}
            </span>
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="No matching resources">
              <Button type="button" onClick={() => setSearch("")}>
                Clear search
              </Button>
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <Table fullWidth size="sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    {(kind === "personas" || kind === "mcps") && (
                      <TableHead>Description</TableHead>
                    )}
                    {kind !== "personas" && (
                      <TableHead>Configuration</TableHead>
                    )}
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((resource) => (
                    <TableRow key={resource.id}>
                      <TableCell>{resource.title}</TableCell>
                      {(kind === "personas" || kind === "mcps") && (
                        <TableCell>
                          <p className="cell-description">
                            {resource.description || "No description"}
                          </p>
                        </TableCell>
                      )}
                      {kind !== "personas" && (
                        <TableCell className="resource-path">
                          {kind === "environments"
                            ? environmentConfiguration(resource)
                            : (resource.filePath ??
                              resource.url ??
                              resource.command ??
                              (kind === "skills"
                                ? "Inline instructions"
                                : "Empty workspace"))}
                          {resource.oauthConnected && (
                            <small className="muted">OAuth connected</small>
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="actions">
                          {resource.url && (
                            <Button
                              type="button"
                              disabled={Boolean(connecting) || editing !== null}
                              onClick={() => void connect(resource)}
                            >
                              {connecting === resource.id
                                ? "Connecting…"
                                : resource.oauthConnected
                                  ? "Reconnect"
                                  : "Connect"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            disabled={editing !== null}
                            aria-label={`Edit ${resource.title}`}
                            onClick={() => setEditing(resource)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            disabled={Boolean(removing) || editing !== null}
                            aria-label={`Delete ${resource.title}`}
                            onClick={() => void remove(resource)}
                          >
                            {removing === resource.id ? "Deleting…" : "Delete"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="section-note">
            Changes apply to future sessions.{" "}
            <a href="#evals">Go to evaluations</a> to use these resources.
          </p>
        </>
      )}
    </>
  );
}

function environmentConfiguration(resource: Resource) {
  const source =
    resource.repositoryUrl ?? resource.workspacePath ?? "Empty workspace";
  const runtime =
    resource.executionMode === "docker"
      ? resource.dockerfilePath
        ? "Docker · local Dockerfile"
        : resource.dockerfileContent
          ? "Docker · inline Dockerfile"
          : "Docker · built-in image"
      : "This computer";

  return `${runtime} · ${source}`;
}
