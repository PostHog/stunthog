import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod/v4";
import {
  CredentialStore,
  type Provider,
  providers,
} from "../../credentials/provider.js";
import { DecisionModel } from "../application/model-ports.js";

async function post(
  keys: CredentialStore,
  provider: Provider,
  name: string,
  url: string,
  body: unknown,
  signal: AbortSignal,
) {
  const key = await keys.read(provider);
  if (!key) throw new Error(`Add a ${name} key in API keys.`);
  const payload = JSON.stringify(body);
  if (
    [key, ...Object.values(providers).map((name) => process.env[name])].some(
      (secret) => secret && payload.includes(secret),
    )
  )
    throw new Error(
      "The sample contains a provider key. The tool kept the original response.",
    );
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } catch (error) {
    const status =
      error instanceof Error && /^HTTP \d{3}$/.test(error.message)
        ? ` (${error.message})`
        : "";
    throw new Error(
      `The ${name} request failed${status}. The tool kept the original response.`,
    );
  }
}

@Injectable()
export class JevDecisionModel extends DecisionModel {
  constructor(@Inject(CredentialStore) private readonly keys: CredentialStore) {
    super();
  }
  async decide(condition: string, state: unknown, signal: AbortSignal) {
    const data = await post(
      this.keys,
      "typesafe",
      "TypeSafe",
      "https://api.typesafe.ai/v1/systemone",
      {
        model: "jev-latest",
        state,
        questions: { intercept: { type: "noul", instructions: condition } },
      },
      signal,
    );
    const parsed = z
      .object({
        model: z.string().min(1).max(160),
        answers: z.object({
          intercept: z.object({
            type: z.literal("noul"),
            noul: z.number().min(0).max(1),
          }),
        }),
      })
      .safeParse(data);
    if (!parsed.success) throw new Error("Jev returned an invalid decision.");
    return {
      model: parsed.data.model,
      probability: parsed.data.answers.intercept.noul,
    };
  }
}
