import type { ZodType } from "zod/v4";

export abstract class DecisionModel {
  abstract decide(
    condition: string,
    state: unknown,
    signal: AbortSignal,
  ): Promise<{ model: string; probability: number }>;
}

// The schema is both the provider's output contract and the runtime validator.
export abstract class SingleCallLlm {
  abstract text(
    model: string,
    instructions: string,
    input: unknown,
    signal: AbortSignal,
    schema?: ZodType,
  ): Promise<string>;

  async generate<T>(
    model: string,
    instructions: string,
    input: unknown,
    schema: ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const text = await this.text(model, instructions, input, signal, schema);
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new Error("The language model returned an invalid result.");
    }
  }
}
