import { randomUUID } from "node:crypto";
import { z } from "zod";
import { rulesSchema } from "../../overrides/domain/response-override.js";
import { Criterion } from "./criterion.js";
import { ModelSettings, type ModelSettingsData } from "./model-settings.js";

// MCP tool names: 1-128 letters, digits, underscores, hyphens, or dots.
export const mcpToolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);

const schema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1),
    criteria: z
      .array(z.object({ id: z.string().uuid(), description: z.string() }))
      .min(1),
    environmentId: z.string().uuid().nullable(),
    personaId: z.string().uuid().nullable(),
    responseOverrides: rulesSchema.optional(),
    skillIds: z.array(z.string().uuid()),
    mcpIds: z.array(z.string().uuid()),
    // Judge resources are separate from agent resources. Older records have none.
    judgeSkillIds: z.array(z.string().uuid()).default([]),
    judgeMcpIds: z.array(z.string().uuid()).default([]),
    // Tools the judge may call, keyed by judge MCP server ID. A server with no entry exposes no tools.
    judgeMcpTools: z
      .record(z.string().uuid(), z.array(mcpToolName))
      .default({}),
    models: z.array(z.unknown()).min(1),
    judge: z.unknown(),
    revision: z.number().int().positive(),
  })
  .strict();

export interface EvaluationData
  extends Omit<z.infer<typeof schema>, "models" | "judge"> {
  models: ModelSettingsData[];
  judge: ModelSettingsData;
}

// The aggregate keeps criteria and execution settings consistent within one revision.
export class Evaluation {
  private constructor(private data: EvaluationData) {}

  static create(input: Omit<EvaluationData, "id" | "revision">): Evaluation {
    return Evaluation.restore({ ...input, id: randomUUID(), revision: 1 });
  }

  static restore(input: unknown): Evaluation {
    const data = schema.parse(input);
    const criteria = data.criteria.map((criterion) =>
      Criterion.restore(criterion),
    );
    const models = data.models.map(
      (model) => ModelSettings.create(model).value,
    );

    if (
      data.responseOverrides?.some(
        (rule) =>
          rule.target.kind === "mcp" &&
          !data.mcpIds.includes(rule.target.serverId),
      )
    )
      throw new Error("Select the MCP server for each response override.");

    if (
      new Set(criteria.map((criterion) => criterion.id)).size !==
      criteria.length
    )
      throw new Error("Criterion IDs must be unique.");

    if (models.reduce((count, model) => count + model.count, 0) > 100)
      throw new Error(
        "An evaluation cannot start more than 100 sessions at once.",
      );

    return new Evaluation({
      ...data,
      criteria,
      models,
      judge: ModelSettings.create(data.judge).value,
    });
  }

  get id(): string {
    return this.data.id;
  }

  snapshot(): EvaluationData {
    // Callers receive a copy so an edit cannot change a historical session.
    return structuredClone(this.data);
  }

  duplicate(): Evaluation {
    const { id: _id, revision: _revision, ...data } = this.snapshot();

    return Evaluation.create({
      ...data,
      responseOverrides: data.responseOverrides?.map((rule) => ({
        ...rule,
        id: randomUUID(),
      })),
      criteria: data.criteria.map((criterion) =>
        Criterion.create(criterion.description),
      ),
    });
  }

  revise(input: Omit<EvaluationData, "id" | "revision">): void {
    this.data = Evaluation.restore({
      ...input,
      id: this.id,
      revision: this.data.revision + 1,
    }).snapshot();
  }
}
