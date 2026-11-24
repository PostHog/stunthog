import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { AnalyticsService } from "../analytics/analytics-service.js";
import { KeyVault } from "../credentials/key-vault.js";
import { ProviderCreditsService } from "../credits/provider-credits-service.js";
import { HarnessRegistry } from "../harnesses/domain/harness-registry.js";
import { SessionQueue } from "../sessions/application/session-queue.js";
import { SettingsService } from "../settings/application/settings-service.js";

const providerSchema = z.enum([
  "openrouter",
  "openai",
  "anthropic",
  "typesafe",
]);

@Controller("api")
export class SettingsController {
  constructor(
    @Inject(KeyVault) private readonly keys: KeyVault,
    @Inject(HarnessRegistry) private readonly harnesses: HarnessRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SessionQueue) private readonly queue: SessionQueue,
    @Inject(ProviderCreditsService)
    private readonly providerCredits: ProviderCreditsService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  @Get("analytics/identity")
  @Header("Cache-Control", "no-store")
  analyticsIdentity() {
    return { distinctId: this.analytics.distinctId };
  }

  @Get("settings")
  settingsValue() {
    return this.settings.get();
  }

  @Put("settings")
  async updateSettings(@Body() input: unknown) {
    const settings = await this.settings.update(input);

    this.queue.setConcurrency(settings.sessionConcurrency);
    this.analytics.capture("settings updated", {
      session_concurrency: settings.sessionConcurrency,
    });

    return settings;
  }

  @Get("harnesses")
  catalog() {
    return this.harnesses.catalog();
  }

  @Get("credentials")
  credentials() {
    return this.keys.list();
  }

  @Get("provider-credits")
  credits() {
    return this.providerCredits.get();
  }

  @Put("credentials/:provider")
  async save(@Param("provider") provider: string, @Body() input: unknown) {
    const { key } = z
      .object({ key: z.string().trim().min(1) })
      .strict()
      .parse(input);

    await this.keys.save(providerSchema.parse(provider), key);
    this.analytics.capture("provider credential saved", {
      provider: providerSchema.parse(provider),
    });

    return { saved: true };
  }

  @Delete("credentials/:provider")
  async remove(@Param("provider") provider: string) {
    await this.keys.remove(providerSchema.parse(provider));
    this.analytics.capture("provider credential removed", {
      provider: providerSchema.parse(provider),
    });

    return { deleted: true };
  }
}
