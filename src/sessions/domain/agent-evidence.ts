import { asObject, callUpdates } from "./tool-call.js";
// Unknown event formats stay eligible for judging. Only skip known setup-only transcripts.
export function hasAgentEvidence(evidence: string): boolean {
  let rows: unknown;
  try {
    rows = JSON.parse(evidence);
  } catch {
    return true;
  }
  if (!Array.isArray(rows)) return true;
  return rows.some((raw) => {
    const event = asObject(raw);
    if (callUpdates(raw).length) return true;
    const message = asObject(event.message ?? raw);
    if (message.role === "user" || event.type === "user") return false;
    if (message.role === "assistant")
      return (
        !!message.content &&
        (!Array.isArray(message.content) || message.content.length > 0)
      );
    return ![
      "system",
      "thread.started",
      "turn.started",
      "turn.failed",
      "error",
      "session_start",
      "agent_start",
      "agent_end",
      "result",
      "artifact_error",
    ].includes(String(event.type));
  });
}
