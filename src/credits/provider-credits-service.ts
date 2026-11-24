import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CredentialStore, type providers } from "../credentials/provider.js";

const openRouterCreditsSchema = z.object({
  data: z.object({
    total_credits: z.number(),
    total_usage: z.number(),
  }),
});

export type ProviderCredit = {
  provider: keyof typeof providers;
  balanceUsd: number | null;
  status: "available" | "not_configured" | "unsupported" | "unavailable";
  detail: string;
};

@Injectable()
export class ProviderCreditsService {
  constructor(
    @Inject(CredentialStore) private readonly keys: CredentialStore,
  ) {}

  async get(): Promise<ProviderCredit[]> {
    return Promise.all([
      this.openRouter(),
      this.unsupported("openai"),
      this.unsupported("anthropic"),
      this.unsupported("typesafe"),
    ]);
  }

  private async openRouter(): Promise<ProviderCredit> {
    const key = await this.keys.read("openrouter");

    if (!key)
      return {
        provider: "openrouter",
        balanceUsd: null,
        status: "not_configured",
        detail: "Add an OpenRouter management key to view credit balance.",
      };

    try {
      const response = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) throw new Error(String(response.status));

      const { data } = openRouterCreditsSchema.parse(await response.json());

      return {
        provider: "openrouter",
        balanceUsd: Math.max(0, data.total_credits - data.total_usage),
        status: "available",
        detail: "OpenRouter credits remaining.",
      };
    } catch {
      return {
        provider: "openrouter",
        balanceUsd: null,
        status: "unavailable",
        detail: "OpenRouter requires a management key for its credit endpoint.",
      };
    }
  }

  private async unsupported(
    provider: "openai" | "anthropic" | "typesafe",
  ): Promise<ProviderCredit> {
    const configured = Boolean(await this.keys.read(provider));

    return {
      provider,
      balanceUsd: null,
      status: configured ? "unsupported" : "not_configured",
      detail:
        provider === "typesafe"
          ? configured
            ? "TypeSafe does not publish a credit balance through its API."
            : "Add a TypeSafe API key to use Jev."
          : configured
            ? "This provider does not expose remaining credit to a standard API key."
            : `Add an ${provider === "openai" ? "OpenAI" : "Anthropic"} API key to run sessions.`,
    };
  }
}
