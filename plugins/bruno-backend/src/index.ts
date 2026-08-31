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
export {
  readBrunoCollections,
  readCacheTtlMs,
  readDefinitionOptions
} from './service/brunoConfig';
export { createManifestProbe } from './service/manifestProbe';
export { createRouter } from './service/router';
export { generateOcDocsHtml } from './service/generateOcDocsHtml';

export type {
  CollectionManifest,
  CollectionSnapshot,
  ManifestProbe
} from './service/manifestProbe';

// Re-export the shared contract types so the frontend may reuse them.
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
