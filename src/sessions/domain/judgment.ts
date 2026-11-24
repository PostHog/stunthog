import { z } from "zod";

const judgmentSchema = z
  .object({
    summary: z.string().trim().min(1),
    behaviorDrift: z
      .array(
        z
          .object({
            callId: z.string().min(1),
            outcome: z.enum(["observed", "no_observed_effect", "uncertain"]),
            explanation: z.string().trim().min(1),
            evidenceQuotes: z
              .array(z.string().trim().min(4).max(600))
              .max(6)
              .optional(),
          })
          .strict(),
      )
      .optional(),
    decisions: z.array(
      z
        .object({
          criterionId: z.string().uuid(),
          passed: z.boolean(),
          feedback: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type Judgment = z.infer<typeof judgmentSchema>;
export type DriftFinding = NonNullable<Judgment["behaviorDrift"]>[number];

export function parseJudgment(
  input: unknown,
  criterionIds: string[],
  interceptedIds: string[] = [],
): Judgment {
  const parsed = judgmentSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    throw new Error(
      `Invalid judge response: ${issue?.path.join(".")}: ${issue?.message}`,
    );
  }

  const expected = new Set(criterionIds);
  const received = new Set(
    parsed.data.decisions.map((decision) => decision.criterionId),
  );

  if (
    parsed.data.decisions.length !== expected.size ||
    received.size !== expected.size ||
    [...received].some((id) => !expected.has(id))
  )
    throw new Error(
      "The judge must assess every session criterion exactly once.",
    );

  const outstanding = new Set(interceptedIds);
  for (const finding of parsed.data.behaviorDrift ?? []) {
    if (!outstanding.delete(finding.callId))
      throw new Error(
        "The judge returned an unknown or repeated intercepted call ID.",
      );
  }
  if (outstanding.size)
    throw new Error(
      "The judge must assess every intercepted call exactly once.",
    );
  return parsed.data;
}
