import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@posthog/quill";
import { useMemo, useState } from "react";
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
import { SessionJudgment } from "./SessionJudgment.js";
import { SessionMetadata } from "./SessionMetadata.js";
import { isActive } from "./session-filters.js";
import { TranscriptFilterIcon } from "./transcript/TranscriptFilterIcon.js";
import { buildTranscript } from "./transcript/transcript.js";
import { useSessionEvents } from "./useSessionEvents.js";

export function SessionDetail({ id }: { id: string }) {
  const {
    data: session,
    error,
    refresh,
  } = useApi<Session>(`/sessions/${id}`, true);
  const [tab, setTab] = useState("agent");
  const [failure, setFailure] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [jump, setJump] = useState({ callId: "", visit: 0 });
  const active = !!session && isActive(session);
  const { events, error: traceError } = useSessionEvents(id, active);
  const snapshot = session?.snapshot;
  const agentEntries = useMemo(
    () =>
      snapshot
        ? withResponses(
            buildTranscript(events.filter((event) => event.phase === "agent")),
            events.filter((event) => event.phase === "response"),
            snapshot,
          )
        : [],
    [events, snapshot],
  );
  const judgeEntries = useMemo(
    () =>
      tab === "judge"
        ? buildTranscript(events.filter((event) => event.phase === "judge"))
        : [],
    [events, tab],
  );

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

  if (!session) return <RequestState error={error} retry={refresh} />;

  return (
    <div className="session-detail">
      <a className="back-link" href={`#evals/${session.evalId}`}>
        {session.eval.title}
      </a>
      <div className="session-heading">
        <PageTitle
          title={`${session.harness === "opencode" ? "OpenCode" : session.harness === "claude" ? "Claude Code" : session.harness === "codex" ? "Codex" : "Pi"} session`}
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
            onValueChange={(value) => setTab(String(value))}
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
                error={traceError}
                initialCallId={jump.callId}
              />
            </TabsContent>
            <TabsContent keepMounted value="judge" className="session-log-view">
              <LogPanel
                session={session}
                active={active}
                phase="judge"
                entries={judgeEntries}
                error={traceError}
              />
            </TabsContent>
            <TabsContent value="files">
              <FilesPanel id={id} active={active} />
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
          <h2>Session details</h2>
          <SessionMetadata session={session} />
          <ModelBehaviorDrift
            session={session}
            entries={agentEntries}
            onInspect={(callId) => {
              setJump((current) => ({ callId, visit: current.visit + 1 }));
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
