import { createApiRef } from '@backstage/core-plugin-api';

/**
 * A Bruno manifest was found at the probed URL.
 *
 * `format` is the manifest FLAVOUR, not a file extension: `yml` means an
 * `opencollection.yml`/`.yaml` and `bru` means a `bruno.json` alongside `.bru`
 * files. Mirrors `CollectionManifest` in
 * plugins/bruno-backend/src/service/manifestProbe.ts — keep the two in step.
 *
 * `name`, `version` and `description` are all optional because a manifest is
 * allowed to omit them, and because a malformed one is logged and skipped by the
 * backend's extractor rather than failing the probe.
 */
export interface ProbeFound {
  found: true;
  format: 'bru' | 'yml';
  /** Repo-relative path of the manifest that was found. */
  manifestPath: string;
  name?: string;
  version?: string;
  description?: string;
}

/**
 * The answer to "is there a Bruno collection at this URL?".
 *
 * Three outcomes, not two, and the difference between the last two is the whole
 * reason this is a union rather than a nullable: a repository that read fine but
 * holds no manifest is the user's mistake (wrong URL, or the collection lives in
 * a subfolder), while a repository that could not be read at all is the
 * INSTANCE's problem (no `integrations` entry for the host, a revoked token, a
 * private repo). The first needs "point me at the collection folder"; the second
 * needs the backend's own diagnostic shown verbatim, because only an operator
 * can act on it.
 *
 * Both non-found cases are ordinary results, never exceptions — an unreadable
 * URL is something a user types by accident several times per session.
 */
export type ProbeResult
  = | ProbeFound
    | { found: false; reason: 'no-manifest' }
    | { found: false; reason: 'unreadable'; message: string };

/**
 * Client for the `bruno` backend plugin.
 *
 * All calls resolve the backend base URL through the discovery API for plugin
 * id `bruno` (i.e. `discoveryApi.getBaseUrl('bruno')`).
 *
 * Deliberately small. Everything the UI needs about a collection that ALREADY
 * EXISTS travels on the `kind: Bruno` entity itself — the catalog is the read
 * model, so listing, filtering, counting and relation-walking all go through
 * `@backstage/plugin-catalog-react` rather than through this client. What is
 * left are the two things no entity can answer:
 *
 *  - a RENDERED document: the docs page has to be served from an origin whose
 *    Content-Security-Policy allows the OpenCollection renderer's bundle, which
 *    rules out assembling the HTML in the browser (see `useEntityDocsSession`);
 *  - a question about a repository that is NOT in the catalog yet, which is
 *    what the add-collection flow asks before it will generate a descriptor.
 *
 * The backend still exposes the connection-store routes this interface used to
 * wrap (`/connections`, `/dashboard`, `/collections/*`); removing them is a
 * separate backend task. They simply have no frontend caller any more.
 */
export interface BrunoApi {
  /**
   * Asks the backend whether `url` points at a Bruno collection.
   *
   * Server-side on purpose. The browser cannot do this itself: a private repo
   * needs the host's `integrations.*` credentials, which exist only on the
   * backend, and `catalogImportApi.analyzeUrl` — the obvious-looking
   * alternative — looks for a `catalog-info.yaml`, not for a Bruno manifest, so
   * it answers a different question entirely.
   *
   * Takes no token. The route reuses the server-side `UrlReaderService`, so a
   * user's OAuth token never reaches it and can never be logged there.
   */
  probeCollection(url: string): Promise<ProbeResult>;

  /**
   * Absolute URL of the OpenCollection docs page for a `kind: Bruno` entity,
   * for embedding via an iframe `src`. The backend renders it from the entity's
   * own `spec.definition`; `theme` selects the renderer's light/dark palette.
   */
  getEntityDocsUrl(
    namespace: string,
    name: string,
    theme: 'light' | 'dark'
  ): Promise<string>;
}

export const brunoApiRef = createApiRef<BrunoApi>({
  id: 'plugin.bruno.service'
});
