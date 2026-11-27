import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@posthog/quill";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../api.js";
import { Notice, PageTitle, Status } from "../components.js";
import { ModelReference } from "../models/ModelReference.js";
import { ResponseOverrideList } from "../overrides/ResponseOverrideList.js";
import { withResponses } from "../overrides/response-entries.js";
import { RequestState } from "../PageState.js";
import { ResourceIcon } from "../resources/ResourceIcon.js";
import { StatusIcon } from "../status/StatusIcon.js";
import type { Session } from "../types.js";
import { ConfigurationPanel } from "./ConfigurationPanel.js";
import { FilesPanel } from "./FilesPanel.js";
import { LogPanel } from "./LogPanel.js";
import { ModelBehaviorDrift } from "./ModelBehaviorDrift.js";
import {
  type BranchRow,
  SessionBranches,
  threadLink,
} from "./SessionBranches.js";
import { SessionJudgment } from "./SessionJudgment.js";
import { SessionMetadata } from "./SessionMetadata.js";
import { isActive } from "./session-filters.js";
import { TranscriptFilterIcon } from "./transcript/TranscriptFilterIcon.js";
import { buildTranscript } from "./transcript/transcript.js";
import { useSessionEvents } from "./useSessionEvents.js";

const pollBranches = (rows: BranchRow[]) => rows.some(isActive);

