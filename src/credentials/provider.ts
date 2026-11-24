export const providers = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;
export type Provider = keyof typeof providers;

// Application code requests a credential without knowing how it is encrypted or stored.
export abstract class CredentialStore {
  abstract read(provider: Provider): Promise<string | undefined>;
}
