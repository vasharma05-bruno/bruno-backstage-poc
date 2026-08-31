import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createRouter } from './service/router';

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
        httpAuth: coreServices.httpAuth,
        // Reads `kind: Bruno` entities for the entity-keyed docs route. Calls
        // are made with the REQUESTING user's credentials, not the plugin's, so
        // the route inherits the catalog's own visibility rules.
        catalog: catalogServiceRef
      },
      async init({ httpRouter, logger, config, httpAuth, catalog }) {
        httpRouter.use(
          await createRouter({
            logger,
            config,
            catalog,
            httpAuth
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
        // so this covers `/entities/<ns>/<name>/docs*` and nothing else — there
        // is no sibling route under `/entities`, and any future one would NOT
        // be reached by this policy unless it sits under that same path. See
        // docs/execution/DOCS-AUTH-P1-plan.md.
        httpRouter.addAuthPolicy({
          path: '/entities/:namespace/:name/docs',
          allow: 'user-cookie'
        });
      }
    });
  }
});
