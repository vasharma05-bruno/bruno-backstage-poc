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
import { createStoredCollectionReader } from './provider/storedCollections';
import { BrunoKindProcessor } from './processor/BrunoKindProcessor';

/**
 * Catalog module wiring the two Bruno catalog extensions:
 *
 * - {@link BrunoCollectionEntityProvider} — materializes one `kind: Bruno`
 *   entity per `bruno.collections[]` entry AND per collection added from the
 *   Bruno UI, read service-to-service from `GET /api/bruno/collections`, on a
 *   scheduled refresh (driven by `bruno.schedule`, default every 60s).
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
        scheduler: coreServices.scheduler,
        // The `bruno` plugin owns the store of UI-created collections and this
        // module cannot reach it in process, so the provider reads it over HTTP
        // with a plugin token. These two are what mint and address that call.
        discovery: coreServices.discovery,
        auth: coreServices.auth
      },
      async init({
        catalog,
        logger,
        config,
        reader,
        scheduler,
        discovery,
        auth
      }) {
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

        const storedCollections = createStoredCollectionReader({
          discovery,
          auth
        });

        catalog.addEntityProvider(
          new BrunoCollectionEntityProvider({
            config,
            logger,
            probe,
            taskRunner: scheduler.createScheduledTaskRunner(schedule),
            storedCollections
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
