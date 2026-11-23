import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { Database } from "../infrastructure/database.js";
import type { Target } from "../overrides/domain/response-override.js";
import { shellCallTarget } from "../overrides/domain/shell-commands.js";
import type { ExecutionSnapshot } from "../sessions/domain/execution-snapshot.js";
import { asObject, toolResponseId } from "../sessions/domain/tool-call.js";
import type {
  ToolExample,
  ToolExampleSummary,
} from "../sessions/domain/tool-example.js";

const filters = z
  .object({
    query: z.string().max(500).default(""),
    harness: z.enum(["pi", "claude", "opencode", "codex"]).optional(),
    kind: z.enum(["web", "mcp", "shell"]).optional(),
    phase: z.enum(["agent", "judge"]).optional(),
    status: z.enum(["running", "completed", "failed"]).optional(),
    name: z.string().max(256).optional(),
    evalId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    before: z.number().int().positive().optional(),
  })
  .strict();
const harness = Prisma.sql`CASE WHEN t.phase='judge' THEN COALESCE(json_extract(s.snapshot,'$.evaluation.judge.harness'),s.harness) ELSE s.harness END`;
const managedWeb = Prisma.sql`(t.tool='web_fetch' AND t.serverIndex=json_array_length(s.snapshot,
  CASE WHEN t.phase='judge' THEN '$.judgeMcps' ELSE '$.mcps' END))`;
const columns = Prisma.sql`
  t.id,t.name,t.tool,t.phase,t.status,t.sessionId,t.createdAt,${harness} AS harness,
  CASE WHEN t.phase='judge' THEN COALESCE(json_extract(s.snapshot,'$.evaluation.judge.model'),'') ELSE s.model END AS model,
  COALESCE(json_extract(s.snapshot,'$.evaluation.title'),e.title) AS evaluation,
  substr(COALESCE(json_extract(t.input,'$.command'),json_extract(t.input,'$.url'),
    json_extract(t.input,'$.query'),json_extract(t.input,'$.pattern'),json_extract(t.input,'$.path'),
    json_extract(t.input,'$.file_path'),json_extract(t.input,'$.filePath'),json_extract(t.input,'$'),''),1,240) AS inputPreview,
  substr(COALESCE(json_extract(t.output,'$.content[0].text'),json_extract(t.output,'$[0].text'),
    json_extract(t.output,'$.text'),json_extract(t.output,'$'),''),1,240) AS outputPreview,
  CAST(t.output IS NOT NULL AS INT) AS hasOutput`;
