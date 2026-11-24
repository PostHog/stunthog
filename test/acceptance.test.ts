import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTrace } from "../src/harnesses/infrastructure/native-trace.js";
import {
  criterionDecisions,
  passesSession,
} from "../web/src/evals/acceptance.js";

test("acceptance retains failed sessions and missing decisions", () => {
  assert.equal(passesSession({ status: "failed", decisions: [] }), false);
  assert.equal(
    passesSession({ status: "completed", decisions: [{ passed: true }] }),
    true,
  );
  assert.deepEqual(
    criterionDecisions(
      [{ status: "failed", judgeResult: null, decisions: [] }],
      "missing",
    ),
    [],
  );
  assert.deepEqual(criterionDecisions([{ decisions: [] }], "missing"), [
    { passed: false },
  ]);
});

test("native trace summaries fit one line and hide command output", () => {
  const line = nativeTrace({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "npm\nrun build",
      aggregated_output: "PRIVATE OUTPUT",
    },
  });

  assert.match(line, /npm run build/);
  assert.doesNotMatch(line, /\n|PRIVATE OUTPUT/);
  assert.ok(
    nativeTrace({
      type: "item.started",
      item: { type: "command_execution", command: "x".repeat(200) },
    }).length <= 110,
  );
});
