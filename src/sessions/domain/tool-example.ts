import type { Target } from "../../overrides/domain/response-override.js";

interface CallContext {
  id: number;
  name: string;
  tool: string;
  harness: string;
  model: string;
  phase: string;
  status: string;
  evaluation: string;
  sessionId: string;
  createdAt: string;
}

export interface ToolExampleSummary extends CallContext {
  inputPreview: string;
  outputPreview: string;
  hasOutput: number;
}
export interface ToolExample extends CallContext {
  task: string;
  input: Record<string, unknown>;
  output: unknown;
  sample: unknown;
  target?: Target;
}
