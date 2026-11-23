import type { EvaluationData } from "../../src/evaluations/domain/evaluation.js";
import type { ModelSettingsData } from "../../src/evaluations/domain/model-settings.js";
import type { HarnessResult } from "../../src/harnesses/domain/harness.js";
import type { ExecutionSnapshot } from "../../src/sessions/domain/execution-snapshot.js";

export type { EvaluationData, ModelSettingsData };
export type EvalDraft = Omit<EvaluationData, "id" | "revision" | "judge"> & {
  revision?: number;
  judge: ModelSettingsData | null;
};
export interface Credential {
  provider: string;
  configured: boolean;
  source: string | null;
}
export interface Resource {
  id: string;
  title: string;
  description?: string;
  workspacePath?: string | null;
  repositoryUrl?: string | null;
  executionMode?: "local" | "docker";
  dockerfilePath?: string | null;
  dockerfileContent?: string | null;
  filePath?: string | null;
  content?: string | null;
  command?: string;
  url?: string | null;
  oauthConnected?: boolean;
  arguments?: string[];
}
export interface Resources {
  environments: Resource[];
  personas: Resource[];
  skills: Resource[];
  mcps: Resource[];
}
export interface Harness {
  id: ModelSettingsData["harness"];
  title: string;
  provider: string;
  installed: boolean;
  models: { id: string; name: string }[];
  supportsMcp: boolean;
  judgeSupportsMcp: boolean;
}
export interface Decision {
  criterionSnapshotId: string;
  criterionDescription: string;
  passed: boolean;
  feedback: string;
}
export interface Session {
  interceptedCalls: number;
  id: string;
  evalId: string;
  batchId: string;
  model: string;
  harness: string;
  status: string;
  snapshot: ExecutionSnapshot;
  decisions: Decision[];
  verdict: string | null;
  error: string | null;
  durationMs: number | null;
  costUsd: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  agentResult: HarnessResult | null;
  judgeResult: HarnessResult | null;
  eval: { title: string };
}
export interface EvalRow {
  id: string;
  title: string;
  prompt: string;
  updatedAt: string;
  criteria: { id: string; description: string }[];
  models: ModelSettingsData[];
  sessions: Pick<
    Session,
    "id" | "status" | "model" | "harness" | "createdAt" | "decisions"
  >[];
}
export interface EventRow {
  id: number;
  sequence: number;
  phase: string;
  event: unknown;
  createdAt: string;
}
export interface Artifact {
  id: string;
  path: string;
  phase: string;
}
