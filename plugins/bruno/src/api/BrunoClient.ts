import type { DiscoveryApi } from '@backstage/core-plugin-api';
import type { BrunoApi } from './BrunoApi';

/**
 * Default {@link BrunoApi} implementation. Talks to the `bruno` backend plugin
 * over HTTP, resolving the base URL via the discovery API.
 *
 * Takes no `fetchApi` any more. The one remaining method BUILDS a URL rather
 * than fetching one — it is handed to an iframe `src`, which carries no
 * Authorization header, so the request is authenticated by the limited-access
 * cookie `useEntityDocsSession` mints for itself. See `lib/docsSession.ts`.
 */
export class BrunoClient implements BrunoApi {
  private readonly discoveryApi: DiscoveryApi;

  constructor(options: { discoveryApi: DiscoveryApi }) {
    this.discoveryApi = options.discoveryApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('bruno');
  }

  async getEntityDocsUrl(
    namespace: string,
    name: string,
    theme: 'light' | 'dark'
  ): Promise<string> {
    const base = await this.baseUrl();
    const path = `/entities/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/docs`;
    return `${base}${path}?theme=${theme}`;
  }
}
