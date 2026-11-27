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
      where: {
        parentSessionId: null,
        ...(evalId && { evalId: z.string().uuid().parse(evalId) }),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { eval: { select: { title: true } }, decisions: true },
    });
    const counts = await this.interceptedCalls(
      sessions.map((session) => session.id),
    );
    const branchCounts = await this.branchCounts(sessions.map((s) => s.id));
    return sessions.map((session) => ({
      ...session,
      branchCount: branchCounts.get(session.id) ?? 0,
      interceptedCalls: counts.get(session.id) ?? 0,
    }));
  }

  private async branchCounts(ids: string[]) {
    const branches = ids.length
      ? await this.db.session.groupBy({
          by: ["rootSessionId"],
          where: { rootSessionId: { in: ids } },
          _count: true,
        })
      : [];
    return new Map(
      branches.map((group) => [group.rootSessionId, group._count]),
    );
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
    // Search all original sessions before paginating.
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
      FROM Session s JOIN Eval e ON e.id=s.evalId WHERE s.parentSessionId IS NULL ORDER BY s.createdAt DESC,s.id DESC`;
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
      where: { id: { in: page }, parentSessionId: null },
      select: {
        id: true,
        evalId: true,
        model: true,
        harness: true,
        status: true,
        createdAt: true,
        origin: true,
        memo: true,
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
    const rootIds = rows.map((row) => row.id);
    const [counts, branchCounts] = await Promise.all([
      this.interceptedCalls(rootIds),
      this.branchCounts(rootIds),
    ]);
    const order = new Map(page.map((id, index) => [id, index]));
    return rows
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => ({
        ...row,
        interceptedCalls: counts.get(row.id) ?? 0,
        branchCount: branchCounts.get(row.id) ?? 0,
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

  @Get(":id/branches")
  async branches(@Param("id") id: string) {
    const current = await this.db.session.findUniqueOrThrow({
      where: { id },
      select: { rootSessionId: true },
    });
    const root = current.rootSessionId ?? id;
    const rows = await this.db.$queryRaw<
      {
        id: string;
        parentSessionId: string | null;
        branchEntryId: string | null;
        status: string;
        createdAt: Date;
        costUsd: number | null;
        prompt: string;
        change: string | null;
        entryLabel: string;
        passed: bigint;
        assessed: bigint;
      }[]
    >`SELECT s.id, s.parentSessionId, s.branchEntryId, s.status, s.createdAt, s.costUsd,
      substr(coalesce(json_extract(s.snapshot,'$.editedStart.label'),json_extract(s.snapshot,'$.evaluation.prompt')),1,160) AS prompt,
      coalesce(json_extract(s.snapshot,'$.editedStart.label'),'Initial prompt') AS entryLabel,
      CASE WHEN s.parentSessionId IS NOT NULL AND json_type(s.snapshot,'$.editedStart') IS NULL
        THEN substr(json_extract(s.snapshot,'$.evaluation.prompt'),1,160)
        ELSE json_extract(s.snapshot,'$.editedStart.change') END AS change,
      COUNT(CASE WHEN d.passed=1 THEN 1 END) AS passed, COUNT(d.id) AS assessed
      FROM Session s LEFT JOIN SessionDecision d ON d.sessionId=s.id
      WHERE s.id=${root} OR s.rootSessionId=${root}
      GROUP BY s.id ORDER BY s.rowid`;
    return rows.map((row) => ({
      ...row,
      passed: Number(row.passed),
      assessed: Number(row.assessed),
    }));
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
