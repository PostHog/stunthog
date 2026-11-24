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

  @Get("history")
  async history() {
    // Search applies to every session, including rows beyond the first page.
    const rows = await this.db.$queryRaw<
      {
        id: string;
        harness: string;
        model: string;
        status: string;
        title: string;
        environment: string | null;
        review: bigint;
      }[]
    >`
      SELECT s.id,s.harness,s.model,s.status,e.title,json_extract(s.snapshot,'$.environment.title') AS environment,
        CASE WHEN s.status IN ('queued','running','judging') THEN 0 WHEN s.status!='completed' OR
          NOT EXISTS(SELECT 1 FROM SessionDecision d WHERE d.sessionId=s.id) OR
          EXISTS(SELECT 1 FROM SessionDecision d WHERE d.sessionId=s.id AND d.passed=0) THEN 1 ELSE 0 END AS review
      FROM Session s JOIN Eval e ON e.id=s.evalId ORDER BY s.createdAt DESC,s.id DESC`;
    return rows.map((row) => ({ ...row, review: Boolean(row.review) }));
  }

  @Get("history/page")
  async historyPage(@Query("ids") ids: string) {
    const page = z
      .array(z.string().uuid())
      .min(1)
      .max(25)
      .parse(ids?.split(","));
    const rows = await this.db.session.findMany({
      where: { id: { in: page } },
      select: {
        id: true,
        evalId: true,
        model: true,
        harness: true,
        status: true,
        createdAt: true,
        durationMs: true,
        costUsd: true,
        verdict: true,
        error: true,
        eval: { select: { title: true } },
        decisions: { select: { passed: true, criterionSnapshotId: true } },
      },
    });
    const criteria = await this.db.$queryRaw<
      { id: string; criteria: string }[]
    >`SELECT id,CAST(json_extract(snapshot,'$.evaluation.criteria') AS TEXT) AS criteria FROM Session WHERE id IN (${Prisma.join(page)})`;
    const byId = new Map(
      criteria.map((row) => [row.id, JSON.parse(row.criteria ?? "[]")]),
    );
    const counts = await this.interceptedCalls(page);
    const order = new Map(page.map((id, index) => [id, index]));
    return rows
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => ({
        ...row,
        interceptedCalls: counts.get(row.id) ?? 0,
        criteria: byId.get(row.id),
      }));
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
  events(@Param("id") sessionId: string, @Query("after") after = "0") {
    return this.db.sessionEvent.findMany({
      where: {
        sessionId,
        sequence: { gt: z.coerce.number().int().nonnegative().parse(after) },
      },
      orderBy: { sequence: "asc" },
      take: 500,
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
