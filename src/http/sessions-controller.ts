import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { Database } from "../infrastructure/database.js";
import { StartSessions } from "../sessions/application/start-sessions.js";

@Controller("api/sessions")
export class SessionsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StartSessions) private readonly sessions: StartSessions,
  ) {}

  @Get()
  async list(@Query("evalId") evalId?: string) {
    const sessions = await this.db.session.findMany({
      where: evalId ? { evalId: z.string().uuid().parse(evalId) } : {},
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { eval: { select: { title: true } }, decisions: true },
    });
    const counts = await this.interceptedCalls(
      sessions.map((session) => session.id),
    );
    return sessions.map((session) => ({
      ...session,
      interceptedCalls: counts.get(session.id) ?? 0,
    }));
  }

  private async interceptedCalls(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const counts = await this.db.$queryRaw<
      { sessionId: string; total: bigint }[]
    >`SELECT sessionId, COUNT(DISTINCT json_extract(event, '$.callId')) AS total
      FROM SessionEvent WHERE phase = 'response' AND json_type(event, '$.ruleId') = 'text'
      AND sessionId IN (${Prisma.join(ids)}) GROUP BY sessionId`;
    return new Map(counts.map((row) => [row.sessionId, Number(row.total)]));
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const session = await this.db.session.findUnique({
      where: { id },
      include: { decisions: true, eval: { select: { title: true } } },
    });

    if (!session) throw new NotFoundException("Session not found.");

    const counts = await this.interceptedCalls([id]);
    return { ...session, interceptedCalls: counts.get(id) ?? 0 };
  }

  @Get(":id/events")
  events(
    @Param("id") sessionId: string,
    @Query("after") after = "0",
    @Query("view") view?: string,
  ) {
    const cursor = z.coerce.number().int().nonnegative().parse(after);
    if (view) {
      const phase = z.enum(["agent", "judge", "intercepts"]).parse(view);
      // The readable transcript uses final messages. The raw event endpoint retains all streaming updates.
      const condition =
        phase === "intercepts"
          ? Prisma.sql`phase='response' AND json_type(event,'$.ruleId')='text'`
          : Prisma.sql`phase IN (${Prisma.join(phase === "agent" ? ["agent", "response"] : ["judge"])}) AND COALESCE(json_extract(event,'$.type'),'') NOT IN ('message_update','message_start','turn_start','turn_end','agent_start','agent_end')`;
      return this.readEventWindow(sessionId, cursor, condition);
    }
    return this.db.sessionEvent.findMany({
      where: {
        sessionId,
        sequence: { gt: cursor },
      },
      orderBy: { sequence: "asc" },
      take: 500,
    });
  }

  private async readEventWindow(
    sessionId: string,
    cursor: number,
    condition: Prisma.Sql,
  ) {
    const rows = await this.db.$queryRaw<
      { id: bigint | number }[]
    >`SELECT id FROM SessionEvent WHERE sessionId=${sessionId} AND sequence>${cursor} AND ${condition} ORDER BY sequence LIMIT 100`;
    return this.db.sessionEvent.findMany({
      where: { sessionId, id: { in: rows.map((row) => Number(row.id)) } },
      orderBy: { sequence: "asc" },
    });
  }
  @Get(":id/files")
  files(@Param("id") sessionId: string) {
    return this.db.sessionArtifact.findMany({
      where: { sessionId },
      orderBy: [{ phase: "asc" }, { path: "asc" }],
      select: { id: true, path: true, phase: true },
    });
  }

  @Get(":id/files/:fileId")
  async file(@Param("id") sessionId: string, @Param("fileId") id: string) {
    const file = await this.db.sessionArtifact.findFirst({
      where: { id, sessionId },
    });

    if (!file) throw new NotFoundException("File not found.");

    return new StreamableFile(Buffer.from(file.content), {
      type: "text/plain; charset=utf-8",
    });
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string) {
    this.sessions.cancel(id);

    return { cancelling: true };
  }
}
