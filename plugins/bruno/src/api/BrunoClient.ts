import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import type {
  BrunoApi,
  CreateCollectionInput,
  CreatedCollection,
  DeletedCollection,
  ProbeResult,
  StoredCollections
} from './BrunoApi';

/**
 * The message a Backstage backend puts on the wire for a thrown error.
 *
 * `MiddlewareFactory`'s error handler serialises every `InputError`,
 * `ConflictError` and `NotFoundError` as `{ error: { name, message }, ... }`,
 * so this shape is the backend's own sentence — the one written for the user
 * rather than for a log.
 */
interface BackendError {
  error?: { message?: unknown };
}

/**
 * Turns a failed response into the most useful `Error` available.
 *
 * The backend's message is preferred over the status EVERY time it is there.
 * A 409 from `POST /collections` carries "a collection named X was already
 * added, pointing at <url>" — the entire value of that status code is in the
 * sentence, and collapsing it to `HTTP 409` puts the user back in front of a
 * form with no idea which field is wrong. This is the same mistake
 * {@link BrunoClient.probeCollection} was written to avoid, one status class
 * up.
 *
 * The fallback is status/statusText only, never the body: a non-2xx that is not
 * ours (an auth redirect, a proxy error page) is usually HTML, and rendering
 * that into a dialog helps nobody.
 */
async function errorFromResponse(
  response: Response,
  what: string
): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const message = (body as BackendError | undefined)?.error?.message;
  if (typeof message === 'string' && message) {
    return new Error(message);
  }
  return new Error(
    `${what}: the Bruno backend responded `
    + `${response.status} ${response.statusText}.`
  );
}

/**
 * Default {@link BrunoApi} implementation. Talks to the `bruno` backend plugin
 * over HTTP, resolving the base URL via the discovery API.
 *
 * The methods authenticate in two different ways, and the split is forced
 * rather than chosen:
 *
 *  - `getEntityDocsUrl` BUILDS a URL rather than fetching one. It is handed to
 *    an iframe `src`, which carries no Authorization header, so that request is
 *    authenticated by the limited-access cookie `useEntityDocsSession` mints for
 *    itself. See `lib/docsSession.ts`.
 *  - everything else is an ordinary fetch, so it goes through `fetchApi` —
 *    the app-wide wrapper that attaches the Backstage identity token. Calling
 *    `window.fetch` here would reach the route unauthenticated and be rejected
 *    by the backend's default credentials barrier. The create and delete routes
 *    are `allow: ['user']`, so the identity token is not merely conventional
 *    there: it is what supplies the `created_by` the backend records.
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

  /**
   * `POST /collections`.
   *
   * Unlike `probeCollection`, there is no success-shaped 4xx here: every non-2xx
   * is a failure the user has to see, so they all go through
   * {@link errorFromResponse} and none are parsed as a result.
   *
   * The 201 body is trusted as far as its shape, deliberately: it is produced by
   * the route immediately above this one in the same repository, and a defensive
   * re-validation here would only convert a backend bug into a second, vaguer
   * error message. What is NOT trusted is that the URL came back unchanged —
   * the backend normalizes it, and the caller shows what was stored.
   */
  async createCollection(
    input: CreateCollectionInput
  ): Promise<CreatedCollection> {
    const base = await this.baseUrl();
    const response = await this.fetchApi.fetch(`${base}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      throw await errorFromResponse(
        response,
        `Could not add ${input.name}`
      );
    }
    return (await response.json()) as CreatedCollection;
  }

  /**
   * `DELETE /collections/:name`.
   *
   * The name is percent-encoded even though the catalog's own grammar admits
   * nothing that needs encoding: the value reaching here comes off an entity in
   * the catalog, not off this app's form, and a path segment built by
   * concatenation is not the place to rely on a validator somewhere else having
   * run.
   *
   * The route's `refreshSeconds` is passed back rather than dropped: the
   * confirmation the user reads has to say how long the deleted row keeps
   * appearing in the dashboard, and this response is the only place a frontend
   * with no config of its own can learn the real interval.
   */
  async deleteCollection(name: string): Promise<DeletedCollection> {
    const base = await this.baseUrl();
    const response = await this.fetchApi.fetch(
      `${base}/collections/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    );

    if (!response.ok) {
      throw await errorFromResponse(response, `Could not remove ${name}`);
    }
    return (await response.json()) as DeletedCollection;
  }

  /**
   * `GET /collections`.
   *
   * The route admits both principal types and answers a USER with `createdBy`
   * stripped from every row, which is what this method's return type says. The
   * envelope is not re-validated element by element: it is produced by the route
   * in this repository from a table with one shape, and a defensive filter here
   * would turn a backend bug into a strip that silently shows less rather than a
   * visible error.
   *
   * `refreshSeconds` rides along with the rows for the reason spelled out on
   * {@link StoredCollections}: the caller has to distinguish a row that is still
   * landing from one that never will, and only the backend knows the tick that
   * separates them.
   */
  async listCollections(): Promise<StoredCollections> {
    const base = await this.baseUrl();
    const response = await this.fetchApi.fetch(`${base}/collections`);

    if (!response.ok) {
      throw await errorFromResponse(
        response,
        'Could not list the collections added from Backstage'
      );
    }
    return (await response.json()) as StoredCollections;
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
