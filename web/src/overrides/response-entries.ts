import type { ResponseCapture } from "../../../src/overrides/domain/response-override.js";
import { shellCallTarget } from "../../../src/overrides/domain/shell-commands.js";
import { identifyTool } from "../../../src/sessions/domain/tool-call.js";
import { record, type TranscriptEntry } from "../sessions/transcript/types.js";
import type { EventRow } from "../types.js";
import { displayResponse, previewText } from "./response-text.js";

function capturedRow(row: EventRow): ResponseCapture | undefined {
  const capture = record(row.event);
  if (
    typeof capture.callId !== "string" ||
    typeof capture.route !== "string" ||
    !("original" in capture)
  )
    return;
  return capture as unknown as ResponseCapture;
}

type SessionTools = {
  mcps: { id?: string }[];
  evaluation: { mcpIds: string[] };
};

function fromTranscript(
  entry: TranscriptEntry,
  snapshot: SessionTools,
): ResponseCapture | undefined {
  if (entry.output === undefined || !entry.args || entry.status !== "passed")
    return;
  const { name = "", args } = entry;
  const { index, tool } = identifyTool(name, entry.server);
  const base = {
    callId: entry.id,
    route: "session transcript",
    args,
    original: entry.output,
  };
  const shell = !entry.server && shellCallTarget(name, args);
  if (shell && entry.output)
    return { ...base, target: shell, route: entry.title };
  if (
    index === undefined &&
    ["webfetch", "web_fetch"].includes(name.toLowerCase()) &&
    typeof args.url === "string"
  ) {
    const body = entry.output.replace(/^URL: [^\n]+\n\n/, "");
    return { ...base, target: { kind: "web", url: args.url }, original: body };
  }
  if (index === undefined || !tool) return;
  if (
    tool === "web_fetch" &&
    Number(index) === snapshot.mcps.length &&
    typeof args.url === "string"
  )
    return {
      ...base,
      target: { kind: "web", url: args.url },
      original: entry.output.replace(/^URL: [^\n]+\n\n/, ""),
    };
  const serverId =
    snapshot.mcps[Number(index)]?.id ??
    snapshot.evaluation.mcpIds[Number(index)];
  if (!serverId) return;
  let original: unknown = { content: [{ type: "text", text: entry.output }] };
  try {
    const parsed = JSON.parse(entry.output);
    if (Array.isArray(parsed?.content)) original = parsed;
  } catch {
    /* Native transcripts can contain plain text. */
  }
  return { ...base, target: { kind: "mcp", serverId, tool }, original };
}

function callKey(capture: ResponseCapture) {
  if (capture.target.kind === "shell")
    return JSON.stringify(["shell", capture.target.command]);
  // Harnesses can serialize the same arguments with a different property order.
  return JSON.stringify([capture.target, capture.args], (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

type Recorded = { capture: ResponseCapture; sequence: number };

// Prefer explicit IDs. Some native CLIs only retain the tool name, arguments and returned text.
export function withResponses(
  entries: TranscriptEntry[],
  rows: EventRow[],
  snapshot: SessionTools,
): TranscriptEntry[] {
  const byId = new Map<string, Recorded>();
  for (const row of rows) {
    const capture = capturedRow(row);
    if (capture) byId.set(capture.callId, { capture, sequence: row.sequence });
  }
  const used = new Set<string>();
  const matched = entries.map((entry) => {
    const id = entry.responseId || entry.id.replace(/^tool-/, "");
    const item =
      (entry.kind === "tool" || entry.kind === "web") && byId.get(id);
    if (item && !used.has(id)) {
      used.add(id);
      return item.capture.inputOmitted && entry.args
        ? { ...item.capture, args: entry.args, inputOmitted: false }
        : item.capture;
    }
    return undefined;
  });
  const byCall = new Map<string, ResponseCapture[]>();
  for (const { capture } of byId.values()) {
    if (used.has(capture.callId)) continue;
    const key = callKey(capture);
    const list = byCall.get(key);
    if (list) list.push(capture);
    else byCall.set(key, [capture]);
  }
  const remaining = new Map<string, number>();
  const inferredCalls = entries.map((entry, i) => {
    if (matched[i]) return undefined;
    const inferred = fromTranscript(entry, snapshot);
    if (!inferred) return undefined;
    const key = callKey(inferred);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
    return { inferred, key };
  });
  const result = entries.map((entry, i) => {
    let capture = matched[i];
    if (!capture) {
      const candidate = inferredCalls[i];
      if (!candidate) return entry;
      const { inferred, key } = candidate;
      const candidates =
        byCall.get(key)?.filter((c) => !used.has(c.callId)) ?? [];
      if (candidates.length === 1 && remaining.get(key) === 1)
        capture = candidates[0];
      else if (candidates.length) {
        const output = previewText(inferred.original, "");
        const sameOutput = candidates.filter(
          (c) =>
            previewText(c.original, "") === output ||
            previewText(c.delivered ?? c.original, "") === output,
        );
        const first = sameOutput[0];
        if (
          first &&
          sameOutput.every(
            (c) =>
              c.ruleId === first.ruleId &&
              displayResponse(c.original) === displayResponse(first.original) &&
              displayResponse(c.delivered) === displayResponse(first.delivered),
          )
        )
          capture = first;
      }
      if (capture) {
        used.add(capture.callId);
        remaining.set(key, (remaining.get(key) ?? 1) - 1);
      } else capture = inferred;
    }
    return {
      ...entry,
      capture,
      ...(capture.ruleId &&
        capture.delivered !== undefined && {
          output: displayResponse(capture.delivered),
        }),
    };
  });
  for (const { capture, sequence } of byId.values())
    if (!used.has(capture.callId)) {
      result.push({
        id: `response-${capture.callId}`,
        sequence,
        kind: capture.target.kind === "web" ? "web" : "tool",
        title: capture.route,
        text:
          capture.target.kind === "web"
            ? (capture.target.url ?? "Web page")
            : capture.target.kind === "shell"
              ? capture.target.command
              : (capture.target.tool ?? "MCP tool"),
        output: displayResponse(capture.delivered ?? capture.original),
        status: record(capture.original).isError === true ? "failed" : "passed",
        capture,
      });
    }
  return result.sort((a, b) => a.sequence - b.sequence);
}
