import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import type { BrunoApi, ProbeResult } from './BrunoApi';

/**
 * Default {@link BrunoApi} implementation. Talks to the `bruno` backend plugin
 * over HTTP, resolving the base URL via the discovery API.
 *
 * The two methods authenticate in two different ways, and the split is forced
 * rather than chosen:
 *
 *  - `getEntityDocsUrl` BUILDS a URL rather than fetching one. It is handed to
 *    an iframe `src`, which carries no Authorization header, so that request is
 *    authenticated by the limited-access cookie `useEntityDocsSession` mints for
 *    itself. See `lib/docsSession.ts`.
 *  - `probeCollection` is an ordinary fetch, so it goes through `fetchApi` —
 *    the app-wide wrapper that attaches the Backstage identity token. Calling
 *    `window.fetch` here would reach the route unauthenticated and be rejected
 *    by the backend's default credentials barrier.
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

  /**
   * `POST /collections/probe`.
   *
   * A `400` is PARSED, not thrown. The route answers "I could not read that
   * URL" with a 400 carrying `{ found: false, reason: 'unreadable', message }`,
   * and that message is the only useful thing the UI can show for a missing
   * `integrations` entry or a revoked token — turning it into a generic
   * `HTTP 400` would throw away the entire diagnostic.
   *
   * Any other non-2xx status is NOT ours: an auth redirect, a proxy error page,
   * a 404 from a backend that predates this route. Those get a plain error, and
   * the response body is deliberately not shown — an HTML error page rendered
   * into a form field helps nobody.
   */
  async probeCollection(url: string): Promise<ProbeResult> {
    const base = await this.baseUrl();
    const response = await this.fetchApi.fetch(`${base}/collections/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok && response.status !== 400) {
      throw new Error(
        `Could not probe ${url}: the Bruno backend responded `
        + `${response.status} ${response.statusText}.`
      );
    }

    // Shape-checked rather than cast blind: a 400 produced by something OTHER
    // than this route (a gateway, a body-size limit) parses as JSON often
    // enough to reach here, and a `ProbeResult` with no `found` would fall
    // through every branch in the dialog as a silent success.
    const body: unknown = await response.json().catch(() => undefined);
    if (
      typeof body !== 'object'
      || body === null
      || typeof (body as { found?: unknown }).found !== 'boolean'
    ) {
      throw new Error(
        `Could not probe ${url}: the Bruno backend returned an unexpected `
        + `response (HTTP ${response.status}).`
      );
    }
    return body as ProbeResult;
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
