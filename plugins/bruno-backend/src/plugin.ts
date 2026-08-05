import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { createCollectionService } from './service/collectionService';
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
        reader: coreServices.urlReader
      },
      async init({ httpRouter, logger, config, reader }) {
        const collectionService = await createCollectionService({
          logger,
          config,
          reader
        });

        httpRouter.use(
          await createRouter({ logger, config, collectionService })
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
