import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import type { BrunoApi } from './BrunoApi';
import type {
  CollectionDetail,
  CollectionSummary,
  ConnectionRecord,
  ConnectResult,
  Dashboard,
  DiscoverResult
} from './types';

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

  async getDashboard(): Promise<Dashboard> {
    return this.getJson<Dashboard>('/dashboard');
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

  async connect(
    entityRef: string,
    url: string,
    token?: string
  ): Promise<ConnectResult> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityRef, url, userGithubToken: token })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `Bruno backend request to /connections failed (${res.status}): ${text}`
      );
    }
    return (await res.json()) as ConnectResult;
  }

  async discover(url: string, token?: string): Promise<DiscoverResult> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/connections/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, userGithubToken: token })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `Bruno backend request to /connections/discover failed (${res.status}): ${text}`
      );
    }
    return (await res.json()) as DiscoverResult;
  }

  async getConnection(entityRef: string): Promise<ConnectionRecord | undefined> {
    const base = await this.baseUrl();
    const path = `/connections/${encodeURIComponent(entityRef)}`;
    const res = await this.fetchApi.fetch(`${base}${path}`);
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `Bruno backend request to ${path} failed (${res.status}): ${text}`
      );
    }
    return (await res.json()) as ConnectionRecord;
  }

  async disconnect(entityRef: string): Promise<void> {
    const base = await this.baseUrl();
    const path = `/connections/${encodeURIComponent(entityRef)}`;
    const res = await this.fetchApi.fetch(`${base}${path}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(
        `Bruno backend request to ${path} failed (${res.status}): ${text}`
      );
    }
  }
}
