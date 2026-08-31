import {
  coreServices,
  createBackendModule
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { createCollectionService } from './service/collectionService';
import { createManifestProbe } from './service/manifestProbe';
import { readSchedule } from './service/schedule';
import { BrunoCollectionEntityProvider } from './provider/BrunoCollectionEntityProvider';
import { BrunoEntityProvider } from './provider/BrunoEntityProvider';
import { BrunoLinkProcessor } from './processor/BrunoLinkProcessor';
import { BrunoKindProcessor } from './processor/BrunoKindProcessor';

/**
 * Catalog module wiring the three Bruno catalog extensions:
 *
 * - {@link BrunoEntityProvider} — reads the same `bruno.sources` config as the
 *   backend plugin and materializes one `kind: API` entity per source on a
 *   scheduled refresh (driven by `bruno.schedule`, default every 60s).
 * - {@link BrunoCollectionEntityProvider} — materializes one `kind: Bruno`
 *   entity per `bruno.collections[]` entry, on its own runner of the same
 *   schedule.
 * - {@link BrunoKindProcessor} — teaches the catalog about `kind: Bruno` and
 *   enriches every such entity, whichever of the two paths produced it.
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

        // Constructed once and shared, so two `kind: Bruno` entities pointing
        // at the same repo cost one tree read rather than one each per
        // reprocess cycle.
        const probe = createManifestProbe({ config, reader, logger });

        catalog.addEntityProvider(
          new BrunoCollectionEntityProvider({
            config,
            logger,
            probe,
            taskRunner: scheduler.createScheduledTaskRunner(schedule)
          })
        );

        // Claims `kind: Bruno`. Without a processor validating the kind, the
        // catalog rejects such entities as unrecognized no matter what
        // `catalog.rules` allows.
        catalog.addProcessor(new BrunoKindProcessor({ logger, probe }));

        catalog.addProcessor(new BrunoLinkProcessor({ discovery, auth, logger }));
      }
    });
  }
});
