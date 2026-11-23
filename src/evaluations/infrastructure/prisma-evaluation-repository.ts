import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { Database } from "../../infrastructure/database.js";
import { Evaluation } from "../domain/evaluation.js";
import { EvaluationRepository } from "../domain/evaluation-repository.js";

@Injectable()
export class PrismaEvaluationRepository extends EvaluationRepository {
  constructor(@Inject(Database) private readonly db: Database) {
    super();
  }

  async find(id: string): Promise<Evaluation | null> {
    const record = await this.db.eval.findUnique({
      where: { id },
      include: {
        criteria: { orderBy: { position: "asc" } },
        models: { orderBy: { position: "asc" } },
        skills: true,
        mcps: true,
        judgeSkills: true,
        judgeMcps: true,
      },
    });

    if (!record) return null;

    return Evaluation.restore({
      id: record.id,
      title: record.title,
      prompt: record.prompt,
      revision: record.revision,
      environmentId: record.environmentId,
      personaId: record.personaId,
      responseOverrides: record.responseOverrides,
      judge: record.judge,
      criteria: record.criteria.map(({ id, description }) => ({
        id,
        description,
      })),
      models: record.models.map(
        ({ model, harness, effort, count, timeoutSeconds, maxTurns }) => ({
          model,
          harness,
          effort,
          count,
          timeoutSeconds,
          maxTurns,
        }),
      ),
      skillIds: record.skills.map((skill) => skill.skillId),
      mcpIds: record.mcps.map((mcp) => mcp.mcpId),
      judgeSkillIds: record.judgeSkills.map((skill) => skill.skillId),
      judgeMcpIds: record.judgeMcps.map((mcp) => mcp.mcpId),
      judgeMcpTools: Object.fromEntries(
        record.judgeMcps.map((mcp) => [mcp.mcpId, mcp.allowedTools]),
      ),
    });
  }

  async save(evaluation: Evaluation): Promise<void> {
    const data = evaluation.snapshot();
    const values = {
      responseOverrides: data.responseOverrides ?? [],
      title: data.title,
      prompt: data.prompt,
      revision: data.revision,
      environmentId: data.environmentId,
      personaId: data.personaId,
      judge: data.judge as unknown as Prisma.InputJsonValue,
      criteria: {
        create: data.criteria.map((criterion, position) => ({
          ...criterion,
          position,
        })),
      },
      models: {
        create: data.models.map((model, position) => ({ ...model, position })),
      },
      skills: { create: data.skillIds.map((skillId) => ({ skillId })) },
      mcps: { create: data.mcpIds.map((mcpId) => ({ mcpId })) },
      judgeSkills: {
        create: data.judgeSkillIds.map((skillId) => ({ skillId })),
      },
      judgeMcps: {
        create: data.judgeMcpIds.map((mcpId) => ({
          mcpId,
          allowedTools: data.judgeMcpTools[mcpId] ?? [],
        })),
      },
    };

    await this.db.$transaction(async (tx) => {
      if (data.revision === 1) {
        await tx.eval.create({ data: { id: data.id, ...values } });

        return;
      }

      await tx.eval.update({
        where: { id: data.id, revision: data.revision - 1 },
        data: { revision: data.revision },
      });
      await tx.criterion.deleteMany({ where: { evalId: data.id } });
      await tx.modelProfile.deleteMany({ where: { evalId: data.id } });
      await tx.evalSkill.deleteMany({ where: { evalId: data.id } });
      await tx.evalMcp.deleteMany({ where: { evalId: data.id } });
      await tx.evalJudgeSkill.deleteMany({ where: { evalId: data.id } });
      await tx.evalJudgeMcp.deleteMany({ where: { evalId: data.id } });
      await tx.eval.update({ where: { id: data.id }, data: values });
    });
  }
}
