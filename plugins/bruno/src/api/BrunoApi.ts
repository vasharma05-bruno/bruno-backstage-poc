import { createApiRef } from '@backstage/core-plugin-api';
import type { CollectionDetail, CollectionSummary } from './types';

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
}

export const brunoApiRef = createApiRef<BrunoApi>({
  id: 'plugin.bruno.service'
});
