import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchEdit,
  editBackground,
  editPoint,
  fullSessionPrompt,
  previewHistory,
  traceTurns,
} from "../src/sessions/domain/trace-edit.js";
import { withResponses } from "../src/sessions/domain/transcript/response-entries.js";
import { buildTranscript } from "../src/sessions/domain/transcript/transcript.js";
import { previewContext } from "../src/sessions/infrastructure/native-preview-model.js";

const rows = (...events: unknown[]) =>
  events.map((event, i) => ({ id: i + 1, sequence: i + 1, event }));
const msg = (role: string, content: unknown) => ({
  type: role,
  message: { role, content },
});
const tool = (id: string) => ({
  type: "tool_use",
  id,
  name: "bash",
  input: { command: id },
});
const output = (id: string, text: string) =>
  msg("user", [{ type: "tool_result", tool_use_id: id, content: text }]);
const events = rows(
  msg("user", "Install the CLI"),
  msg("assistant", [tool("a"), tool("b")]),
  output("b", "second"),
  output("a", "first"),
  msg("assistant", "I will inspect the files."),
  msg("assistant", [tool("later")]),
  output("later", "private later output"),
  msg("assistant", "Done"),
);
test("an edited result keeps the parallel batch, native IDs, role order, and cutoff", () => {
  const turns = traceTurns(buildTranscript(events));
  const projection = previewHistory(turns, {
    entryId: "tool-a",
    field: "result",
    replacement: "new",
  });
  assert.deepEqual(
    projection.messages.map((m) => m.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(
    projection.messages[1]?.tool_calls?.map((c) => c.id),
    ["a", "b"],
  );
  assert.deepEqual(
    projection.messages.slice(2).map((m) => [m.tool_call_id, m.content]),
    [
      ["a", "new"],
      ["b", "second"],
    ],
  );
  assert.deepEqual(projection.next, [
    { kind: "message", text: "I will inspect the files." },
  ]);
  assert.doesNotMatch(
    JSON.stringify(projection.messages),
    /private later output|Done|I will inspect/,
  );
  assert.equal(editPoint(turns, "tool-a").result, "first");
  const request = previewContext(
    { api: "openai-responses", provider: "openai", id: "fixture" },
    [{ role: "system", content: "Use the CLI." }, ...projection.messages],
    [],
  );
  assert.equal(request.systemPrompt, "Use the CLI.");
  assert.deepEqual(
    request.messages.map((m) => m.role),
    ["user", "assistant", "toolResult", "toolResult"],
  );
  const result = request.messages[2];
  assert.ok(result?.role === "toolResult");
  assert.equal(result.toolCallId, "a");
  assert.equal(result.toolName, "bash");
  assert.deepEqual(result.content, [{ type: "text", text: "new" }]);
});

test("the starting point recovers the selected edit from saved branch history", () => {
  const turns = traceTurns(buildTranscript(events));
  const point = editPoint(turns, "tool-a");
  const history = (edit: Parameters<typeof editBackground>[1]) =>
    editBackground(turns, edit, []);
  const result = history({
    entryId: "tool-a",
    field: "result",
    replacement: "",
  });
  assert.deepEqual(branchEdit(point, result, "task"), {
    kind: "tool-result",
    before: "first",
    after: "",
  });
  const args = history({
    entryId: "tool-a",
    field: "arguments",
    replacement: '{"command":"pwd"}',
  });
  assert.deepEqual(branchEdit(point, args, "task"), {
    kind: "tool-arguments",
    before: JSON.stringify({ command: "a" }, null, 2),
    after: JSON.stringify({ command: "pwd" }, null, 2),
  });
  const sameArgs = history({
    entryId: "tool-a",
    field: "arguments",
    replacement: '{"command":"a"}',
    sampleResult: "",
  });
  assert.equal(
    branchEdit(point, sameArgs, "task", "arguments").sampleResult,
    "",
  );
  const agent = turns.flat().find((e) => e.text === "Done");
  assert.ok(agent);
  const reply = history({
    entryId: agent.id,
    field: "text",
    replacement: "Still working",
    followUp: "Check the CLI",
  });
  assert.deepEqual(branchEdit(editPoint(turns, agent.id), reply, "task"), {
    kind: "agent-message",
    before: "Done",
    after: "Still working",
    followUp: "Check the CLI",
  });
});

test("arguments need a JSON object and a hypothetical result, including empty output", () => {
  const turns = traceTurns(buildTranscript(events));
  const edit = {
    entryId: "tool-a",
    field: "arguments" as const,
    replacement: '{"command":"pwd"}',
  };
  assert.throws(() => previewHistory(turns, edit), /tool result/);
  assert.throws(
    () =>
      previewHistory(turns, { ...edit, replacement: "[]", sampleResult: "" }),
    /JSON object/,
  );
  const { messages } = previewHistory(turns, { ...edit, sampleResult: "" });
  assert.equal(
    messages[1]?.tool_calls?.[0]?.function.arguments,
    edit.replacement,
  );
  assert.equal(messages[2]?.content, "");
  assert.equal(messages[3]?.content, "second");
});

test("a full run can execute edited arguments and branch again without duplicating the background", () => {
  const turns = traceTurns(buildTranscript(events));
  const edit = {
    entryId: "tool-a",
    field: "arguments" as const,
    replacement: '{"command":"hog --version"}',
  };
  const history = editBackground(turns, edit, []);
  assert.deepEqual(history[1], {
    role: "tool",
    id: "a",
    name: "bash",
    arguments: { command: "hog --version" },
    result: undefined,
    status: "pending",
  });
  assert.equal(history[2]?.role === "tool" && history[2].result, "second");
  const sample = editBackground(turns, { ...edit, sampleResult: "" }, [])[1];
  assert.ok(
    sample?.role === "tool" &&
      sample.status === "edited" &&
      sample.result === "",
  );
  const prompt = fullSessionPrompt("Install the CLI", history);
  assert.doesNotMatch(prompt, /private later output|I will inspect|"first"/);
  const childTurns = traceTurns(
    buildTranscript(rows(msg("user", prompt), msg("assistant", "Installed."))),
  );
  assert.deepEqual(
    editBackground(
      childTurns,
      {
        entryId: "message-2-text-0",
        field: "text",
        replacement: "The CLI needs configuration.",
      },
      history,
    ),
    [...history, { role: "assistant", text: "The CLI needs configuration." }],
  );
});
test("a missing historical result cannot become an empty tool response", () => {
  const turns = traceTurns(
    buildTranscript(
      rows(
        {
          type: "item.completed",
          item: { id: "first", type: "command_execution", command: "pwd" },
        },
        msg("assistant", "Next"),
      ),
    ),
    "Run",
  );
  assert.throws(
    () =>
      previewHistory(turns, {
        entryId: "message-2-text-0",
        field: "text",
        replacement: "Continue",
        followUp: "How?",
      }),
    /lacks a tool result/,
  );
});

test("a final assistant edit requires a user turn and preserves both roles", () => {
  const turns = traceTurns(
    buildTranscript(rows(msg("assistant", "Done"))),
    "Install",
  );
  const edit = {
    entryId: "message-1-text-0",
    field: "text" as const,
    replacement: "Pending",
  };
  assert.throws(() => previewHistory(turns, edit), /follow-up/);
  assert.deepEqual(
    previewHistory(turns, { ...edit, followUp: "Continue" }).messages,
    [
      { role: "user", content: "Install" },
      { role: "assistant", content: "Pending" },
      { role: "user", content: "Continue" },
    ],
  );
  assert.throws(() => editPoint(turns, "missing"), /Choose/);
});
test("all harnesses project a complete call with its delivered output", () => {
  const input = { command: "pwd" };
  const cases = [
    rows(
      {
        type: "item.started",
        item: { id: "c", type: "command_execution", command: "pwd" },
      },
      {
        type: "item.completed",
        item: {
          id: "c",
          type: "command_execution",
          command: "pwd",
          aggregated_output: "old",
        },
      },
    ),
    rows({
      type: "tool_use",
      part: {
        callID: "c",
        tool: "bash",
        state: { status: "completed", input, output: "old" },
      },
    }),
    rows(msg("assistant", [tool("c")]), output("c", "old")),
    rows(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", id: "c", arguments: input },
          ],
        },
      },
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "c",
        args: input,
      },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: { content: [{ type: "text", text: "old" }] },
      },
    ),
  ];
  for (const trace of cases) {
    const recorded = buildTranscript(trace);
    assert.equal(recorded.length, 1);
    const entries = withResponses(
      recorded,
      rows({
        callId: "c",
        route: "bash",
        target: { kind: "shell", command: "pwd" },
        args: input,
        ruleId: "rule",
        original: "old",
        delivered: "intercepted",
      }),
      { mcps: [], evaluation: { mcpIds: [] } },
    );
    const turns = traceTurns(entries, "Start");
    assert.ok(recorded[0]);
    const id = recorded[0].id;
    assert.equal(editPoint(turns, id).result, "intercepted");
    const { messages } = previewHistory(turns, {
      entryId: id,
      field: "result",
      replacement: "edited",
    });
    assert.equal(messages.at(-1)?.tool_call_id, "c");
    assert.equal(messages.at(-1)?.content, "edited");
    const full = editBackground(
      turns,
      { entryId: id, field: "result", replacement: "edited" },
      [],
    );
    const last = full.at(-1);
    assert.ok(
      last?.role === "tool" && last.id === "c" && last.result === "edited",
    );
  }
});

test("an assistant message retains its calls and offers the recorded user follow-up", () => {
  const turns = traceTurns(
    buildTranscript(
      rows(
        msg("assistant", [{ type: "text", text: "Checking." }, tool("a")]),
        output("a", "v1"),
        msg("assistant", "Installed."),
        msg("user", "Which version?"),
        msg("assistant", "Version one."),
      ),
    ),
    "Install",
  );
  const projected = previewHistory(turns, {
    entryId: "tool-a",
    field: "result",
    replacement: "v2",
  });
  assert.deepEqual(
    projected.messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(projected.messages[1]?.content, "Checking.");
  assert.equal(projected.messages[1]?.tool_calls?.[0]?.id, "a");
  const point = editPoint(turns, "message-3-text-0");
  assert.equal(point.recordedFollowUp, "Which version?");
  assert.deepEqual(point.next, [{ kind: "message", text: "Version one." }]);
});
