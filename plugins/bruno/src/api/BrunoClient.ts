import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import type { BrunoApi } from './BrunoApi';
import type { CollectionDetail, CollectionSummary } from './types';

/**
 * Default {@link BrunoApi} implementation. Talks to the `bruno` backend plugin
 * over HTTP, resolving the base URL via the discovery API.
 */
export class BrunoClient implements BrunoApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('bruno');
  }

  private async getJson<T>(path: string): Promise<T> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}${path}`);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `Bruno backend request to ${path} failed (${res.status}): ${text}`
      );
    }
    return (await res.json()) as T;
  }

  async getCollections(): Promise<CollectionSummary[]> {
    return this.getJson<CollectionSummary[]>('/collections');
  }

  async getCollection(id: string): Promise<CollectionDetail> {
    return this.getJson<CollectionDetail>(
      `/collections/${encodeURIComponent(id)}`
    );
  }

  async getDocsUrl(id: string): Promise<string> {
    const base = await this.baseUrl();
    return `${base}/collections/${encodeURIComponent(id)}/docs`;
  }
}
