import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AnalyticsService } from "./analytics/analytics-service.js";
import { loadInstallationId } from "./analytics/installation-identity.js";
import { McpAuthorization } from "./catalog/application/mcp-authorization.js";
import { ResourceRepository } from "./catalog/domain/resource-repository.js";
import { McpOAuth } from "./catalog/infrastructure/mcp-oauth.js";
import { PrismaCatalog } from "./catalog/infrastructure/prisma-catalog.js";
import { KeyVault } from "./credentials/key-vault.js";
import { CredentialStore } from "./credentials/provider.js";
import { ProviderCreditsService } from "./credits/provider-credits-service.js";
import { EvaluationsService } from "./evaluations/application/evaluations-service.js";
import { EvaluationRepository } from "./evaluations/domain/evaluation-repository.js";
import { PrismaEvaluationRepository } from "./evaluations/infrastructure/prisma-evaluation-repository.js";
import { HarnessRegistry } from "./harnesses/domain/harness-registry.js";
import { DefaultHarnessRegistry } from "./harnesses/harness-registry.js";
import { PiHarness } from "./harnesses/infrastructure/pi-harness.js";
import { EvaluationsController } from "./http/evaluations-controller.js";
import { FilesystemController } from "./http/filesystem-controller.js";
import { ResourcesController } from "./http/resources-controller.js";
import { SessionsController } from "./http/sessions-controller.js";
import { SettingsController } from "./http/settings-controller.js";
import { ToolCallsController } from "./http/tool-calls-controller.js";
import { Database } from "./infrastructure/database.js";
import {
  DecisionModel,
  SingleCallLlm,
} from "./overrides/application/model-ports.js";
import { ModelRewriter } from "./overrides/application/model-rewriter.js";
import {
  JevDecisionModel,
  OpenRouterLlm,
} from "./overrides/infrastructure/model-providers.js";
import { SessionQueue } from "./sessions/application/session-queue.js";
import { SessionWorker } from "./sessions/application/session-worker.js";
import { StartSessions } from "./sessions/application/start-sessions.js";
import { SessionRepository } from "./sessions/domain/session-repository.js";
import { WorkspaceRuntimeFactory } from "./sessions/domain/workspace-runtime.js";
import { WorkspaceStore } from "./sessions/domain/workspace-store.js";
import { ArtifactStore } from "./sessions/infrastructure/artifact-store.js";
import { PrismaSessionRepository } from "./sessions/infrastructure/prisma-session-repository.js";
import { DefaultWorkspaceRuntimeFactory } from "./sessions/infrastructure/workspace-runtime-factory.js";
import { SettingsService } from "./settings/application/settings-service.js";
import { SettingsRepository } from "./settings/domain/settings-repository.js";
import { PrismaSettingsRepository } from "./settings/infrastructure/prisma-settings-repository.js";

// The composition root connects domain ports to infrastructure adapters.
@Module({
  providers: [
    Database,
    {
      provide: AnalyticsService,
      inject: [Database],
      useFactory: async (database: Database) =>
        new AnalyticsService(await loadInstallationId(database)),
    },
    EvaluationsService,
    KeyVault,
    McpOAuth,
    { provide: McpAuthorization, useExisting: McpOAuth },
    PiHarness,
    ProviderCreditsService,
    ModelRewriter,
    { provide: DecisionModel, useClass: JevDecisionModel },
    { provide: SingleCallLlm, useClass: OpenRouterLlm },
    SessionWorker,
    SessionQueue,
    SettingsService,
    StartSessions,
    { provide: HarnessRegistry, useClass: DefaultHarnessRegistry },
    { provide: ResourceRepository, useClass: PrismaCatalog },
    { provide: WorkspaceStore, useClass: ArtifactStore },
    {
      provide: WorkspaceRuntimeFactory,
      useClass: DefaultWorkspaceRuntimeFactory,
    },
    { provide: CredentialStore, useExisting: KeyVault },
    { provide: EvaluationRepository, useClass: PrismaEvaluationRepository },
    { provide: SessionRepository, useClass: PrismaSessionRepository },
    { provide: SettingsRepository, useClass: PrismaSettingsRepository },
    {
      provide: APP_INTERCEPTOR,
      inject: [AnalyticsService],
      useFactory: (analytics: AnalyticsService) => analytics.interceptor(),
    },
  ],
  controllers: [
    EvaluationsController,
    FilesystemController,
    ResourcesController,
    SessionsController,
    ToolCallsController,
    SettingsController,
  ],
})
export class ApplicationModule {}
