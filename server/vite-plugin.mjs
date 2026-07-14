import { createDailyTasksMiddleware } from "./daily-tasks-api.mjs";
import { createActionTargetsMiddleware } from "./action-targets-api.mjs";
import { createContentAssetsMiddleware } from "./content-assets-api.mjs";
import { createOpenObsidianMiddleware } from "./open-obsidian-api.mjs";
import { createPlatformFollowersMiddleware } from "./platform-followers-api.mjs";
import { createReviewAssetsMiddleware } from "./review-assets-api.mjs";
import { createDailyReviewsMiddleware } from "./daily-reviews-api.mjs";
import { createCockpitSettingsMiddleware } from "./cockpit-settings-api.mjs";
import { createAiAgentsMiddleware } from "./ai-agents-api.mjs";
import { createAiEnvironmentMiddleware } from "./ai-environment-api.mjs";
import { createAgentCatalogService } from "./agent-catalog.mjs";
import { createAiRunsMiddleware } from "./ai-runs-api.mjs";
import { createAiConversationsMiddleware } from "./ai-conversations-api.mjs";
import { rebuildAndValidateIndex } from "./daily-tasks-api.mjs";
import {
  createVaultChangeWatcher,
  createVaultEventsHub,
  createVaultEventsMiddleware,
} from "./vault-events.mjs";

export function dailyTasksApiPlugin(options = {}) {
  const eventHub = options.eventHub ?? createVaultEventsHub();
  const mount = (server) => {
    const catalogService = options.catalogService ?? createAgentCatalogService(options);
    // Warm the bounded catalog cache after the local server starts so opening
    // the AI workspace does not have to wait for five CLI probes.
    void catalogService.list().catch((error) => {
      server.config.logger.warn(`本机 AI 预检测失败: ${error.message}`);
    });
    const aiRunsMiddleware = createAiRunsMiddleware({
      ...options,
      catalogService,
      afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
    });
    const aiConversationsMiddleware = createAiConversationsMiddleware({
      ...options,
      catalogService,
      afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
    });
    const aiEnvironmentMiddleware = createAiEnvironmentMiddleware({
      ...options,
      catalogService,
      isProviderActive: (provider) => aiConversationsMiddleware.service.hasActiveProvider(provider),
    });
    server.middlewares.use(createVaultEventsMiddleware({ hub: eventHub }));
    server.middlewares.use(createDailyTasksMiddleware(options));
    server.middlewares.use(createActionTargetsMiddleware(options));
    server.middlewares.use(createContentAssetsMiddleware(options));
    server.middlewares.use(createReviewAssetsMiddleware(options));
    server.middlewares.use(createDailyReviewsMiddleware(options));
    server.middlewares.use(createCockpitSettingsMiddleware(options));
    server.middlewares.use(createAiAgentsMiddleware({ service: catalogService }));
    server.middlewares.use(aiEnvironmentMiddleware);
    server.middlewares.use(aiRunsMiddleware);
    server.middlewares.use(aiConversationsMiddleware);
    server.middlewares.use(createOpenObsidianMiddleware(options));
    server.middlewares.use(createPlatformFollowersMiddleware(options));
    if (options.watchVault !== false) {
      const watcher = createVaultChangeWatcher({
        root: options.root,
        rebuild: options.afterExternalChange ?? rebuildAndValidateIndex,
        debounceMs: options.watchDebounceMs,
        publish: (scope) => eventHub.publish(scope),
        onError: (error) => server.config.logger.error(`V2 文件同步失败: ${error.message}`),
      });
      server.httpServer?.once("close", () => watcher.close());
    }
    server.httpServer?.once("close", () => { void aiRunsMiddleware.service.close(); });
    server.httpServer?.once("close", () => { void aiConversationsMiddleware.service.close(); });
    server.httpServer?.once("close", () => { void aiEnvironmentMiddleware.service.close(); });
  };
  return {
    name: "creator-workbench-local-api",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
