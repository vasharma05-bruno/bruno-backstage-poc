import {
  coreServices,
  createBackendPlugin
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { brunoPermissions } from './permissions';
import { createRouter } from './service/router';
import {
  readAllowRuntimeWrites,
  readCacheTtlMs,
  readDefinitionOptions,
  readDocsOptions
} from './service/brunoConfig';
import { createManifestProbe } from './service/manifestProbe';
import { readRefreshSeconds } from './service/schedule';
import { applyDatabaseMigrations } from './store/migrations';
import { createRuntimeLinkStore } from './store/runtimeLinkStore';
import { createUiCollectionStore } from './store/uiCollectionStore';

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
        // The adopter's `PermissionPolicy`, asked once per mutating route
        // before anything is read or written, and the ownership half that
        // follows it. `userInfo` is what turns a credential into the
        // `ownershipEntityRefs` the `created_by` column is compared against —
        // `httpAuth` alone cannot answer that, it only carries the principal.
        permissions: coreServices.permissions,
        userInfo: coreServices.userInfo,
        // Publishes the six permissions so `/.well-known/backstage/permissions/
        // metadata` lists them and an adopter's policy can be written against
        // names it can discover.
        permissionsRegistry: coreServices.permissionsRegistry,
        // Stores the collections added from the Bruno dashboard, and the links
        // made in this instance instead of in source control — the two write
        // models the catalog does not have. `BrunoCollectionEntityProvider`
        // reads the first back over HTTP and materialises them as entities;
        // `BrunoKindProcessor` reads the second and emits the relations.
        database: coreServices.database,
        // Reads `kind: Bruno` entities for the entity-keyed docs route and for
        // the link routes, and marks a collection for immediate reprocessing
        // when a runtime link changes. Calls are made with the REQUESTING
        // user's credentials, not the plugin's, so the routes inherit the
        // catalog's own visibility rules.
        catalog: catalogServiceRef,
        // Reads collection folders for the add-collection scan, with the
        // SERVER's `integrations` credentials.
        reader: coreServices.urlReader
      },
      async init({
        httpRouter,
        logger,
        config,
        httpAuth,
        permissions,
        userInfo,
        permissionsRegistry,
        database,
        catalog,
        reader
      }) {
        permissionsRegistry.addPermissions(brunoPermissions);

        // A SECOND probe instance: the catalog module builds its own
        // (module.ts), and the two cannot be shared because they are separate
        // backend features with no wiring between them — and sharing one
        // in-process would be wrong anyway on a multi-replica deployment. The
        // cost is one duplicated tree read the first time a scanned collection
        // is then ingested; every read after that is an ETag revalidation.
        const probe = createManifestProbe({
          config,
          reader,
          logger,
          ttlMs: readCacheTtlMs(config),
          definition: readDefinitionOptions(config, logger)
        });

        // Strictly before the stores, which no longer carry any DDL of their
        // own and would otherwise query tables that do not yet exist.
        await applyDatabaseMigrations(database);

        const uiCollections = await createUiCollectionStore(database);
        const runtimeLinks = await createRuntimeLinkStore(database);

        httpRouter.use(
          await createRouter({
            logger,
            config,
            catalog,
            httpAuth,
            permissions,
            userInfo,
            probe,
            uiCollections,
            runtimeLinks,
            refreshSeconds: readRefreshSeconds(config),
            allowRuntimeWrites: readAllowRuntimeWrites(config),
            docs: readDocsOptions(config, logger)
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
        // be reached by this policy unless it sits under that same path.
        httpRouter.addAuthPolicy({
          path: '/entities/:namespace/:name/docs',
          allow: 'user-cookie'
        });
      }
    });
  }
});
