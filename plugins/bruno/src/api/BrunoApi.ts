import { createApiRef } from '@backstage/core-plugin-api';
import type {
  CollectionDetail,
  CollectionSummary,
  ConnectionRecord,
  ConnectResult,
  Dashboard,
  DiscoverResult,
  ImportedCollection
} from './types';

/**
 * Client for the `bruno` backend plugin.
 *
 * All calls resolve the backend base URL through the discovery API for plugin
 * id `bruno` (i.e. `discoveryApi.getBaseUrl('bruno')`).
 */
export interface BrunoApi {
  /** GET /collections */
  getCollections(): Promise<CollectionSummary[]>;
  /** GET /collections/:id */
  getCollection(id: string): Promise<CollectionDetail>;
  /**
   * Absolute URL of the OpenCollection docs page for a collection, for embedding
   * via an iframe `src`. `theme` selects the renderer's light/dark palette.
   */
  getDocsUrl(id: string, theme: 'light' | 'dark'): Promise<string>;
  /** GET /collections/:id/opencollection.yml — raw OpenCollection YAML text. */
  getOpenCollectionYaml(id: string): Promise<string>;
  /** POST /connections — link an entity to a GitHub collection URL. */
  connect(entityRef: string, url: string, token?: string): Promise<ConnectResult>;
  /** POST /connections/discover — list all collection roots in a repo. */
  discover(url: string, token?: string): Promise<DiscoverResult>;
  /** POST /collections/:id/sync — live re-pull from GitHub, refresh the cache. */
  sync(collectionId: string, token?: string): Promise<ConnectResult>;
  /** GET /connections/:entityRef — resolves to undefined on 404. */
  getConnection(entityRef: string): Promise<ConnectionRecord | undefined>;
  /** DELETE /connections/:entityRef */
  disconnect(entityRef: string): Promise<void>;
  /** GET /dashboard — aggregate stats, collection cards, and source failures. */
  getDashboard(): Promise<Dashboard>;
  /** POST /collections/import — import one or more collections (unlinked). */
  importCollections(
    collections: Array<{ sourceUrl: string; name: string }>
  ): Promise<{ imported: number }>;
  /** GET /collections/imported — imported-but-unlinked collections. */
  getImportedCollections(): Promise<ImportedCollection[]>;
  /** DELETE /collections/imported/:id — removes an imported-but-unlinked collection. */
  deleteImportedCollection(collectionId: string): Promise<void>;
}

export const brunoApiRef = createApiRef<BrunoApi>({
  id: 'plugin.bruno.service'
});
