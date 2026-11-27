import { IconGitBranch } from "@posthog/icons";
import { money, Status } from "../components.js";
import type { Session } from "../types.js";

export type BranchRow = Pick<
  Session,
  "id" | "parentSessionId" | "branchEntryId" | "status" | "costUsd"
> & {
  prompt: string;
  entryLabel?: string;
  change?: string | null;
  passed: number;
  assessed: number;
};

export type ThreadNode = BranchRow & { name: string };

export function threadLink(root: string, selected: string, entry?: string) {
  const query = new URLSearchParams();
  if (selected !== root) query.set("branch", selected);
  if (entry) query.set("entry", entry);
  return `#sessions/${root}${query.size ? `?${query}` : ""}`;
}

export function SessionBranches({
  nodes,
  root,
  selected,
  onEntry,
}: {
  nodes: ThreadNode[];
  root: string;
  selected: string;
  onEntry: (entry: string) => void;
}) {
  const original = nodes.find((node) => node.id === root);
  if (!original || nodes.length < 2) return null;

  // Sibling runs can start at the same trace entry.
  const forks = new Map<string, Map<string, ThreadNode[]>>();
  for (const node of nodes) {
    if (!node.parentSessionId || !node.branchEntryId) continue;
    const byEntry =
      forks.get(node.parentSessionId) ?? new Map<string, ThreadNode[]>();
    const children = byEntry.get(node.branchEntryId) ?? [];
    children.push(node);
    byEntry.set(node.branchEntryId, children);
    forks.set(node.parentSessionId, byEntry);
  }
  function tree(node: ThreadNode): React.ReactNode {
    const points = forks.get(node.id);
    return (
      <li key={node.id}>
        <div
          className="branch-node"
          data-selected={node.id === selected || undefined}
        >
          <a
            className="branch-node-link"
            aria-current={node.id === selected ? "page" : undefined}
            href={threadLink(root, node.id)}
          >
            {node.name}
          </a>
          <Status value={node.status} />
          {node.assessed > 0 && (
            <small>
              {node.passed}/{node.assessed} passed
            </small>
          )}
          {node.costUsd != null && <small>{money(node.costUsd)}</small>}
          {node.change && (
            <span
              className="branch-change ph-no-capture"
              data-ph-mask
              title={node.change}
            >
              {node.change}
            </span>
          )}
        </div>
        {points && (
          <ol>
            {Array.from(points, ([entry, children]) => (
              <li key={entry}>
                <a
                  className="branch-point ph-no-capture"
                  data-ph-mask
                  href={threadLink(root, node.id, entry)}
                  onClick={(event) => {
                    if (
                      window.location.hash !==
                        threadLink(root, node.id, entry) ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    onEntry(entry);
                  }}
                >
                  <IconGitBranch aria-hidden="true" />
                  {entry === "initial-prompt"
                    ? "Initial prompt"
                    : children[0]?.entryLabel ||
                      children[0]?.prompt ||
                      "Edited entry"}
                </a>
                <ol>{children.map(tree)}</ol>
              </li>
            ))}
          </ol>
        )}
      </li>
    );
  }
  return (
    <nav className="session-branches" aria-label="Branch tree">
      <h2>
        <IconGitBranch aria-hidden="true" /> Branch tree
      </h2>
      <ol>{tree(original)}</ol>
    </nav>
  );
}
