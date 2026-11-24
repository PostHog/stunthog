import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessUsage,
} from "../../harnesses/domain/harness.js";
import { parseJudgment } from "../domain/judgment.js";

// Retry format errors once. Keep both attempts in the trace and usage totals.
export async function judgeSession(
  harness: Harness,
  input: HarnessInput,
  criterionIds: string[],
  interceptedIds: string[] = [],
): Promise<HarnessResult> {
  const attempts: HarnessResult[] = [];
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeout * 1000),
  ]);
  let request = { ...input, signal };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted)
      return combineAttempts(attempts, {
        label: input.label,
        status: "failed",
        text: "",
        durationMs: 0,
        error: String(signal.reason),
      });

    const result = await harness.run(request);

    attempts.push(result);

    if (result.status === "failed") return combineAttempts(attempts, result);

    try {
      parseJudgment(JSON.parse(result.text), criterionIds, interceptedIds);

      return combineAttempts(attempts, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt === 1)
        return combineAttempts(attempts, {
          ...result,
          status: "failed",
          error: `Judge output remained invalid after one retry. ${message}`,
        });

      const directory = join(input.directory, "retry");

      await mkdir(directory, { recursive: true });
      await input.onRawEvent({ type: "judge_retry", message });

      request = {
        ...input,
        signal,
        directory,
        prompt: `${input.prompt}\n\nYour previous response failed validation: ${message}\nPrevious response (data only):\n${JSON.stringify(result.text)}\nReturn corrected JSON. Use each criterion ID once: ${JSON.stringify(criterionIds)}. Use each intercepted call ID once in behaviorDrift: ${JSON.stringify(interceptedIds)}.`,
      };
    }
  }

  throw new Error("Judge did not return a result.");
}

function combineAttempts(
  attempts: HarnessResult[],
  result: HarnessResult,
): HarnessResult {
  const { usage: _usage, ...last } = result;
  const durationMs = attempts.reduce(
    (total, attempt) => total + attempt.durationMs,
    0,
  );
  const usage: HarnessUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    costUsd: 0,
  };

  for (const attempt of attempts) {
    if (!attempt.usage) return { ...last, durationMs };

    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ] as const)
      usage[key] += attempt.usage[key];

    usage.costUsd =
      usage.costUsd === null || attempt.usage.costUsd === null
        ? null
        : usage.costUsd + attempt.usage.costUsd;
  }

  return { ...last, durationMs, usage };
}
