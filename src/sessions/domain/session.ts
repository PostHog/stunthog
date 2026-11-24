import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvaluationData } from "../../evaluations/domain/evaluation.js";
import type { ModelSettingsData } from "../../evaluations/domain/model-settings.js";
import { type Judgment, parseJudgment } from "./judgment.js";

export type { Judgment } from "./judgment.js";

export type SessionStatus =
  | "queued"
  | "running"
  | "judging"
  | "completed"
  | "failed"
  | "cancelled";

// Only these methods can change state. Completion requires a decision for every saved criterion.
export class Session {
  readonly id = randomUUID();
  private currentStatus: SessionStatus = "queued";
  private assessment: Judgment | null = null;
  private failure: string | null = null;
  private readonly configuration: EvaluationData;
  readonly model: Readonly<ModelSettingsData>;

  constructor(evaluation: EvaluationData, model: Readonly<ModelSettingsData>) {
    this.configuration = structuredClone(evaluation);
    this.model = Object.freeze(structuredClone(model));
  }

  get status(): SessionStatus {
    return this.currentStatus;
  }

  start(): void {
    this.transition("queued", "running");
  }

  beginJudging(executionError: string | null = null): void {
    const failure =
      executionError === null
        ? null
        : z.string().trim().min(1).parse(executionError);

    this.transition("running", "judging");
    this.failure = failure;
  }

  complete(input: unknown, interceptedIds: string[] = []): void {
    const judgment = parseJudgment(
      input,
      this.configuration.criteria.map((criterion) => criterion.id),
      interceptedIds,
    );

    // Judge completion must not hide a failed agent execution.
    this.transition("judging", this.failure ? "failed" : "completed");
    this.assessment = structuredClone(judgment);
  }

  fail(reason: string): void {
    this.ensureActive();
    this.failure = z.string().trim().min(1).parse(reason);
    this.currentStatus = "failed";
  }

  cancel(): void {
    this.ensureActive();
    this.currentStatus = "cancelled";
  }

  snapshot() {
    return structuredClone({
      id: this.id,
      evaluation: this.configuration,
      model: this.model,
      status: this.status,
      judgment: this.assessment,
      error: this.failure,
    });
  }

  private transition(expected: SessionStatus, next: SessionStatus): void {
    if (this.currentStatus !== expected)
      throw new Error(
        `Cannot change a ${this.currentStatus} session to ${next}.`,
      );

    this.currentStatus = next;
  }

  private ensureActive(): void {
    if (["completed", "failed", "cancelled"].includes(this.currentStatus))
      throw new Error("The session has already finished.");
  }
}
