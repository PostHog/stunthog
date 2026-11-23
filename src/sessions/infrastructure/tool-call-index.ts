import type { Database as SQLite } from "bun:sqlite";
import { callUpdates, identifyTool } from "../domain/tool-call.js";

// The same upsert joins partial events during live capture and historical backfill.
export const upsertCall = `INSERT INTO ToolCall (sessionId, phase, callId, name, server, tool, serverIndex, source, input, output, status, sequence, createdAt)
VALUES (?, ?, ?, COALESCE(?, 'Unknown tool'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(sessionId,phase,callId) DO UPDATE SET
  name=CASE WHEN excluded.name='Unknown tool' THEN ToolCall.name ELSE excluded.name END,
  tool=CASE WHEN excluded.tool='' THEN ToolCall.tool ELSE excluded.tool END,
  serverIndex=COALESCE(excluded.serverIndex,ToolCall.serverIndex),
  server=COALESCE(excluded.server,ToolCall.server),
  source=CASE WHEN excluded.name='Unknown tool' THEN ToolCall.source ELSE excluded.source END,
  input=COALESCE(excluded.input,ToolCall.input),
  output=COALESCE(excluded.output,ToolCall.output),
  status=CASE WHEN excluded.status='running' THEN ToolCall.status ELSE excluded.status END`;
function searchValue(value: unknown) {
  return (
    JSON.stringify(value, (key, entry) =>
      /^(?:authorization|proxy-authorization|cookie|set-cookie|password|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i.test(
        key,
      ) && typeof entry === "string"
        ? "[redacted]"
        : entry,
    ) ?? null
  );
}
export function toolCallRows(
  sessionId: string,
  phase: string,
  updates: ReturnType<typeof callUpdates>,
  sequence: number,
  createdAt: number | string,
) {
  if (phase !== "agent" && phase !== "judge") return [];
  return updates.map((call) => {
    const { tool, index, source } = identifyTool(call.name ?? "", call.server);
    return [
      sessionId,
      phase,
      call.id,
      call.name || null,
      call.server || null,
      tool,
      index ?? null,
      source,
      searchValue(call.input),
      searchValue(call.output),
      call.status,
      sequence,
      createdAt,
    ];
  });
}

export function backfillToolCalls(db: SQLite) {
  const rows = db.query<
    {
      id: number;
      sessionId: string;
      phase: string;
      sequence: number;
      createdAt: number | string;
      event: string;
    },
    [number]
  >(
    `SELECT id,sessionId,phase,sequence,createdAt,event FROM SessionEvent WHERE id > ? AND phase IN ('agent','judge') ORDER BY id LIMIT 100`,
  );
  const insert = db.query(upsertCall);
  let cursor = 0;
  for (;;) {
    const page = rows.all(cursor);
    if (!page.length) break;
    for (const row of page) {
      for (const values of toolCallRows(
        row.sessionId,
        row.phase,
        callUpdates(JSON.parse(row.event)),
        row.sequence,
        row.createdAt,
      ))
        insert.run(...values);
      cursor = row.id;
    }
  }
}
