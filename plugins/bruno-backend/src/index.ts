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
export { BrunoEntityProvider } from './provider/BrunoEntityProvider';
export {
  BrunoKindProcessor,
  BRUNO_API_VERSION,
  brunoEntityV1alpha1Schema
} from './processor/BrunoKindProcessor';
export { readBrunoCollections } from './service/brunoConfig';
export { createCollectionService } from './service/collectionService';
export { createManifestProbe } from './service/manifestProbe';
export { createRouter } from './service/router';
export { generateOcDocsHtml } from './service/generateOcDocsHtml';

export type { CollectionManifest, ManifestProbe } from './service/manifestProbe';

// Re-export the shared contract types so the frontend may reuse them.
export type {
  Assertion,
  BrunoCollectionConfig,
  BrunoEntity,
  BrunoSourceConfig,
  CollectionDetail,
  CollectionSummary,
  Dashboard,
  DashboardCollection,
  DashboardStats,
  DiscoveredCollection,
  DiscoverResult,
  Environment,
  FolderItem,
  ImportedCollection,
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody,
  RequestItem,
  RequestScript,
  SourceFailure
} from './types';
