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
  /** Absolute URL of the self-contained docs HTML for a collection. */
  getDocsUrl(id: string): Promise<string>;
  /** GET /collections/:id/opencollection.yml — raw OpenCollection YAML text. */
  getOpenCollectionYaml(id: string): Promise<string>;
  /** POST /connections — link an entity to a GitHub collection URL. */
  connect(entityRef: string, url: string, token?: string): Promise<ConnectResult>;
  /** POST /connections/discover — list all collection roots in a repo. */
  discover(url: string, token?: string): Promise<DiscoverResult>;
  /** GET /connections/:entityRef — resolves to undefined on 404. */
  getConnection(entityRef: string): Promise<ConnectionRecord | undefined>;
  /** DELETE /connections/:entityRef */
  disconnect(entityRef: string): Promise<void>;
  /** GET /dashboard — aggregate stats, collection cards, and source failures. */
  getDashboard(): Promise<Dashboard>;
  /** POST /collections/import — import one or more collections (unlinked). */
  importCollections(
    collections: Array<{ githubUrl: string; name: string }>
  ): Promise<{ imported: number }>;
  /** GET /collections/imported — imported-but-unlinked collections. */
  getImportedCollections(): Promise<ImportedCollection[]>;
}

export const brunoApiRef = createApiRef<BrunoApi>({
  id: 'plugin.bruno.service'
});
