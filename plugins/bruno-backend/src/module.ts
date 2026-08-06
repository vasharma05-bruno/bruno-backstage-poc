import {
  coreServices,
  createBackendModule
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { createCollectionService } from './service/collectionService';
import { readSchedule } from './service/schedule';
import { BrunoEntityProvider } from './provider/BrunoEntityProvider';
import { BrunoLinkProcessor } from './processor/BrunoLinkProcessor';

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
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth
      },
      async init({ catalog, logger, config, reader, scheduler, discovery, auth }) {
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

        catalog.addProcessor(new BrunoLinkProcessor({ discovery, auth, logger }));
      }
    });
  }
});
