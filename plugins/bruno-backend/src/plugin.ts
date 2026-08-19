import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { createCollectionService } from './service/collectionService';
import { createRouter } from './service/router';
import { readSchedule } from './service/schedule';
import { createConnectionStore } from './store/connectionStore';
import { createCollectionsStore } from './store/collectionsStore';

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
        const collectionsStore = await createCollectionsStore(database);

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
            collectionsStore,
            httpAuth,
            userInfo
          })
        );

        // `/health` is a liveness probe with no data — keep it open.
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated'
        });
        // The docs page is loaded as an iframe `src` — a browser GET with NO
        // Authorization header — so it cannot use bearer auth. Allow the
        // Backstage limited-access USER-COOKIE on this exact route only. Path
        // matching is prefix-based (path-to-regexp `end:false`) and additive,
        // so this matches `/collections/<id>/docs*` and NOTHING ELSE under
        // `/collections`: the sibling read routes (list, :id, opencollection.yml)
        // fall through to the default credentials barrier and require a full
        // user/service token. See docs/execution/DOCS-AUTH-P1-plan.md.
        httpRouter.addAuthPolicy({
          path: '/collections/:id/docs',
          allow: 'user-cookie'
        });
      }
    });
  }
});
