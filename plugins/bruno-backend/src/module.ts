import {
  coreServices,
  createBackendModule
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import {
  readCacheTtlMs,
  readDefinitionOptions
} from './service/brunoConfig';
import { createManifestProbe } from './service/manifestProbe';
import { readSchedule } from './service/schedule';
import { BrunoCollectionEntityProvider } from './provider/BrunoCollectionEntityProvider';
import { BrunoKindProcessor } from './processor/BrunoKindProcessor';

/**
 * Catalog module wiring the two Bruno catalog extensions:
 *
 * - {@link BrunoCollectionEntityProvider} — materializes one `kind: Bruno`
 *   entity per `bruno.collections[]` entry, on a scheduled refresh (driven by
 *   `bruno.schedule`, default every 60s).
 * - {@link BrunoKindProcessor} — teaches the catalog about `kind: Bruno` and
 *   enriches every such entity, whether it came from that provider or from an
 *   authored `catalog-info.yaml`.
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

        // Constructed once and shared, so two `kind: Bruno` entities pointing
        // at the same repo cost one tree read rather than one each per
        // reprocess cycle.
        const probe = createManifestProbe({
          config,
          reader,
          logger,
          ttlMs: readCacheTtlMs(config),
          definition: readDefinitionOptions(config, logger)
        });

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
      }
    });
  }
});
