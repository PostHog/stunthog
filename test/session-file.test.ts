import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile } from "../src/sessions/domain/session-file.js";
import { buildTranscript } from "../web/src/sessions/transcript/transcript.js";

const input = { command: "hog version" };
const ask = "Which version is installed?";
const answer = "Version 1.";
const result = "1.0.0";
const jsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n");
const codex = (payload: unknown) => ({ type: "response_item", payload });
const turn = (type: string, content: unknown, extras = {}) => ({
  type,
  message: { role: type, content, ...extras },
});
const tool = { type: "tool_use", id: "c", name: "bash", input };

const transcripts = {
  claude: jsonl([
    turn("user", ask),
    turn("assistant", [tool], { model: "m" }),
    turn("user", [{ type: "tool_result", tool_use_id: "c", content: result }]),
    turn("assistant", answer),
  ]),
  codex: jsonl([
    { type: "turn_context", payload: { model: "m" } },
    codex({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: ask }],
    }),
    codex({
      type: "function_call",
      name: "bash",
      call_id: "c",
      arguments: JSON.stringify(input),
    }),
    codex({ type: "function_call_output", call_id: "c", output: result }),
    codex({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: answer }],
    }),
  ]),
  pi: jsonl([
    { type: "session", id: "session" },
    {
      type: "message",
      id: "1",
      parentId: null,
      message: { role: "user", content: ask },
    },
    {
      type: "message",
      id: "discarded",
      parentId: "1",
      message: { role: "assistant", content: "Other branch" },
    },
    {
      type: "message",
      id: "2",
      parentId: "1",
      message: {
        role: "assistant",
        model: "m",
        content: [
          { type: "toolCall", id: "c", name: "bash", arguments: input },
        ],
      },
    },
    {
      type: "message",
      id: "3",
      parentId: "2",
      message: {
        role: "toolResult",
        toolCallId: "c",
        toolName: "bash",
        content: [{ type: "text", text: result }],
      },
    },
    {
      type: "message",
      id: "4",
      parentId: "3",
      message: { role: "assistant", content: answer },
    },
  ]),
  opencode: JSON.stringify({
    info: { id: "s" },
    messages: [
      { type: "user", text: ask },
      {
        type: "assistant",
        model: { id: "m" },
        content: [
          {
            type: "tool",
            id: "c",
            name: "bash",
            state: {
              status: "completed",
              input,
              content: [{ type: "text", text: result }],
            },
          },
          { type: "text", text: answer },
        ],
      },
    ],
  }),
};
for (const [harness, body] of Object.entries(transcripts)) {
  test(`imports ${harness} messages and links tool results to their calls`, () => {
    const imported = parseSessionFile("session.jsonl", body, "  reference  ");
    assert.deepEqual(imported.model, {
      harness,
      model: "m",
      origin: "organic",
    });
    assert.equal(imported.memo, "reference");
    const trace = buildTranscript(
      imported.events.map((event, i) => ({
        event,
        id: i + 1,
        createdAt: "2026-11-27T15:00:00Z",
        phase: "agent",
        sequence: i + 1,
      })),
    );
    assert.deepEqual(
      trace.map((entry) => entry.kind),
      ["user", "tool", "message"],
    );
    assert.equal(trace[0]?.text, ask);
    assert.deepEqual(trace[1]?.args, input);
    assert.equal(trace[1]?.output, result);
    assert.equal(trace[2]?.text, answer);
  });
}
test("reads OpenCode v1 exports and accepts an empty memo", () => {
  const parsed = parseSessionFile(
    "session.json",
    JSON.stringify({
      info: { id: "s" },
      messages: [
        {
          info: { role: "assistant", modelID: "agent" },
          parts: [{ type: "text", text: "Done" }],
        },
      ],
    }),
  );
  assert.equal(parsed.memo, null);
  assert.equal(parsed.model.model, "agent");
  assert.equal(parsed.events.length, 1);
});
test("accepts a 50 MiB session file and rejects one extra byte", () => {
  const content = JSON.stringify(turn("assistant", answer)).padEnd(
    50 * 1024 * 1024,
  );
  assert.equal(parseSessionFile("log.json", content).events.length, 1);
  assert.throws(() => parseSessionFile("log.json", `${content} `), /50 MiB/);
});

test("rejects malformed, empty, and unrecognized transcripts", () => {
  for (const text of [
    "   ",
    "{}",
    '{"type":"session_meta"}',
    '{"type":"session"}\ninvalid',
  ])
    assert.throws(() => parseSessionFile("log.jsonl", text));
  assert.throws(
    () => parseSessionFile("log.jsonl", transcripts.pi, "x".repeat(501)),
    /memo/,
  );
});
