import { RE2JS } from "re2js";
import { z } from "zod";
import {
  maxFindLength,
  maxPathLength,
  maxReplacementLength,
} from "./sample-edit.js";
import { shellCommands } from "./shell-commands.js";

const webUrl = z
  .string()
  .max(4096)
  .url()
  .regex(/^https?:\/\//i);
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), url: webUrl.optional() }).strict(),
  z
    .object({
      kind: z.literal("shell"),
      match: z.enum(["command", "batch"]),
      command: z.string().trim().max(64_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp"),
      serverId: z.string().uuid(),
      tool: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);
export const ruleSchema = z
  .object({
    id: z.string().uuid(),
    target: targetSchema,
    inputContains: z.string().max(1024).default(""),
    outputContains: z.string().max(2048).default(""),
    path: z
      .string()
      .max(maxPathLength)
      .regex(/^(?:$|\/)/)
      .default(""),
    mode: z.enum(["text", "regex"]).default("text"),
    find: z.string().max(maxFindLength).default(""),
    replacement: z.string().max(maxReplacementLength).default(""),
    decision: z
      .object({ prompt: z.string().trim().min(1).max(4096) })
      .strict()
      .optional(),
    llmEdit: z
      .object({
        prompt: z.string().trim().min(1).max(4096),
        model: z.string().trim().min(1).max(160),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (!rule.decision && rule.target.kind === "shell" && !rule.target.command)
      ctx.addIssue({
        code: "custom",
        message: "Enter a shell command to match.",
      });
    if (!rule.llmEdit && !rule.find)
      ctx.addIssue({ code: "custom", message: "Enter the text to replace." });
    if (rule.target.kind !== "mcp" && rule.path)
      ctx.addIssue({
        code: "custom",
        message: "Use a JSON field only with an MCP response.",
      });
    if (!rule.llmEdit && rule.mode === "regex") {
      try {
        RE2JS.compile(rule.find);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid RE2 regular expression.",
        });
      }
    }
  });
export const rulesSchema = z
  .array(ruleSchema)
  .max(40)
  .refine(
    (rules) => new Set(rules.map((r) => r.id)).size === rules.length,
    "Each override needs a unique ID.",
  );
export type ResponseRule = z.infer<typeof ruleSchema>;
export type Target = z.infer<typeof targetSchema>;
export interface ToolCall {
  target: Target;
  args: Record<string, unknown>;
}
export const decisionEvidenceSchema = z.object({
  ruleId: z.string().uuid(),
  model: z.string().min(1).max(160),
  condition: z.string().max(4096),
  probability: z.number().min(0).max(1),
});
export interface OverrideEvidence {
  decisions?: z.infer<typeof decisionEvidenceSchema>[] | undefined;
  rationale?: string | undefined;
}
export interface RewriteResult extends OverrideEvidence {
  value: unknown;
  ruleId?: string;
  error?: string;
}
export type Rewrite = (
  rules: ResponseRule[],
  call: ToolCall,
  original: unknown,
  signal?: AbortSignal,
) => Promise<RewriteResult>;
export interface ModelOperations {
  decide(
    prompt: string,
    call: ToolCall,
    original: unknown,
  ): Promise<{ model: string; probability: number }>;
  edit(
    settings: NonNullable<ResponseRule["llmEdit"]>,
    original: unknown,
  ): Promise<{ value: unknown; rationale: string }>;
}
export interface ResponseCapture extends ToolCall, OverrideEvidence {
  callId: string;
  route: string;
  original: unknown;
  delivered?: unknown;
  inputOmitted?: boolean | undefined;
  ruleId?: string | undefined;
  error?: string | undefined;
}

const limit = 256_000;

function editText(rule: ResponseRule, expression: RE2JS, text: string) {
  if (text.length > limit)
    throw new Error("The response exceeds the edit limit.");
  const matcher = expression.matcher(text);
  let end = 0;
  let output = "";
  let matches = 0;
  while (matcher.find()) {
    let expanded = 0;
    const replacement =
      rule.mode === "text"
        ? rule.replacement
        : rule.replacement.replace(/\$\$|\$(\d{1,2})/g, (token, group) => {
            const part =
              token === "$$"
                ? "$"
                : Number(group) <= matcher.groupCount()
                  ? (matcher.group(Number(group)) ?? "")
                  : token;
            expanded += part.length;
            if (expanded > limit)
              throw new Error("The replacement exceeds the edit limit.");
            return part;
          });
    output += text.slice(end, matcher.start()) + replacement;
    end = matcher.end();
    if (++matches > 10000 || output.length + text.length - end > limit)
      throw new Error("The replacement exceeds the edit limit.");
  }
  return output + text.slice(end);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function editResult(rule: ResponseRule, original: unknown): unknown {
  const expression = RE2JS.compile(
    rule.mode === "regex" ? rule.find : RE2JS.quote(rule.find),
  );
  let remaining = limit;
  const edit = (text: string) => {
    const value = editText(rule, expression, text);
    remaining -= value.length;
    if (remaining < 0)
      throw new Error("The replacement exceeds the edit limit.");
    return value;
  };
  if (typeof original === "string") return edit(original);
  if (!object(original)) return original;
  const result = structuredClone(original);
  if (rule.path) {
    const keys = rule.path
      .slice(1)
      .split("/")
      .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    const key = keys.pop() ?? "";
    let parent: unknown = result.structuredContent;
    for (const part of keys)
      parent =
        object(parent) && Object.hasOwn(parent, part)
          ? parent[part]
          : undefined;
    if (
      !object(parent) ||
      !Object.hasOwn(parent, key) ||
      typeof parent[key] !== "string"
    )
      return original;
    const edited = edit(parent[key]);
    if (edited === parent[key]) return original;
    parent[key] = edited;
    // MCP servers often include a text copy of their structured result.
    const before = JSON.stringify(original.structuredContent);
    const after = JSON.stringify(result.structuredContent);
    for (const block of Array.isArray(result.content) ? result.content : []) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      let copy: unknown;
      try {
        copy = JSON.parse(block.text);
      } catch {
        continue;
      }
      if (JSON.stringify(copy) !== before) continue;
      remaining -= after.length;
      if (remaining < 0)
        throw new Error("The replacement exceeds the edit limit.");
      block.text = after;
    }
  } else {
    for (const block of Array.isArray(result.content) ? result.content : []) {
      if (block?.type === "text" && typeof block.text === "string")
        block.text = edit(block.text);
    }
  }
  return result;
}

// The first rule that changes the response owns the edit. Preview uses this same path.
export async function rewriteResponse(
  rules: ResponseRule[],
  call: ToolCall,
  original: unknown,
  models?: ModelOperations,
): Promise<RewriteResult> {
  let commands: string[] | undefined;
  const evidence: OverrideEvidence = {};
  let unmodifiedRationale: string | undefined;
  const text =
    typeof original === "string" ? original : JSON.stringify(original);
  for (const rule of rules) {
    const target = rule.target;
    if (target.kind !== call.target.kind) continue;
    if (
      target.kind === "mcp" &&
      call.target.kind === "mcp" &&
      (target.serverId !== call.target.serverId ||
        (target.tool && target.tool !== call.target.tool))
    )
      continue;
    if (
      target.kind === "web" &&
      call.target.kind === "web" &&
      target.url &&
      target.url !== call.target.url
    )
      continue;
    if (!rule.decision) {
      if (target.kind === "shell" && call.target.kind === "shell") {
        const batch = call.target.command;
        if (target.match === "batch") {
          if (target.command !== batch.trim()) continue;
        } else {
          commands ??= shellCommands(batch);
          if (!commands.includes(target.command)) continue;
        }
      }
      if (
        rule.inputContains &&
        !JSON.stringify(call.args).includes(rule.inputContains)
      )
        continue;
      if (rule.outputContains && !text?.includes(rule.outputContains)) continue;
    }
    try {
      if (text === undefined || (!text && !rule.decision && !rule.llmEdit))
        continue;
      if (text.length > limit)
        throw new Error("The response exceeds the edit limit.");
      if ((rule.decision || rule.llmEdit) && !models)
        throw new Error("The override model is unavailable.");
      if (rule.decision && models) {
        const decision = await models.decide(
          rule.decision.prompt,
          call,
          original,
        );
        evidence.decisions ??= [];
        evidence.decisions.push({
          ruleId: rule.id,
          condition: rule.decision.prompt,
          ...decision,
        });
        if (decision.probability <= 0.5) continue;
      }
      const edit =
        rule.llmEdit && models
          ? await models.edit(rule.llmEdit, original)
          : undefined;
      const value = edit ? edit.value : editResult(rule, original);
      const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
      if (serialized.length > limit)
        throw new Error("The replacement exceeds the edit limit.");
      if (serialized !== text)
        return {
          ...evidence,
          value,
          ruleId: rule.id,
          ...(edit && { rationale: edit.rationale }),
        };
      if (edit) unmodifiedRationale = edit.rationale;
    } catch (error) {
      return {
        ...evidence,
        value: original,
        error:
          error instanceof Error ? error.message : "Cannot edit the response.",
      };
    }
  }
  return {
    ...evidence,
    value: original,
    ...(unmodifiedRationale && { rationale: unmodifiedRationale }),
  };
}
