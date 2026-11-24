import assert from "node:assert/strict";
import { test } from "node:test";
import { hasAgentEvidence } from "../src/sessions/domain/agent-evidence.js";

test("startup errors have no behavioral evidence; partial work still qualifies", () => {
  assert.equal(hasAgentEvidence("[]"), false);
  assert.equal(
    hasAgentEvidence(
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "turn.failed" },
      ]),
    ),
    false,
  );
  assert.equal(
    hasAgentEvidence(
      JSON.stringify([
        { role: "assistant", content: [{ type: "text", text: "Started" }] },
      ]),
    ),
    true,
  );
  assert.equal(
    hasAgentEvidence(
      JSON.stringify([
        { type: "tool_execution_start", toolName: "bash", toolCallId: "1" },
      ]),
    ),
    true,
  );
});
