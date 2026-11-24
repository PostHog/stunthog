import assert from "node:assert/strict";
import { test } from "node:test";
import { compactJudgeEvidence } from "../src/sessions/domain/judge-evidence.js";

test("bounds tool output and retains identifiers, relevant evidence and assistant messages", () => {
  const text =
    "intro" + "a".repeat(5000) + "command --help" + "b".repeat(5000) + "end";
  const rows = [
    {
      role: "toolResult",
      toolCallId: "123",
      content: [{ type: "text", text }],
    },
    { role: "assistant", content: text },
  ];
  const compact = JSON.parse(
    compactJudgeEvidence(JSON.stringify(rows), ["command --help"]),
  );
  assert.equal(compact[0].toolCallId, "123");
  assert.ok(compact[0].content[0].text.length < 6000);
  assert.match(compact[0].content[0].text, /command --help/);
  assert.equal(compact[1].content, text);
});
