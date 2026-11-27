import { z } from "zod";
import type { TranscriptEntry } from "./transcript/types.js";

export const initialPromptId = "initial-prompt";
export const editSchema = z
  .object({
    entryId: z.string().min(1).max(1024),
    field: z.enum(["text", "arguments", "result"]),
    replacement: z.string().max(500_000),
    sampleResult: z.string().max(500_000).optional(),
    followUp: z.string().trim().min(1).max(50_000).optional(),
  })
  .strict();
export type TraceEdit = z.infer<typeof editSchema>;
export interface TraceAction {
  kind: "user" | "message" | "tool";
  text: string;
}
export interface TraceEditPoint {
  harness: string;
  workspace: "initial" | "empty";
  sequence: number;
  toolName?: string | undefined;
  recordedFollowUp?: string | undefined;
  text: string;
  args?: Record<string, unknown> | undefined;
  result: string;
  tool: boolean;
  next: TraceAction[];
  needsFollowUp: boolean;
  kind: TranscriptEntry["kind"];
  models: { id: string; name: string }[];
  model: string;
  provider: string;
  canBranch: boolean;
  context: string[];
}
export interface PreviewReply {
  action: TraceAction;
  model: string;
  tokens: number | null;
  cost: number | null;
}
export interface PreviewMessage {
  role: "system" | "assistant" | "user" | "tool";
  content: string | null;
  tool_call_id?: string;
  isError?: boolean;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

const isTool = (entry: TranscriptEntry) =>
  entry.kind === "tool" || entry.kind === "web";
const toolName = (entry: TranscriptEntry) => {
  if (entry.name) return entry.name;
  const target = entry.capture?.target;
  if (target?.kind === "mcp" && target.tool) return target.tool;
  if (target?.kind === "web") return "web_fetch";
  return entry.title;
};
const toolId = (entry: TranscriptEntry) =>
  entry.id.replace(/^(tool-|native-|response-)/, "");
const toolArgs = (entry: TranscriptEntry) => entry.args ?? entry.capture?.args;
function action(entry: TranscriptEntry): TraceAction {
  if (isTool(entry))
    return {
      kind: "tool",
      text: `${toolName(entry)} ${JSON.stringify(toolArgs(entry) ?? {})}`,
    };
  return { kind: entry.kind === "user" ? "user" : "message", text: entry.text };
}

export function traceTurns(
  rows: TranscriptEntry[],
  prompt?: string,
  prefix = "",
) {
  const entries = rows.filter(
    (e) => isTool(e) || e.kind === "user" || e.kind === "message",
  );
  const first = entries[0];
  if (
    prompt &&
    prefix &&
    first?.kind === "user" &&
    first.text === prefix + prompt
  )
    entries[0] = { ...first, text: prompt };
  if (prompt && !(entries[0]?.kind === "user" && entries[0].text === prompt))
    entries.unshift({
      id: initialPromptId,
      sequence: 0,
      kind: "user",
      title: "",
      text: prompt,
    });
  const turns: TranscriptEntry[][] = [];
  // Multiple results can arrive in another order. Keep calls from one assistant turn together.
  let completedAt = -1;
  for (const entry of entries) {
    const last = turns.at(-1);
    const first = last?.[0];
    if (
      last &&
      first &&
      isTool(entry) &&
      isTool(first) &&
      ((!!entry.batch && entry.batch === first.batch) ||
        entry.sequence < completedAt)
    ) {
      last.push(entry);
      completedAt = Math.max(completedAt, entry.completedAt ?? entry.sequence);
    } else {
      turns.push([entry]);
      completedAt = entry.completedAt ?? entry.sequence;
    }
  }
  return turns;
}

export function editPoint(turns: TranscriptEntry[][], id: string) {
  const first = turns[0]?.[0];
  if (id === initialPromptId && first?.kind === "user") id = first.id;
  const index = turns.findIndex((turn) => turn.some((e) => e.id === id));
  const entry = turns[index]?.find((e) => e.id === id);
  if (!entry)
    throw new Error(
      "Choose a user message, agent message, or tool call in the agent log.",
    );
  const next = turns[index + 1];
  const tool = isTool(entry);
  const recordedFollowUp =
    entry.kind === "message" && next?.[0]?.kind === "user"
      ? next[0].text
      : undefined;
  const nextAction = recordedFollowUp ? turns[index + 2] : next;
  return {
    index,
    entry,
    text: entry.text,
    args: toolArgs(entry),
    result: entry.output ?? "",
    tool,
    toolName: tool ? toolName(entry) : undefined,
    recordedFollowUp,
    next: nextAction?.map(action) ?? [],
    needsFollowUp:
      entry.kind === "message" && (!next || next[0]?.kind === "user"),
  };
}

function validateEdit(
  point: ReturnType<typeof editPoint>,
  edit: TraceEdit,
  preview: boolean,
) {
  if ((edit.field === "text") === point.tool)
    throw new Error("Select an edit that applies to this entry.");
  if (edit.field === "text" && !edit.replacement.trim())
    throw new Error("Enter a message.");
  if (preview && edit.field === "arguments" && edit.sampleResult === undefined)
    throw new Error("Enter the tool result for the edited arguments.");
  if (preview && point.needsFollowUp && !edit.followUp)
    throw new Error("Enter a follow-up message to continue after this reply.");
  if (edit.followUp && point.entry.kind !== "message")
    throw new Error("Add a follow-up only after an agent message.");
  let args: Record<string, unknown> | undefined;
  if (edit.field === "arguments") {
    try {
      args = z.record(z.unknown()).parse(JSON.parse(edit.replacement));
    } catch {
      throw new Error("Enter the arguments as a JSON object.");
    }
  }
  return args;
}

export function previewHistory(turns: TranscriptEntry[][], edit: TraceEdit) {
  const point = editPoint(turns, edit.entryId);
  const args = validateEdit(point, edit, true);
  const cutoff = Math.max(
    point.entry.sequence,
    ...(turns[point.index] ?? []).map((e) => e.completedAt ?? e.sequence),
  );
  const messages: PreviewMessage[] = [];
  const names = new Set<string>();
  for (const [index, turn] of turns.slice(0, point.index + 1).entries()) {
    const first = turn[0];
    if (!first) continue;
    if (!isTool(first)) {
      messages.push({
        role: first.kind === "user" ? "user" : "assistant",
        content: first === point.entry ? edit.replacement : first.text,
      });
      continue;
    }
    const calls = turn.map((e) => {
      const name = toolName(e);
      const input = e === point.entry && args ? args : toolArgs(e);
      if (
        !name ||
        !input ||
        !/^[\w-]{1,128}$/.test(name) ||
        (e.completedAt ?? e.sequence) > cutoff ||
        e.status === "running"
      )
        throw new Error(
          "This trace lacks a complete tool call. Choose an earlier entry.",
        );
      names.add(name);
      return {
        id: toolId(e),
        type: "function" as const,
        function: { name, arguments: JSON.stringify(input) },
      };
    });
    const preceding = turns[index - 1]?.[0];
    const last = messages.at(-1);
    if (
      first.batch &&
      first.batch === preceding?.batch &&
      last?.role === "assistant" &&
      !last.tool_calls
    )
      last.tool_calls = calls;
    else messages.push({ role: "assistant", content: null, tool_calls: calls });
    for (const e of turn) {
      const content =
        e === point.entry
          ? args
            ? edit.sampleResult
            : edit.replacement
          : e.output;
      if (content === undefined)
        throw new Error(
          "This trace lacks a tool result. Choose an earlier entry.",
        );
      messages.push({
        role: "tool",
        ...(e.status === "failed" && { isError: true }),
        tool_call_id: toolId(e),
        content,
      });
    }
  }
  if (edit.followUp) messages.push({ role: "user", content: edit.followUp });
  return { messages, names: [...names], next: point.next };
}

export type BackgroundEntry =
  | { role: "user" | "assistant"; text: string }
  | {
      role: "tool";
      id: string;
      name: string;
      arguments?: Record<string, unknown> | undefined;
      result?: string | undefined;
      status?: string | undefined;
    };

export interface BranchEdit {
  kind: "user-message" | "agent-message" | "tool-arguments" | "tool-result";
  before: string | null;
  after: string;
  followUp?: string;
  sampleResult?: string;
}

// Read the value the harness received, including branches saved before we recorded the field.
export function branchEdit(
  point: ReturnType<typeof editPoint>,
  background: BackgroundEntry[],
  task: string,
  field?: TraceEdit["field"],
): BranchEdit {
  if (point.tool) {
    const entry = background.findLast(
      (item) => item.role === "tool" && item.id === toolId(point.entry),
    );
    if (entry?.role === "tool") {
      const originalArgs = JSON.stringify(point.args, null, 2);
      const editedArgs = JSON.stringify(entry.arguments, null, 2);
      const argumentsChanged = field
        ? field === "arguments"
        : entry.status === "pending" || originalArgs !== editedArgs;
      if (argumentsChanged && editedArgs !== undefined)
        return {
          kind: "tool-arguments",
          before: originalArgs ?? null,
          after: editedArgs,
          ...(entry.result !== undefined && { sampleResult: entry.result }),
        };
      if (entry.result !== undefined)
        return {
          kind: "tool-result",
          before: point.entry.output ?? null,
          after: entry.result,
        };
    }
  } else {
    const user = point.entry.kind === "user";
    const message = background.findLast(
      (item) => item.role === (user ? "user" : "assistant"),
    );
    const last = background.at(-1);
    const after = message && "text" in message ? message.text : undefined;
    if (after !== undefined || (user && !background.length))
      return {
        kind: user ? "user-message" : "agent-message",
        before: point.text,
        after: after ?? task,
        ...(!user && last?.role === "user" && { followUp: last.text }),
      };
  }
  throw new Error("The saved transcript does not contain the edited entry.");
}

export function editBackground(
  turns: TranscriptEntry[][],
  edit: TraceEdit,
  inherited: BackgroundEntry[],
) {
  const point = editPoint(turns, edit.entryId);
  const args = validateEdit(point, edit, false);
  const cutoff = Math.max(
    point.entry.sequence,
    ...(turns[point.index] ?? []).map((e) => e.completedAt ?? e.sequence),
  );
  const entries: BackgroundEntry[] = [];
  for (const entry of turns.slice(0, point.index + 1).flat()) {
    const selected = entry === point.entry;
    // An earlier branch already has structured history. Carry it forward once.
    if (
      inherited.length &&
      entry === turns[0]?.[0] &&
      entry.kind === "user" &&
      !selected
    ) {
      entries.push(...inherited);
    } else if (isTool(entry)) {
      const unfinished = (entry.completedAt ?? entry.sequence) > cutoff;
      const tool: BackgroundEntry = {
        role: "tool",
        id: toolId(entry),
        name: toolName(entry),
        arguments: toolArgs(entry),
        result: unfinished ? undefined : entry.output,
        status: unfinished ? "running" : entry.status,
      };
      if (selected) {
        if (args) tool.arguments = args;
        tool.result = args ? edit.sampleResult : edit.replacement;
        tool.status = tool.result === undefined ? "pending" : "edited";
      }
      entries.push(tool);
    } else {
      entries.push({
        role: entry.kind === "user" ? "user" : "assistant",
        text: selected ? edit.replacement : entry.text,
      });
    }
  }
  if (edit.followUp) entries.push({ role: "user", text: edit.followUp });
  return entries;
}

export const backgroundInstruction =
  "Continue this task from the edited transcript below.";

export function fullSessionPrompt(task: string, background: BackgroundEntry[]) {
  if (!background.length) return task;
  return [
    task,
    backgroundInstruction,
    "Use the transcript as background. Verify file state before you rely on earlier work.",
    "A pending tool call has no result. Use your tools to perform that call if it still applies.",
    "Complete the task and give your final answer.",
    JSON.stringify(background),
  ].join("\n\n");
}
