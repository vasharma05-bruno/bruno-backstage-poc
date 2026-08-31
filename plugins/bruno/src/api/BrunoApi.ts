import { createApiRef } from '@backstage/core-plugin-api';

/**
 * Client for the `bruno` backend plugin.
 *
 * All calls resolve the backend base URL through the discovery API for plugin
 * id `bruno` (i.e. `discoveryApi.getBaseUrl('bruno')`).
 *
 * Deliberately down to a single method. Everything the UI needs about a
 * collection now travels on the `kind: Bruno` entity itself — the catalog is the
 * read model, so listing, filtering, counting and relation-walking all go
 * through `@backstage/plugin-catalog-react` rather than through this client.
 * The one thing the entity cannot carry is a RENDERED document: the docs page
 * has to be served from an origin whose Content-Security-Policy allows the
 * OpenCollection renderer's bundle, which rules out assembling the HTML in the
 * browser (see `useEntityDocsSession`). Hence `getEntityDocsUrl`, and nothing
 * else.
 *
 * The backend still exposes the connection-store routes this interface used to
 * wrap (`/connections`, `/dashboard`, `/collections/*`); removing them is a
 * separate backend task. They simply have no frontend caller any more.
 */
export interface BrunoApi {
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
