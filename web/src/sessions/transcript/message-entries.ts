import { toolResponseId } from "../../../../src/sessions/domain/tool-call.js";
import {
  blocksText,
  record,
  string,
  type TranscriptEntry,
  toolKind,
  toolText,
} from "./types.js";

export function messageEntries(
  event: Record<string, unknown>,
  sequence: number,
): TranscriptEntry[] {
  const message = record(event.message);
  const base = { sequence, title: "" };

  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end"
  ) {
    const name = string(event.toolName);

    return [
      {
        ...base,
        id: `tool-${String(event.toolCallId ?? sequence)}`,
        kind: toolKind(name),
        title: name,
        name,
        ...(event.args !== undefined && { args: record(event.args) }),
        text: toolText(event.args),
        output: blocksText(record(event.result).content),
        status:
          event.type === "tool_execution_start"
            ? "running"
            : event.isError
              ? "failed"
              : "passed",
      },
    ];
  }

  if (!["message_end", "assistant", "user"].includes(String(event.type)))
    return [];
  if (message.role === "toolResult") return [];

  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];

  return content.flatMap((raw, index): TranscriptEntry[] => {
    const block = record(raw);
    // Claude can send separate thinking and text blocks with the same message ID.
    const id = `message-${String(message.id ?? sequence)}-${String(block.type)}-${index}`;

    if (block.type === "tool_use") {
      const name = string(block.name);

      return [
        {
          ...base,
          id: `tool-${String(block.id)}`,
          kind: toolKind(name),
          title: name,
          name,
          args: record(block.input),
          text: toolText(block.input),
          status: "running",
        },
      ];
    }
    if (block.type === "tool_result")
      return [
        {
          ...base,
          id: `tool-${String(block.tool_use_id)}`,
          responseId:
            content.length === 1
              ? toolResponseId(event.tool_use_result)
              : undefined,
          kind: "tool",
          text: "",
          output: blocksText(block.content),
          status: block.is_error ? "failed" : "passed",
        },
      ];
    if (block.type === "thinking")
      return [{ ...base, id, kind: "thinking", text: string(block.thinking) }];
    if (block.type === "text" && string(block.text))
      return [
        {
          ...base,
          id,
          kind:
            message.role === "user" || event.type === "user"
              ? "user"
              : "message",
          text: string(block.text),
        },
      ];

    return [];
  });
}
