import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { createCollectionService } from './service/collectionService';
import { createRouter } from './service/router';
import { readSchedule } from './service/schedule';
import { createConnectionStore } from './store/connectionStore';

/**
 * The Bruno backend plugin. Registers under plugin id `bruno`, so its routes
 * are served at `/api/bruno/*` (the frontend resolves this via
 * `discoveryApi.getBaseUrl('bruno')`).
 *
 * @public
 */
export const brunoPlugin = createBackendPlugin({
  pluginId: 'bruno',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        reader: coreServices.urlReader,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo
      },
      async init({
        httpRouter,
        logger,
        config,
        reader,
        database,
        scheduler,
        httpAuth,
        userInfo
      }) {
        const collectionService = await createCollectionService({
          logger,
          config,
          reader
        });

        const connectionStore = await createConnectionStore(database);

        await collectionService.rebuildConnected(await connectionStore.listAll());
        const connectedRefresh = scheduler.createScheduledTaskRunner(
          readSchedule(config)
        );
        await connectedRefresh.run({
          id: 'bruno-connected-rebuild',
          fn: async () => {
            await collectionService.rebuildConnected(
              await connectionStore.listAll()
            );
          }
        });

        httpRouter.use(
          await createRouter({
            logger,
            config,
            collectionService,
            connectionStore,
            httpAuth,
            userInfo
          })
        );

        // POC: allow unauthenticated access to the read-only endpoints so the
        // docs can be linked out / embedded without a Backstage session. The
        // GitHub token used server-side by the UrlReader is never exposed here
        // (RISK #1) — these responses contain only parsed collection data.
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated'
        });
        httpRouter.addAuthPolicy({
          path: '/collections',
          allow: 'unauthenticated'
        });
      }
    });
  }
});
