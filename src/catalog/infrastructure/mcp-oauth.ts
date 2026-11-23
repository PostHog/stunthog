import { createHash, randomUUID } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Inject, Injectable } from "@nestjs/common";
import { KeyVault } from "../../credentials/key-vault.js";
import { McpAuthorization } from "../application/mcp-authorization.js";

interface SavedOAuth {
  redirectUri: string;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
  expiresAt?: number | undefined;
}

@Injectable()
export class McpOAuth extends McpAuthorization {
  private readonly pending = new Map<
    string,
    { url: string; expiresAt: number; provider: OAuthClientProvider }
  >();
  private readonly refreshing = new Map<string, Promise<string | undefined>>();

  constructor(@Inject(KeyVault) private readonly vault: KeyVault) {
    super();
  }

  connected(url: string) {
    return this.vault.hasSecret(this.key(url));
  }

  async connect(url: string, redirectUri: string) {
    const now = Date.now();
    for (const [state, flow] of this.pending)
      if (flow.expiresAt <= now) this.pending.delete(state);

    const state = randomUUID();
    const saved: SavedOAuth = { redirectUri };
    let authorizationUrl: string | undefined;
    const provider = this.provider(url, saved, state, (target) => {
      if (
        target.protocol !== "https:" &&
        (target.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(target.hostname))
      )
        throw new Error("Use an HTTPS authorization server.");
      authorizationUrl = target.href;
    });

    await this.authorize(provider, url);
    if (!authorizationUrl) throw new Error("Cannot start MCP authorization.");
    this.pending.set(state, { url, provider, expiresAt: now + 10 * 60_000 });
    return authorizationUrl;
  }

  async complete(state: string, code?: string) {
    const flow = this.pending.get(state);
    this.pending.delete(state);
    if (!flow || flow.expiresAt <= Date.now() || !code)
      throw new Error("MCP authorization expired or was cancelled. Try again.");

    await this.authorize(flow.provider, flow.url, code);
  }

  async accessToken(url: string) {
    const existing = this.refreshing.get(url);
    if (existing) return existing;

    const refresh = this.readToken(url);
    this.refreshing.set(url, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(url);
    }
  }

  private async readToken(url: string) {
    const record = await this.vault.readSecret(this.key(url));
    if (!record) return undefined;
    const saved: SavedOAuth = JSON.parse(record);
    if (saved.expiresAt === undefined || saved.expiresAt > Date.now() + 30_000)
      return saved.tokens?.access_token;

    const reconnect = () => {
      throw new Error("Reconnect the MCP server on the MCP servers page.");
    };
    if (!saved.tokens?.refresh_token) return reconnect();

    try {
      await this.authorize(this.provider(url, saved, "", reconnect), url);
    } catch {
      return reconnect();
    }
    return saved.tokens.access_token;
  }

  private key(url: string) {
    return `mcp:${createHash("sha256").update(url).digest("hex")}`;
  }

  private async authorize(
    provider: OAuthClientProvider,
    serverUrl: string,
    authorizationCode?: string,
  ) {
    try {
      return await auth(provider, {
        serverUrl,
        ...(authorizationCode === undefined ? {} : { authorizationCode }),
        fetchFn: (input, init) => {
          const target = new URL(input);
          if (
            target.protocol !== "https:" &&
            (target.protocol !== "http:" ||
              !["127.0.0.1", "localhost"].includes(target.hostname))
          )
            throw new Error("Use an HTTPS authorization server.");
          return fetch(target, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
        },
      });
    } catch {
      throw new Error(
        "MCP authorization failed. Check the server URL and try again.",
      );
    }
  }

  private provider(
    url: string,
    saved: SavedOAuth,
    state: string,
    redirectToAuthorization: (target: URL) => void,
  ): OAuthClientProvider {
    let verifier = "";

    // Only a successful exchange or refresh can replace saved credentials.
    return {
      redirectUrl: saved.redirectUri,
      clientMetadata: {
        client_name: "StuntHog",
        redirect_uris: [saved.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => state,
      clientInformation: () => saved.client,
      saveClientInformation: (client) => {
        saved.client = client;
      },
      discoveryState: () => saved.discovery,
      saveDiscoveryState: (discovery) => {
        saved.discovery = discovery;
      },
      tokens: () => saved.tokens,
      saveTokens: async (tokens) => {
        saved.tokens = {
          ...tokens,
          refresh_token: tokens.refresh_token ?? saved.tokens?.refresh_token,
        };
        saved.expiresAt =
          tokens.expires_in === undefined
            ? undefined
            : Date.now() + tokens.expires_in * 1000;
        await this.vault.saveSecret(this.key(url), JSON.stringify(saved));
      },
      redirectToAuthorization,
      codeVerifier: () => verifier,
      saveCodeVerifier: (value) => {
        verifier = value;
      },
    };
  }
}
