import { toolResponseId } from "../tool-call.js";
import {
  blocksText,
  record,
  string,
  type TranscriptEntry,
  toolKind,
  toolText,
} from "./types.js";

export function nativeEntries(
  event: Record<string, unknown>,
  sequence: number,
): TranscriptEntry[] {
  const item = record(event.item);
  const part = record(event.part);
  const id = `native-${String(item.id ?? part.id ?? sequence)}`;
  const base = { id, sequence };

  if (item.type === "agent_message" || item.type === "reasoning")
    return [
      {
        ...base,
        kind: item.type === "reasoning" ? "thinking" : "message",
        title: "",
        text: string(item.text),
      },
    ];

  if (
    [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
    ].includes(String(item.type))
  ) {
    return [
      {
        ...base,
        kind: toolKind(String(item.type)),
        title:
          item.type === "command_execution"
            ? "shell"
            : String(item.tool ?? item.type).replaceAll("_", " "),
        name:
          item.type === "command_execution"
            ? "command_execution"
            : string(item.tool ?? item.type),
        server: string(item.server),
        args:
          item.type === "command_execution"
            ? { command: string(item.command) }
            : item.type === "file_change"
              ? { changes: item.changes }
              : item.type === "web_search"
                ? { query: item.query }
                : record(item.arguments),
        responseId: toolResponseId(item.result),
        text:
          string(item.command ?? item.query) ||
          (item.changes
            ? JSON.stringify(item.changes)
            : toolText(item.arguments)),
        ...((item.aggregated_output !== undefined ||
          record(item.result).content !== undefined ||
          record(item.error).message !== undefined) && {
          output:
            string(item.aggregated_output) ||
            blocksText(record(item.result).content) ||
            string(record(item.error).message),
        }),
        ...(typeof item.exit_code === "number" && { exitCode: item.exit_code }),
        status:
          item.status === "failed" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0)
            ? "failed"
            : event.type === "item.completed"
              ? "passed"
              : "running",
      },
    ];
  }

  if (event.type === "text" || event.type === "reasoning")
    return [
      {
        ...base,
        kind: event.type === "reasoning" ? "thinking" : "message",
        ...(part.messageID ? { batch: String(part.messageID) } : {}),
        title: "",
        text: string(part.text),
      },
    ];

  if (event.type === "tool_use" || part.type === "tool") {
    const state = record(part.state);
    const name = string(part.tool) || "tool";

    return [
      {
        ...base,
        id: `tool-${String(part.callID ?? part.id ?? sequence)}`,
        kind: toolKind(name),
        title: name,
        name,
        ...(part.messageID ? { batch: String(part.messageID) } : {}),
        args: record(state.input),
        text: toolText(state.input) || string(state.title),
        ...((state.output !== undefined || state.error !== undefined) && {
          output: string(state.output ?? state.error),
        }),
        status:
          state.status === "error"
            ? "failed"
            : state.status === "completed"
              ? "passed"
              : "running",
      },
    ];
  }

  if (event.type === "error" || event.type === "turn.failed")
    return [
      {
        ...base,
        kind: "system",
        title: "Error",
        text:
          string(record(event.error).message) ||
          string(event.error) ||
          "The harness failed.",
        status: "failed",
      },
    ];

  return [];
}
