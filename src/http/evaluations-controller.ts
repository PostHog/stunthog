import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { EvaluationsService } from "../evaluations/application/evaluations-service.js";
import { Database } from "../infrastructure/database.js";
import {
  rewriteResponse,
  ruleSchema,
  targetSchema,
} from "../overrides/domain/response-override.js";
import { StartSessions } from "../sessions/application/start-sessions.js";

@Controller("api/evals")
export class EvaluationsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(EvaluationsService) private readonly evals: EvaluationsService,
    @Inject(StartSessions) private readonly sessions: StartSessions,
  ) {}

  @Get()
  list() {
    return this.db.eval.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        criteria: { orderBy: { position: "asc" } },
        models: { orderBy: { position: "asc" } },
        sessions: {
          select: {
            id: true,
            status: true,
            model: true,
            harness: true,
            createdAt: true,
            decisions: { select: { passed: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return (await this.evals.get(id)).snapshot();
  }

  @Post()
  create(@Body() input: unknown) {
    return this.evals.save(input);
  }

  @Put(":id")
  update(@Param("id") id: string, @Body() input: unknown) {
    return this.evals.save(input, id);
  }

  @Post("response-overrides/preview")
  previewOverride(@Body() input: unknown) {
    const sample = z
      .object({
        rule: ruleSchema,
        target: targetSchema,
        args: z.record(z.unknown()),
        original: z.union([z.string(), z.record(z.unknown())]),
      })
      .parse(input);
    return rewriteResponse([sample.rule], sample, sample.original);
  }

  @Post(":id/response-overrides")
  addOverride(@Param("id") id: string, @Body() input: unknown) {
    return this.evals.addOverride(id, ruleSchema.parse(input));
  }

  @Post(":id/run")
  run(@Param("id") id: string) {
    return this.sessions.start(id);
  }

  @Post(":id/duplicate")
  duplicate(@Param("id") id: string) {
    return this.evals.duplicate(id);
  }
}
