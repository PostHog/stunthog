export abstract class DecisionModel {
  abstract decide(
    condition: string,
    state: unknown,
    signal: AbortSignal,
  ): Promise<{ model: string; probability: number }>;
}
