import { messageEntries } from "./message-entries.js";
import { nativeEntries } from "./native-entries.js";
import type { TraceEvent } from "./types.js";
import { record, string, type TranscriptEntry } from "./types.js";

// Stream updates replace the same row; tool results keep the original call and its position.
export function buildTranscript(events: TraceEvent[]): TranscriptEntry[] {
  const entries = new Map<string, TranscriptEntry>();

  for (const row of events) {
    const event = record(row.event);
    const updates = [
      ...messageEntries(event, row.sequence),
      ...nativeEntries(event, row.sequence),
    ];

    for (const update of updates) {
      const previous = entries.get(update.id);

      entries.set(update.id, {
        ...previous,
        ...update,
        ...(update.status &&
          update.status !== "running" && { completedAt: row.sequence }),
        sequence: previous?.sequence ?? update.sequence,
        title: update.title || previous?.title || "",
        text: update.text || previous?.text || "",
        kind: previous?.kind ?? update.kind,
      });
    }

    if (
      event.type === "result" &&
      string(event.result) &&
      ![...entries.values()].some((entry) => entry.text === event.result)
    )
      entries.set(`result-${row.id}`, {
        id: `result-${row.id}`,
        sequence: row.sequence,
        kind: event.is_error ? "system" : "message",
        title: event.is_error ? "Error" : "",
        text: string(event.result),
      });
  }

  return [...entries.values()];
}
