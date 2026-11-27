import { isDeepStrictEqual } from "node:util";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { z } from "zod";
import { AnalyticsService } from "../../analytics/analytics-service.js";
import {
  type ResponseRule,
  rulesSchema,
} from "../../overrides/domain/response-override.js";
import { Criterion } from "../domain/criterion.js";
import { Evaluation, mcpToolName } from "../domain/evaluation.js";
import { EvaluationRepository } from "../domain/evaluation-repository.js";
import { ModelSettings } from "../domain/model-settings.js";

const inputSchema = z
  .object({
    title: z.string(),
    prompt: z.string(),
    revision: z.number().int().positive().optional(),
    criteria: z.array(
      z.object({ id: z.string().uuid().optional(), description: z.string() }),
    ),
    environmentId: z.string().uuid().nullable().default(null),
    personaId: z.string().uuid().nullable().default(null),
    responseOverrides: rulesSchema.optional(),
    skillIds: z.array(z.string().uuid()).default([]),
    mcpIds: z.array(z.string().uuid()).default([]),
    judgeSkillIds: z.array(z.string().uuid()).default([]),
    judgeMcpIds: z.array(z.string().uuid()).default([]),
    judgeMcpTools: z
      .record(z.string().uuid(), z.array(z.string().trim().pipe(mcpToolName)))
      .default({}),
    models: z.array(z.unknown()),
    judge: z.unknown(),
  })
  .strict();

@Injectable()
export class EvaluationsService {
  constructor(
    @Inject(EvaluationRepository)
    private readonly repository: EvaluationRepository,
    @Optional()
    @Inject(AnalyticsService)
    private readonly analytics?: AnalyticsService,
  ) {}

  async get(id: string) {
    const entity = await this.repository.find(id);

    if (!entity) throw new NotFoundException("Evaluation not found.");

    return entity;
  }

  async save(
    input: unknown,
    id?: string,
    persist: (entity: Evaluation) => Promise<unknown> = (entity) =>
      this.repository.save(entity),
  ) {
    const value = inputSchema.parse(input);
    const judgeMcpIds = [...new Set(value.judgeMcpIds)];
    // Judge MCP tools are auto-approved, so the author must name each one the judge may call.
    const judgeMcpTools = Object.fromEntries(
      judgeMcpIds.map((mcpId) => [
        mcpId,
        [...new Set(value.judgeMcpTools[mcpId] ?? [])],
      ]),
    );

    if (Object.values(judgeMcpTools).some((tools) => !tools.length))
      throw new BadRequestException(
        "Name at least one tool the judge may call from each judge MCP server.",
      );

    const data = {
      responseOverrides: value.responseOverrides,
      title: value.title,
      prompt: value.prompt,
      environmentId: value.environmentId,
      personaId: value.personaId,
      skillIds: [...new Set(value.skillIds)],
      mcpIds: [...new Set(value.mcpIds)],
      judgeSkillIds: [...new Set(value.judgeSkillIds)],
      judgeMcpIds,
      judgeMcpTools,
      criteria: value.criteria.map((criterion) =>
        criterion.id
          ? Criterion.restore(criterion)
          : Criterion.create(criterion.description),
      ),
      models: value.models.map((model) => ({
        ...ModelSettings.create(model).value,
      })),
      judge: { ...ModelSettings.create(value.judge).value },
    };
    const entity = id ? await this.get(id) : Evaluation.create(data);

    if (id) {
      if (value.revision !== entity.snapshot().revision)
        throw new ConflictException(
          "This evaluation changed. Reload it before saving.",
        );

      data.responseOverrides ??= entity.snapshot().responseOverrides;
      entity.revise(data);
    }

    await persist(entity);
    this.analytics?.capture(id ? "evaluation updated" : "evaluation created", {
      evaluation_id: entity.snapshot().id,
      criteria_count: data.criteria.length,
      model_count: data.models.length,
      judge_skill_count: data.judgeSkillIds.length,
      judge_mcp_count: data.judgeMcpIds.length,
    });

    return entity.snapshot();
  }

  async addOverride(id: string, rule: ResponseRule) {
    const evaluation = await this.get(id);
    const data = evaluation.snapshot();
    if (data.responseOverrides?.some((saved) => isDeepStrictEqual(saved, rule)))
      return data;
    const { id: _id, revision: _revision, ...fields } = data;
    evaluation.revise({
      ...fields,
      responseOverrides: [...(data.responseOverrides ?? []), rule],
    });
    await this.repository.save(evaluation);
    this.analytics?.capture("response override added", {
      evaluation_id: id,
      source: rule.target.kind,
    });
    return evaluation.snapshot();
  }

  async duplicate(id: string) {
    const copy = (await this.get(id)).duplicate();

    await this.repository.save(copy);
    this.analytics?.capture("evaluation duplicated", {
      source_evaluation_id: id,
      evaluation_id: copy.snapshot().id,
    });

    return copy.snapshot();
  }
}
