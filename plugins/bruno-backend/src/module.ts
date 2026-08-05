import type {
  SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';
import {
  coreServices,
  createBackendModule
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { createCollectionService } from './service/collectionService';
import { BrunoEntityProvider } from './provider/BrunoEntityProvider';

const DEFAULT_FREQUENCY_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Reads `bruno.schedule` from config into a task schedule definition.
 *
 * Supports the POC contract's config shape (`frequencySeconds` /
 * `timeoutSeconds`, see docs/POC-DECISIONS.md §3) and falls back to sensible
 * defaults (every 60s, 30s timeout).
 */
function readSchedule(config: Config): SchedulerServiceTaskScheduleDefinition {
  const scheduleConfig = config.getOptionalConfig('bruno.schedule');
  const frequencySeconds
    = scheduleConfig?.getOptionalNumber('frequencySeconds')
      ?? DEFAULT_FREQUENCY_SECONDS;
  const timeoutSeconds
    = scheduleConfig?.getOptionalNumber('timeoutSeconds')
      ?? DEFAULT_TIMEOUT_SECONDS;

  return {
    frequency: { seconds: frequencySeconds },
    timeout: { seconds: timeoutSeconds },
    // Give the backend a moment after boot before the first refresh.
    initialDelay: { seconds: 3 }
  };
}

/**
 * Catalog module that installs the {@link BrunoEntityProvider}. It reads the
 * same `bruno.sources` config as the backend plugin and materializes one
 * `kind: API` entity per source on a scheduled refresh (driven by
 * `bruno.schedule`, default every 60s).
 *
 * @public
 */
export const brunoCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'bruno-entity-provider',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        reader: coreServices.urlReader,
        scheduler: coreServices.scheduler
      },
      async init({ catalog, logger, config, reader, scheduler }) {
        const schedule = readSchedule(config);

        const collectionService = await createCollectionService({
          logger,
          config,
          reader
        });

        const taskRunner = scheduler.createScheduledTaskRunner(schedule);

        catalog.addEntityProvider(
          new BrunoEntityProvider({
            config,
            logger,
            collectionService,
            taskRunner
          })
        );
      }
    });
  }
});
