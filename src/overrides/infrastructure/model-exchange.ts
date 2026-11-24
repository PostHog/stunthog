import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  decisionEvidenceSchema,
  type Rewrite,
  rewriteResponse,
  targetSchema,
} from "../domain/response-override.js";

export const relayTimeoutMs = 42_000;
export const requestSchema = z.object({
  target: targetSchema,
  args: z.record(z.unknown()),
  original: z.union([z.string(), z.record(z.unknown())]),
});
const replySchema = z.object({
  value: z.union([z.string(), z.record(z.unknown())]),
  ruleId: z.string().uuid().optional(),
  error: z.string().max(512).optional(),
  rationale: z.string().max(4096).optional(),
  decisions: z.array(decisionEvidenceSchema).max(40).optional(),
});

export async function publish(path: string, content: string) {
  const temporary = join(dirname(path), `${randomUUID()}.partial`);
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

// Native tools share this session directory with the host, including in Docker.
export function relayRewrite(directory: string): Rewrite {
  return async (rules, call, original) => {
    if (
      !rules.some(
        (r) => r.target.kind === call.target.kind && (r.decision || r.llmEdit),
      )
    ) {
      return rewriteResponse(rules, call, original);
    }
    const path = join(directory, randomUUID());
    const reply = `${path}.reply`;
    try {
      const request = JSON.stringify({ ...call, original });
      if (request.length > 384_000)
        return {
          value: original,
          error: "The call exceeds the model input limit.",
        };
      await publish(`${path}.request`, request);
      const deadline = Date.now() + relayTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const data = replySchema.parse(
            JSON.parse(await readFile(reply, "utf8")),
          );
          return {
            value: data.value,
            ...(data.ruleId && { ruleId: data.ruleId }),
            ...(data.error && { error: data.error }),
            decisions: data.decisions,
            rationale: data.rationale,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(75);
      }
    } catch {
      /* Keep the native response when the host cannot evaluate the rule. */
    } finally {
      await Promise.all([
        rm(`${path}.request`, { force: true }),
        rm(reply, { force: true }),
      ]).catch(() => {});
    }
    return {
      value: original,
      error: "The override service did not return a result.",
    };
  };
}
