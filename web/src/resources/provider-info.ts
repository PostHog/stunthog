import { providers } from "../../../src/credentials/provider.js";

export const providerInfo: Record<
  string,
  { name: string; harnesses: string; variable: string }
> = {
  typesafe: {
    name: "TypeSafe",
    harnesses: "Jev decision model",
    variable: providers.typesafe,
  },
  openrouter: {
    name: "OpenRouter",
    harnesses: "Pi, OpenCode, and LLM editing",
    variable: providers.openrouter,
  },
  openai: { name: "OpenAI", harnesses: "Codex", variable: providers.openai },
  anthropic: {
    name: "Anthropic",
    harnesses: "Claude Code",
    variable: providers.anthropic,
  },
};
