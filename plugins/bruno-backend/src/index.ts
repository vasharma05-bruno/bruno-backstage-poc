/**
 * The Bruno-for-Backstage backend plugin.
 *
 * @packageDocumentation
 */

import { brunoPlugin } from './plugin';

/** The Bruno backend plugin (serves `/api/bruno/*`). */
export { brunoPlugin };

/** Default export is the backend plugin. */
export { brunoPlugin as default };

/** The catalog module that installs the Bruno providers and processors. */
export { brunoCatalogModule } from './module';

export { BrunoCollectionEntityProvider } from './provider/BrunoCollectionEntityProvider';
export {
  BrunoKindProcessor,
  BRUNO_API_VERSION,
  brunoEntityV1alpha1Schema
} from './processor/BrunoKindProcessor';
/**
 * The permissions this plugin registers, for an adopter's `PermissionPolicy`.
 *
 * Exported as OBJECTS rather than as name strings so a policy can use
 * `isPermission(request.permission, brunoCollectionDeletePermission)` and get a
 * compile error when one is renamed, instead of a policy that silently stops
 * matching. `brunoPermissions` is the whole set, which is what `plugin.ts`
 * hands to `permissionsRegistry.addPermissions`.
 */
export {
  brunoCollectionCreatePermission,
  brunoCollectionDeleteAnyPermission,
  brunoCollectionDeletePermission,
  brunoLinkCreatePermission,
  brunoLinkDeleteAnyPermission,
  brunoLinkDeletePermission,
  brunoPermissions
} from './permissions';
export {
  readBrunoCollections,
  readCacheTtlMs,
  readDefinitionOptions
} from './service/brunoConfig';
export { createManifestProbe } from './service/manifestProbe';
export { createRouter } from './service/router';
export { generateOcDocsHtml } from './service/generateOcDocsHtml';
export { createUiCollectionStore } from './store/uiCollectionStore';
export { createStoredCollectionReader } from './provider/storedCollections';

export type {
  CollectionManifest,
  CollectionSnapshot,
  ManifestProbe
} from './service/manifestProbe';
export type {
  UiCollectionRow,
  UiCollectionStore
} from './store/uiCollectionStore';
export type {
  StoredCollection,
  StoredCollectionReader
} from './provider/storedCollections';

// The parse/normalize contract types, exported as part of this package's public
// API for a host app that wires the provider or processor itself.
//
// NOT reachable from the frontend plugin, which deliberately does not depend on
// this package — which is why `plugins/bruno/src/lib/brunoEntity.ts` hand-mirrors
// `BrunoEntity['spec']` and `generateCatalogInfo.ts` re-declares
// `BRUNO_API_VERSION`, both with a comment saying to keep them in step. An
// earlier note here claimed the frontend reuses these; it cannot.
export type {
  Assertion,
  BrunoCollectionConfig,
  BrunoEntity,
  Environment,
  FolderItem,
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody,
  RequestItem,
  RequestScript
} from './types';
