import assert from "node:assert/strict";
import { test } from "node:test";
import {
  highlightParts,
  transcriptSearch,
} from "../web/src/sessions/transcript/search.js";
import { buildTranscript } from "../web/src/sessions/transcript/transcript.js";
import type { EventRow } from "../web/src/types.js";

function rows(...events: unknown[]): EventRow[] {
  return events.map((event, index) => ({
    id: index + 1,
    sequence: index + 1,
    phase: "agent",
    createdAt: "2026-11-12T12:00:00Z",
    event,
  }));
}

test("Pi transcript joins tool results to calls and omits stream deltas", () => {
  const result = buildTranscript(
    rows(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "npm run build" },
      },
      { type: "message_update", assistantMessageEvent: { delta: "partial" } },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "Build passed" }] },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "**Done**" },
            { type: "thinking", thinking: "Check the output." },
          ],
        },
      },
    ),
  );

  assert.equal(result.length, 3);
  assert.equal(result[0]?.text, "npm run build");
  assert.equal(result[0]?.output, "Build passed");
  assert.equal(result[0]?.sequence, 1);
  assert.equal(result[0]?.status, "passed");
  assert.equal(result[2]?.kind, "thinking");
});

test("Codex updates one command row and retains failed exit status", () => {
  const result = buildTranscript(
    rows(
      {
        type: "item.started",
        item: { id: "one", type: "command_execution", command: "npm test" },
      },
      {
        type: "item.completed",
        item: {
          id: "one",
          type: "command_execution",
          command: "npm test",
          exit_code: 1,
          aggregated_output: "Test failed",
        },
      },
    ),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "failed");
  assert.equal(result[0]?.output, "Test failed");
});

test("Claude pairs tool messages and does not repeat its final response", () => {
  const result = buildTranscript(
    rows(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "app.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-1",
              content: "Source code",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done" }] },
      },
      { type: "result", result: "Done" },
    ),
  );

  assert.equal(result.length, 2);
  assert.equal(result[0]?.title, "Read");
  assert.equal(result[0]?.output, "Source code");
});

test("OpenCode shows web evidence and ignores unknown events safely", () => {
  const result = buildTranscript(
    rows(null, "unknown", {
      type: "tool_use",
      part: {
        id: "part",
        callID: "web-1",
        type: "tool",
        tool: "webfetch",
        state: {
          status: "completed",
          input: { url: "https://posthog.com/docs" },
          output: "Docs",
        },
      },
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, "web");
  assert.equal(result[0]?.text, "https://posthog.com/docs");
  assert.equal(result[0]?.output, "Docs");
});

test("Claude keeps final text separate from thinking with the same message ID", () => {
  const result = buildTranscript(
    rows(
      {
        type: "assistant",
        message: {
          id: "msg-1",
          content: [{ type: "thinking", thinking: "Plan" }],
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg-1",
          content: [{ type: "text", text: "Final reply" }],
        },
      },
      { type: "result", result: "Final reply" },
    ),
  );

  assert.deepEqual(
    result.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: "thinking", text: "Plan" },
      { kind: "message", text: "Final reply" },
    ],
  );
});

test("transcript search finds typos and supplies offsets for the matching field", () => {
  const entries = buildTranscript(
    rows(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Configure OpenTelemetry for logs." },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "No matching content." }] },
      },
    ),
  );
  const hits = transcriptSearch(entries, (entry) => entry.text).search(
    "opentelemety",
  );
  assert.equal(hits.length, 1);
  const [hit] = hits;
  assert.ok(hit);
  const match = hit.matches?.find((field) => field.key === "text");
  assert.ok(match);
  const parts = highlightParts(hit.item.text, match.indices);
  assert.equal(parts.map((part) => part.text).join(""), hit.item.text);
  assert.match(
    parts
      .filter((part) => part.match)
      .map((part) => part.text)
      .join(""),
    /OpenTelemet/,
  );
});

test("recorded edits join repeated native tools by response ID or returned output", async () => {
  const { withResponses } = await import(
    "../web/src/overrides/response-entries.js"
  );
  const target = { kind: "web", url: "https://example.com" } as const;
  const calls = ["second", "first", "managed", "same", "same"].map(
    (text, i) => ({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        id: String(i),
        server: "eval_0",
        tool: "web_fetch",
        arguments: { url: target.url },
        result: {
          content: [{ type: "text", text: `URL: ${target.url}\n\n${text}` }],
          ...(i === 2 && { _meta: { "stunthog/responseId": "c2" } }),
          ...(i === 3 && { _meta: { "agent-eval/responseId": "c4" } }),
        },
      },
    }),
  );
  const captures = ["first", "second", "managed", "same", "same"].map(
    (text, i) => ({
      callId: `c${i}`,
      route: "web fetch",
      args: { url: target.url },
      target,
      original: "previous",
      delivered: text,
      ruleId: "r",
    }),
  );
  const trace = withResponses(
    buildTranscript(rows(...calls)),
    rows(...captures, captures[0]),
    { evaluation: { mcpIds: [] }, mcps: [] },
  );
  assert.deepEqual(
    trace.map((entry) => entry.capture?.callId),
    ["c1", "c0", "c2", "c4", "c3"],
  );
  assert.deepEqual(
    trace.map((entry) => entry.output),
    ["second", "first", "managed", "same", "same"],
  );
});

test("Codex shell traces can start a rule from a baseline and show the later edit on the same tool row", async () => {
  const { withResponses } = await import(
    "../web/src/overrides/response-entries.js"
  );
  const command = "printf first; printf second";
  const entries = buildTranscript(
    rows({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: `/bin/zsh -lc '${command}'`,
        aggregated_output: "firstsecond",
        exit_code: 0,
        status: "completed",
      },
    }),
  );
  const snapshot = { evaluation: { mcpIds: [] }, mcps: [] };
  const target = { kind: "shell", match: "batch", command } as const;
  const baseline = withResponses(entries, [], snapshot);
  assert.deepEqual(baseline[0]?.capture?.target, target);
  assert.equal(baseline[0]?.capture?.original, "firstsecond");
  const events = rows({
    callId: "call_id",
    route: "Shell",
    args: { command },
    target,
    original: "firstsecond",
    delivered: "changed",
    ruleId: "rule",
  });
  const trace = withResponses(entries, events, snapshot);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.id, entries[0]?.id);
  assert.equal(trace[0]?.capture?.ruleId, "rule");
  assert.equal(trace[0]?.output, "changed");
});
