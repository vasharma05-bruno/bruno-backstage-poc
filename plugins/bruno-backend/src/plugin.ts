import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
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
        userInfo: coreServices.userInfo,
        // Reads `kind: Bruno` entities for the entity-keyed docs route. Calls
        // are made with the REQUESTING user's credentials, not the plugin's, so
        // the route inherits the catalog's own visibility rules.
        catalog: catalogServiceRef
      },
      async init({
        httpRouter,
        logger,
        config,
        reader,
        database,
        scheduler,
        httpAuth,
        userInfo,
        catalog
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
            catalog,
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
        // Same treatment for the entity-keyed docs route, and for the same
        // reason: it is loaded as an iframe `src`. Prefix matching again means
        // this covers `/entities/<ns>/<name>/docs*` and nothing else — there is
        // no sibling route under `/entities`, and any future one would NOT be
        // reached by this policy unless it sits under that same path.
        httpRouter.addAuthPolicy({
          path: '/entities/:namespace/:name/docs',
          allow: 'user-cookie'
        });
      }
    });
  }
});
