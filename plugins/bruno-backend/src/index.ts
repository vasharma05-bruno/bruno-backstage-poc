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

/** The catalog module that installs the BrunoEntityProvider. */
export { brunoCatalogModule } from './module';

export { BrunoEntityProvider } from './provider/BrunoEntityProvider';
export { createCollectionService } from './service/collectionService';
export { createRouter } from './service/router';
export { generateCollectionHtml } from './service/generateCollectionHtml';

// Re-export the shared contract types so the frontend may reuse them.
export type {
  Assertion,
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
