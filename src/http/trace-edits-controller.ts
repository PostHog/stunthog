import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { PreviewSession } from "../sessions/application/preview-session.js";
import { StartSessions } from "../sessions/application/start-sessions.js";
import { editSchema } from "../sessions/domain/trace-edit.js";

@Controller("api/sessions/:id")
export class TraceEditsController {
  constructor(
    @Inject(PreviewSession) private readonly preview: PreviewSession,
    @Inject(StartSessions) private readonly sessions: StartSessions,
  ) {}

  @Get("starting-point")
  startingPoint(@Param("id") id: string) {
    return this.preview.startingPoint(id);
  }

  @Post("edit-point")
  point(@Param("id") id: string, @Body("entryId") entryId: string) {
    return this.preview.point(id, z.string().min(1).max(1024).parse(entryId));
  }

  @Post("branches")
  async branch(@Param("id") id: string, @Body() body: unknown) {
    if (body && typeof body === "object" && "edit" in body) {
      const { edit, model, requestId } = z
        .object({
          edit: editSchema,
          model: z.string().trim().min(1).max(200),
          requestId: z.string().uuid(),
          confirmLiveTools: z.literal(true),
        })
        .strict()
        .parse(body);
      const prepared = await this.preview.prepareFullSession(id, edit, model);
      return this.sessions.startEdited(id, edit.entryId, requestId, prepared);
    }
    const { entryId, prompt, requestId } = z
      .object({
        entryId: z.string().min(1).max(1024),
        prompt: z
          .string()
          .max(50_000)
          .refine((value) => !!value.trim(), "Enter a prompt."),
        requestId: z.string().uuid(),
        confirmLiveTools: z.literal(true),
      })
      .strict()
      .parse(body);
    await this.preview.requirePromptCheckpoint(id, entryId);
    return this.sessions.branch(id, entryId, prompt, requestId);
  }
  @Post("previews")
  async run(
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { model, edit } = z
      .object({ model: z.string().min(1).max(200), edit: editSchema })
      .strict()
      .parse(body);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    response.once("close", cancel);
    try {
      return await this.preview.run(
        id,
        edit,
        model,
        AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
      );
    } finally {
      response.off("close", cancel);
    }
  }
}
