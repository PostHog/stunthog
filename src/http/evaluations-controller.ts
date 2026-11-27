import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { EvaluationsService } from "../evaluations/application/evaluations-service.js";
import { Database } from "../infrastructure/database.js";
import { ModelRewriter } from "../overrides/application/model-rewriter.js";
import {
  ruleSchema,
  targetSchema,
} from "../overrides/domain/response-override.js";
import { StartSessions } from "../sessions/application/start-sessions.js";
import {
  maxSessionFileBytes,
  maxSessionFilesPerUpload,
} from "../sessions/domain/session-file.js";

type UploadedLog = { originalname: string; buffer: Buffer };

function readLog(file: UploadedLog, memo = "") {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      file.buffer,
    );
    return { filename: file.originalname, content, memo };
  } catch {
    throw new Error("Choose a UTF-8 session file.");
  }
}

function parseField(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Send the evaluation and file memos as JSON.");
  }
}

@Controller("api/evals")
export class EvaluationsController {
  constructor(
    @Inject(ModelRewriter) private readonly rewriter: ModelRewriter,
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
          where: { parentSessionId: null },
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

  @Post("with-session-files")
  @UseInterceptors(
    FilesInterceptor("files", maxSessionFilesPerUpload, {
      limits: {
        fileSize: maxSessionFileBytes,
        files: maxSessionFilesPerUpload,
        fields: 2,
        fieldSize: 3 * 1024 * 1024,
      },
    }),
  )
  createWithFiles(
    @UploadedFiles() files: UploadedLog[],
    @Body("evaluation") evaluation: string,
    @Body("memos") memos: string,
  ) {
    if (!files?.length) throw new Error("Choose a session file.");
    const notes = memos
      ? z.array(z.string()).length(files.length).parse(parseField(memos))
      : [];

    const logs = files.map((file, index) => readLog(file, notes[index]));
    return this.evals.save(parseField(evaluation), undefined, (entity) =>
      this.sessions.loadFiles(entity, logs),
    );
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
    return this.rewriter.forSession()([sample.rule], sample, sample.original);
  }

  @Post(":id/response-overrides")
  addOverride(@Param("id") id: string, @Body() input: unknown) {
    return this.evals.addOverride(id, ruleSchema.parse(input));
  }

  @Post(":id/session-file")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: maxSessionFileBytes,
        files: 1,
        fields: 1,
        fieldSize: 2048,
      },
    }),
  )
  loadSessionFile(
    @Param("id") id: string,
    @UploadedFile() file?: UploadedLog,
    @Body("memo") memo?: string,
  ) {
    if (!file?.buffer) throw new Error("Choose a session file.");
    return this.sessions.loadFiles(id, [readLog(file, memo)]);
  }

  @Post(":id/run")
  run(@Param("id") id: string, @Body() input?: unknown) {
    const selection = z
      .object({
        recordCheckpoints: z.boolean().default(false),
        selection: z
          .object({
            revision: z.number().int().positive(),
            models: z.array(z.number().int().nonnegative()).min(1),
          })
          .optional(),
      })
      .strict()
      .parse(input ?? {});
    return this.sessions.start(
      id,
      selection.selection,
      selection.recordCheckpoints,
    );
  }

  @Post(":id/duplicate")
  duplicate(@Param("id") id: string) {
    return this.evals.duplicate(id);
  }
}