@Controller("api/tool-calls")
export class ToolCallsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post("search")
  async search(@Body() body: unknown) {
    const filter = filters.parse(body);
    const conditions: Prisma.Sql[] = [];
    const terms = filter.query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 15);
    if (terms?.length)
      conditions.push(
        Prisma.sql`t.id IN (SELECT rowid FROM ToolCallSearch WHERE ToolCallSearch MATCH ${terms.map((t) => `"${t}"*`).join(" AND ")})`,
      );
    else if (filter.query.trim())
      conditions.push(
        Prisma.sql`(instr(t.name,${filter.query}) OR instr(CAST(t.input AS TEXT),${filter.query}) OR instr(CAST(t.output AS TEXT),${filter.query}))`,
      );
    if (filter.harness)
      conditions.push(Prisma.sql`${harness}=${filter.harness}`);
    if (filter.kind === "web")
      conditions.push(Prisma.sql`(t.source='web' OR ${managedWeb})`);
    if (filter.kind === "mcp")
      conditions.push(
        Prisma.sql`t.source='mcp' AND NOT COALESCE(${managedWeb},0)`,
      );
    if (filter.kind === "shell")
      conditions.push(
        Prisma.sql`t.source='native' AND lower(t.name) IN ('bash','shell','exec_command','command_execution')`,
      );
    if (filter.name) conditions.push(Prisma.sql`t.name=${filter.name}`);
    if (filter.phase) conditions.push(Prisma.sql`t.phase=${filter.phase}`);
    if (filter.status) conditions.push(Prisma.sql`t.status=${filter.status}`);
    if (filter.sessionId)
      conditions.push(Prisma.sql`t.sessionId=${filter.sessionId}`);
    if (filter.evalId) conditions.push(Prisma.sql`s.evalId=${filter.evalId}`);
    if (filter.before) conditions.push(Prisma.sql`t.id < ${filter.before}`);
    const rows = await this.db.$queryRaw<
      (Omit<ToolExampleSummary, "createdAt"> & { createdAt: Date })[]
    >`SELECT ${columns} FROM ToolCall t JOIN Session s ON s.id=t.sessionId JOIN Eval e ON e.id=s.evalId ${conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty} ORDER BY t.id DESC LIMIT 9`;
    return {
      calls: rows.slice(0, 8).map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        hasOutput: Number(row.hasOutput),
      })),
      next: rows.length > 8 ? rows[7]?.id : null,
    };
  }

  @Get("mcp/:serverId/tools")
  async mcpTools(@Param("serverId") raw: string) {
    const id = z.string().uuid().parse(raw);
    const rows = await this.db.$queryRaw<
      { tool: string }[]
    >`SELECT DISTINCT t.tool FROM ToolCall t JOIN Session s ON s.id=t.sessionId
      WHERE t.serverIndex IS NOT NULL AND json_extract(s.snapshot,
       (CASE WHEN t.phase='judge' THEN '$.evaluation.judgeMcpIds[' ELSE '$.evaluation.mcpIds[' END) || t.serverIndex || ']')=${id}
      ORDER BY t.tool LIMIT 200`;
    return rows.map((row) => row.tool);
  }

  @Get(":id")
  async example(@Param("id") raw: string): Promise<ToolExample> {
    const id = z.coerce.number().int().positive().parse(raw);
    const row = await this.db.toolCall.findUnique({
      where: { id },
      include: {
        session: {
          select: {
            snapshot: true,
            harness: true,
            model: true,
            eval: { select: { title: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException("Tool call not found.");
    const snapshot = row.session.snapshot as unknown as ExecutionSnapshot;
    let rawInput: unknown = row.input;
    if (typeof rawInput === "string") {
      try {
        rawInput = JSON.parse(rawInput);
      } catch {
        /* Some harnesses report plain text input. */
      }
    }
    const input =
      rawInput == null ||
      (typeof rawInput === "object" && !Array.isArray(rawInput))
        ? asObject(rawInput)
        : { input: rawInput };
    const { source, serverIndex: index, tool } = row;
    const servers =
      row.phase === "judge" ? (snapshot.judgeMcps ?? []) : snapshot.mcps;
    const serverId =
      index === null
        ? undefined
        : (row.phase === "judge"
            ? (snapshot.evaluation.judgeMcpIds ?? [])
            : snapshot.evaluation.mcpIds)[index];
    let target: Target | undefined;
    if (
      (source === "web" ||
        (tool === "web_fetch" && index === servers.length)) &&
      typeof input.url === "string" &&
      /^https?:\/\//i.test(input.url)
    )
      target = { kind: "web", url: input.url };
    else if (serverId) target = { kind: "mcp", serverId, tool };
    else if (source === "native" && row.status === "completed")
      target = shellCallTarget(row.name, input);
    const output = row.output;
    const content = asObject(output).content ?? output;
    const text = Array.isArray(content)
      ? content
          .map((block) => asObject(block).text)
          .filter((v) => typeof v === "string")
          .join("\n")
      : typeof content === "string"
        ? content
        : undefined;
    let sample: unknown = output;
    if (target?.kind === "web" && text !== undefined)
      sample = text.replace(/^URL: [^\n]+\n\n/, "");
    else if (target?.kind === "mcp") {
      if (row.name.startsWith("mcp_") && text) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed?.content)) sample = parsed;
        } catch {
          /* Plain text MCP output. */
        }
      }
      if (!Array.isArray(asObject(sample).content))
        sample = {
          content: Array.isArray(content)
            ? content
            : [{ type: "text", text: text ?? JSON.stringify(output) }],
        };
    } else if (text !== undefined) sample = text;

    const auditId = toolResponseId(output) ?? row.callId;
    if (row.phase === "agent" && target && typeof auditId === "string") {
      const [audit] = await this.db.$queryRaw<
        { body: string }[]
      >`SELECT CAST(event AS TEXT) AS body FROM SessionEvent WHERE sessionId=${row.sessionId} AND phase='response' AND json_extract(event,'$.callId')=${auditId} LIMIT 1`;
      if (audit) sample = JSON.parse(audit.body).original;
    }
    return {
      id,
      name: row.name,
      task: snapshot.evaluation.prompt ?? "",
      tool,
      model:
        row.phase === "judge"
          ? (snapshot.evaluation.judge.model ?? "")
          : row.session.model,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
      phase: row.phase,
      harness:
        row.phase === "judge"
          ? snapshot.evaluation.judge.harness
          : row.session.harness,
      sessionId: row.sessionId,
      evaluation: snapshot.evaluation.title ?? row.session.eval.title,
      input,
      output,
      sample,
      ...(target && { target }),
    };
  }
}
