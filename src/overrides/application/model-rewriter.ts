import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod/v4";
import { type Rewrite, rewriteResponse } from "../domain/response-override.js";
import { DecisionModel } from "./model-ports.js";

const content = z.object({
  content: z.array(z.looseObject({ type: z.string() })).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

// Only text and structured MCP content enter the decision request.
function decisionResponse(original: unknown) {
  if (typeof original === "string") return original;
  const parsed = content.safeParse(original);
  if (
    !parsed.success ||
    (!parsed.data.content && !parsed.data.structuredContent)
  )
    throw new Error("The MCP server returned an unsupported response.");
  const blocks = parsed.data.content ?? [];
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
  const structured = parsed.data.structuredContent;
  return { texts, ...(structured && { structuredContent: structured }) };
}

@Injectable()
export class ModelRewriter {
  constructor(
    @Inject(DecisionModel) private readonly decision: DecisionModel,
  ) {}

  forSession(secrets: string[] = [], sessionSignal?: AbortSignal): Rewrite {
    const checkInput = (value: unknown) => {
      const text = JSON.stringify(value);
      if (text.length > 384_000)
        throw new Error("The call exceeds the model input limit.");
      if (secrets.some((key) => key && text.includes(key)))
        throw new Error(
          "The call contains a session credential. The tool kept the original response.",
        );
    };
    return (rules, call, original, callSignal) => {
      const timeout = AbortSignal.timeout(35_000);
      const signal = AbortSignal.any([
        timeout,
        ...(sessionSignal ? [sessionSignal] : []),
        ...(callSignal ? [callSignal] : []),
      ]);
      return rewriteResponse(rules, call, original, {
        decide: (condition, tool, response) => {
          const state = {
            target: tool.target,
            input: tool.args,
            response: decisionResponse(response),
          };
          checkInput([condition, state]);
          return this.decision.decide(condition, state, signal);
        },
      });
    };
  }
}
