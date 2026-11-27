import type { HarnessId } from "../../harnesses/domain/harness.js";
import { asObject } from "./tool-call.js";

export const maxSessionFileMiB = 50;
export const maxSessionFileBytes = maxSessionFileMiB * 1024 * 1024;
export const maxSessionFilesPerUpload = 10;
export const maxSessionMemoLength = 500;

export interface SessionFile {
  filename: string;
  content: string;
  memo: string | null;
  model: { harness: HarnessId; model: string; origin: "organic" };
  events: Record<string, unknown>[];
}

type Row = Record<string, unknown>;
const blocks = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(asObject) : [];
const message = (role: string, content: unknown) => ({
  type: role,
  message: { role, content },
});

function records(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        throw new Error(
          `Invalid JSON on line ${index + 1}. Choose a JSON or JSONL session file.`,
        );
      }
    });
  }
}

function codexEvents(row: Row): Row[] {
  if (
    row.type === "item.completed" ||
    row.type === "item.started" ||
    row.type === "turn.failed"
  )
    return [row];
  if (row.type !== "response_item") return [];
  const item = asObject(row.payload);
  if (
    item.type === "message" &&
    (item.role === "assistant" || item.role === "user")
  )
    return [
      message(
        item.role,
        blocks(item.content)
          .map((b) => ({ type: "text", text: b.text }))
          .filter((b) => typeof b.text === "string"),
      ),
    ];
  if (item.type === "reasoning")
    return blocks(item.summary).map((b) => ({
      type: "reasoning",
      part: { text: b.text },
    }));
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    let input = item.arguments ?? item.input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        input = { input };
      }
    }
    return [
      message("assistant", [
        { type: "tool_use", id: item.call_id, name: item.name, input },
      ]),
    ];
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  )
    return [
      message("user", [
        {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output,
        },
      ]),
    ];
  if (item.type === "web_search_call")
    return [
      {
        type: "item.completed",
        item: {
          ...item,
          type: "web_search",
          query: asObject(item.action).query,
        },
      },
    ];
  return [];
}

function openCodeEvents(row: Row): Row[] {
  if (["text", "reasoning", "tool_use"].includes(String(row.type)) && row.part)
    return [row];
  const role = asObject(row.info).role ?? row.type;
  if (role === "user" && typeof row.text === "string")
    return [message("user", row.text)];
  return blocks(row.parts ?? row.content).flatMap((part): Row[] => {
    if (part.type === "text")
      return [message(role === "user" ? "user" : "assistant", part.text)];
    if (part.type === "reasoning") return [{ type: "reasoning", part }];
    if (part.type !== "tool") return [];
    const state = asObject(part.state);
    const output =
      state.output ??
      blocks(state.content)
        .map((b) => b.text ?? b.name)
        .join("\n");
    return [
      {
        type: "tool_use",
        part: {
          ...part,
          tool: part.tool ?? part.name,
          state: { ...state, output: output || state.error },
        },
      },
    ];
  });
}

function piEvents(row: Row): Row[] {
  if (row.type === "tool_execution_start" || row.type === "tool_execution_end")
    return [row];
  const msg = asObject(row.message ?? row);
  if (msg.role === "toolResult")
    return [
      message("user", [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
          is_error: msg.isError,
        },
      ]),
    ];
  if (msg.role !== "user" && msg.role !== "assistant") return [];
  const content = Array.isArray(msg.content)
    ? blocks(msg.content).map((b) =>
        b.type === "toolCall"
          ? { type: "tool_use", id: b.id, name: b.name, input: b.arguments }
          : b,
      )
    : msg.content;
  return [message(msg.role, content)];
}

// Pi logs are trees. The last entry identifies the active branch in a saved file.
function piBranch(rows: Row[]) {
  const byId = new Map(
    rows.filter((row) => "parentId" in row).map((row) => [row.id, row]),
  );
  if (!byId.size) return rows;
  const branch: Row[] = [];
  const visited = new Set();
  let row = [...byId.values()].at(-1);
  while (row && !visited.has(row.id)) {
    branch.push(row);
    visited.add(row.id);
    row = byId.get(row.parentId);
  }
  return branch.reverse();
}

export function parseSessionFile(
  filename: string,
  content: string,
  memo = "",
): SessionFile {
  if (Buffer.byteLength(content) > maxSessionFileBytes)
    throw new Error(
      `Choose a session file of ${maxSessionFileMiB} MiB or less.`,
    );
  if (!content.trim())
    throw new Error("Choose a session file that contains agent activity.");
  if (typeof memo !== "string" || memo.trim().length > maxSessionMemoLength)
    throw new Error("Use 500 characters or fewer for the memo.");
  const parsed = records(content);
  const exported = asObject(parsed);
  const openCode = Array.isArray(exported.messages) && !!exported.info;
  let rows = blocks(
    openCode ? exported.messages : Array.isArray(parsed) ? parsed : [parsed],
  );
  let harness: HarnessId;
  let convert: (r: Row) => Row[];
  if (
    openCode ||
    rows.some(
      (r) =>
        (r.parts && asObject(r.info).role) ||
        (r.part && ["text", "reasoning", "tool_use"].includes(String(r.type))),
    )
  ) {
    harness = "opencode";
    convert = openCodeEvents;
  } else if (
    rows.some((r) =>
      [
        "session_meta",
        "turn_context",
        "response_item",
        "thread.started",
        "item.completed",
      ].includes(String(r.type)),
    )
  ) {
    harness = "codex";
    convert = codexEvents;
  } else if (
    rows.some(
      (r) =>
        ["message", "session", "message_end"].includes(String(r.type)) ||
        r.role === "assistant",
    )
  ) {
    harness = "pi";
    rows = piBranch(rows);
    if (rows.some((r) => r.type === "message_end"))
      rows = rows.filter((r) =>
        ["message_end", "tool_execution_start", "tool_execution_end"].includes(
          String(r.type),
        ),
      );
    convert = piEvents;
  } else if (
    rows.some(
      (r) =>
        ["assistant", "user"].includes(String(r.type)) &&
        asObject(r.message).content !== undefined,
    )
  ) {
    harness = "claude";
    convert = (r) =>
      r.type === "user" || r.type === "assistant"
        ? [message(r.type, asObject(r.message).content)]
        : [];
  } else
    throw new Error(
      "Choose a native session log from Claude Code, Codex, OpenCode, or Pi.",
    );

  let model = "Unknown model";
  const events = rows
    .flatMap((row) => {
      const entry = asObject(row.message ?? row);
      const candidate =
        harness === "opencode"
          ? (asObject(row.model).id ?? asObject(row.info).modelID)
          : harness === "codex"
            ? asObject(row.payload).model
            : (entry.model ?? row.modelId);
      if (
        typeof candidate === "string" &&
        candidate.trim() &&
        candidate !== "<synthetic>"
      )
        model = candidate.trim().slice(0, 200);
      return convert(row);
    })
    .filter((event) => {
      if (!event.message) return true;
      const body = asObject(event.message).content;
      return typeof body === "string"
        ? Boolean(body.trim())
        : Array.isArray(body) && body.length > 0;
    });
  if (!events.length)
    throw new Error("This file has no recorded messages or tool calls.");
  return {
    filename:
      filename.replaceAll("\\", "/").split("/").pop()?.slice(0, 255) ||
      "session.jsonl",
    content,
    memo: memo.trim() || null,
    model: { harness, model, origin: "organic" },
    events,
  };
}