export function SessionDetail({
  id,
  branch,
}: {
  id: string;
  branch?: string | null;
}) {
  const {
    data: session,
    error,
    refresh,
  } = useApi<Session>(
    `/sessions/${encodeURIComponent(branch || id)}`,
    isActive,
  );
  useEffect(() => {
    if (!branch && session?.rootSessionId) {
      const entry = new URLSearchParams(window.location.hash.split("?")[1]).get(
        "entry",
      );
      window.location.replace(
        threadLink(session.rootSessionId, session.id, entry ?? undefined),
      );
    }
  }, [branch, session?.rootSessionId, session?.id]);
  if (!session) return <RequestState error={error} retry={refresh} />;
  if (branch && session.rootSessionId !== id)
    return <Notice error="This branch belongs to a different session." />;
  return (
    <SessionView
      key={session.id}
      session={session}
      error={error}
      refresh={refresh}
    />
  );
}
function SessionView({
  session,
  error,
  refresh,
}: {
  session: Session;
  error: string;
  refresh: () => void;
}) {
  const id = session.id;
  const root = session.rootSessionId ?? id;
  const family = useApi<BranchRow[]>(
    `/sessions/${root}/branches`,
    pollBranches,
  );
  const nodes = useMemo(() => {
    let index = 0;
    return (family.data ?? []).map((row) => ({
      ...row,
      name: row.parentSessionId ? `Branch ${++index}` : "Original",
    }));
  }, [family.data]);
  const current = nodes.find((node) => node.id === id);
  const [tab, setTab] = useState("agent");
  const [failure, setFailure] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [jump, setJump] = useState({
    callId: "",
    entryId:
      new URLSearchParams(window.location.hash.split("?")[1]).get("entry") ??
      "",
    visit: 0,
  });
  const active = !!session && isActive(session);
  const [judgeOpened, setJudgeOpened] = useState(false);
  const agentTrace = useSessionEvents(id, "agent", !!session, active);
  const judgeTrace = useSessionEvents(id, "judge", judgeOpened, active);
  const interceptTrace = useSessionEvents(
    id,
    "intercepts",
    !!session?.interceptedCalls,
    active,
  );
  const events = agentTrace.events;
  const captures = useMemo(() => {
    const bySequence = new Map<number, (typeof events)[number]>();
    for (const row of [...events, ...interceptTrace.events])
      if (row.phase === "response") bySequence.set(row.sequence, row);
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }, [events, interceptTrace.events]);
  // A session retains the configuration captured at creation.
  const [snapshot] = useState(session.snapshot);
  const agentEntries = useMemo(
    () =>
      snapshot
        ? withResponses(
            buildTranscript(events.filter((event) => event.phase === "agent")),
            captures,
            snapshot,
          )
        : [],
    [events, snapshot, captures],
  );
  const judgeEntries = useMemo(
    () =>
      tab === "judge"
        ? buildTranscript(
            judgeTrace.events.filter((event) => event.phase === "judge"),
          )
        : [],
    [judgeTrace.events, tab],
  );

  function showEntry(entryId: string) {
    setJump((current) => ({ callId: "", entryId, visit: current.visit + 1 }));
    setTab("agent");
  }

  async function cancel() {
    if (
      !confirm(
        "Cancel this session? The current work will stop. Usage already incurred will still be charged.",
      )
    )
      return;

    setCancelling(true);
    setFailure("");

    try {
      await api(`/sessions/${id}/cancel`, { method: "POST" });
      refresh();
    } catch (error) {
      setFailure(String(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="session-detail">
      <div className="session-path">
        <a className="back-link" href={`#evals/${session.evalId}`}>
          {session.eval.title}
        </a>
        {session.parentSessionId && (
          <>
            {" "}
            / <a href={threadLink(root, root)}>Original session</a>
          </>
        )}
      </div>
      <div className="session-heading">
        <PageTitle
          title={
            session.parentSessionId
              ? (current?.name ?? "Branch")
              : `${session.harness === "opencode" ? "OpenCode" : session.harness === "claude" ? "Claude Code" : session.harness === "codex" ? "Codex" : "Pi"} session`
          }
        >
          <Status value={session.status} />
          {active && (
            <Button
              type="button"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling && <StatusIcon name="spinner" />}
              {cancelling ? "Cancelling…" : "Cancel session"}
            </Button>
          )}
        </PageTitle>
        <ModelReference harness={session.harness} model={session.model} />
      </div>
      <Notice error={error || failure || session.error || undefined} />
      <div className="session-layout">
        <section className="session-agent" aria-label="Session activity">
          <Tabs
            className="session-tabs"
            value={tab}
            onValueChange={(value) => {
              if (value === "judge") setJudgeOpened(true);
              setTab(String(value));
            }}
          >
            <TabsList className="session-tab-list" aria-label="Session views">
              <TabsTrigger value="agent">
                <TranscriptFilterIcon kind="tool" /> Agent logs
              </TabsTrigger>
              <TabsTrigger value="judge">
                <StatusIcon name="check" /> Judge logs
              </TabsTrigger>
              <TabsTrigger value="files">
                <ResourceIcon name="folder" /> Files
              </TabsTrigger>
              <TabsTrigger value="configuration">
                <TranscriptFilterIcon kind="settings" /> Configuration
              </TabsTrigger>
            </TabsList>
            <TabsContent keepMounted value="agent" className="session-log-view">
              <LogPanel
                key={jump.visit}
                session={session}
                active={active}
                phase="agent"
                entries={agentEntries}
                branches={nodes}
                onBranchCreated={family.refresh}
                error={agentTrace.error || interceptTrace.error}
                loadOlder={
                  agentTrace.more || agentTrace.error
                    ? () => void agentTrace.load()
                    : undefined
                }
                initialCallId={jump.callId}
                initialEntryId={jump.entryId}
              />
            </TabsContent>
            <TabsContent keepMounted value="judge" className="session-log-view">
              <LogPanel
                session={session}
                active={active}
                phase="judge"
                entries={judgeEntries}
                error={judgeTrace.error}
                loadOlder={
                  judgeTrace.more || judgeTrace.error
                    ? () => void judgeTrace.load()
                    : undefined
                }
              />
            </TabsContent>
            <TabsContent value="files">
              <FilesPanel
                id={id}
                active={active}
                organic={session.origin === "organic"}
              />
            </TabsContent>
            <TabsContent value="configuration">
              <ConfigurationPanel session={session} />
            </TabsContent>
          </Tabs>
        </section>
        <section
          className="session-inspector"
          aria-label="Session details"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll this pane.
          tabIndex={0}
        >
          <Notice error={family.error} />
          <SessionBranches
            nodes={nodes}
            root={root}
            selected={id}
            onEntry={showEntry}
          />
          <h2>
            {session.parentSessionId ? "Branch details" : "Session details"}
          </h2>
          <SessionMetadata session={session} />
          <ModelBehaviorDrift
            session={session}
            entries={agentEntries}
            onEvidence={showEntry}
            onInspect={(callId) => {
              const row = captures.find(
                (row) =>
                  (row.event as { callId?: string } | null)?.callId === callId,
              );
              if (row && agentTrace.more) void agentTrace.load(row.sequence);
              setJump((current) => ({
                callId,
                entryId: "",
                visit: current.visit + 1,
              }));
              setTab("agent");
            }}
          />
          <ResponseOverrideList
            rules={session.snapshot.evaluation.responseOverrides}
            servers={session.snapshot.mcps}
          />
          <SessionJudgment session={session} />
        </section>
      </div>
    </div>
  );
}
