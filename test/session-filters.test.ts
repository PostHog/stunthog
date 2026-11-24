import assert from "node:assert/strict";
import { test } from "node:test";
import { Criterion } from "../src/evaluations/domain/criterion.js";
import { Evaluation } from "../src/evaluations/domain/evaluation.js";
import { ModelSettings } from "../src/evaluations/domain/model-settings.js";
import {
  filterSessions,
  isActive,
  needsReview,
} from "../web/src/sessions/session-filters.js";
import type { Session } from "../web/src/types.js";

function session(status: string): Session {
  const model = ModelSettings.create({ model: "openai/test" }).value;
  const evaluation = Evaluation.create({
    title: "Install analytics",
    prompt: "Add PostHog.",
    environmentId: null,
    personaId: null,
    skillIds: [],
    mcpIds: [],
    judgeSkillIds: [],
    judgeMcpIds: [],
    judgeMcpTools: {},
    criteria: [Criterion.create("The build passes.")],
    models: [model],
    judge: model,
  }).snapshot();

  return {
    id: status,
    interceptedCalls: 0,
    evalId: evaluation.id,
    batchId: "run",
    model: model.model,
    harness: model.harness,
    status,
    snapshot: {
      evaluation,
      environment: {
        title: "Storefront",
        workspacePath: null,
        repositoryUrl: null,
        executionMode: "local",
        dockerfilePath: null,
        dockerfileContent: null,
      },
      persona: null,
      skills: [],
      mcps: [],
    },
    decisions: [],
    verdict: null,
    error: null,
    durationMs: null,
    costUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cacheRead: null,
    cacheWrite: null,
    createdAt: "2026-11-12T12:00:00Z",
    startedAt: null,
    finishedAt: null,
    agentResult: null,
    judgeResult: null,
    eval: { title: evaluation.title },
  };
}

test("review separates unfinished sessions from errors and failed checks", () => {
  for (const status of ["queued", "running", "judging"]) {
    assert.equal(isActive({ status }), true);
    assert.equal(needsReview({ status, decisions: [] }), false);
  }

  for (const status of ["failed", "cancelled", "completed"]) {
    assert.equal(needsReview({ status, decisions: [] }), true);
  }

  const completed = session("completed");

  completed.decisions = [
    {
      criterionSnapshotId: "build",
      criterionDescription: "The build passes.",
      passed: true,
      feedback: "Build exited successfully.",
    },
  ];

  assert.equal(needsReview(completed), false);
  assert.equal(
    needsReview({
      ...completed,
      decisions: completed.decisions.map((decision) => ({
        ...decision,
        passed: false,
      })),
    }),
    true,
  );
});

test("session search combines model, status, and case-insensitive environment filters", () => {
  const sessions = [
    session("running"),
    session("failed"),
    session("cancelled"),
  ];
  const first = sessions[0];

  assert.ok(first);

  const model = `${first.harness}/${first.model}`;

  assert.deepEqual(filterSessions(sessions, " STOREFRONT ", model, "active"), [
    first,
  ]);
  assert.deepEqual(
    filterSessions(sessions, "analytics", "", "review").map(
      (item) => item.status,
    ),
    ["failed", "cancelled"],
  );
  assert.equal(filterSessions(sessions, "", "other/model", "").length, 0);
  assert.equal(filterSessions(sessions, "", "", "cancelled").length, 1);
  assert.equal(filterSessions(sessions, "missing", "", "").length, 0);
});

test("search includes model catalog labels", () => {
  const row = session("completed");
  assert.deepEqual(
    filterSessions([row], "qwen3.8 flash", "", "", () => "Qwen: Qwen3.8 Flash"),
    [row],
  );
});
