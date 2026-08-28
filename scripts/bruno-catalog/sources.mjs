/**
 * The five production-grade Bruno collections pulled from
 * https://github.com/bruno-collections and materialized as catalog entities.
 *
 * Each entry is a (repo, subpath) pair rather than a bare repo because several
 * of these repos are *workspaces* — the collection root (the directory holding
 * `bruno.json` or `opencollection.yml`) sits under `collections/<name>`.
 *
 *  - `id`        stable slug; becomes the catalog entity `metadata.name`.
 *  - `repo`      GitHub repo under the bruno-collections org.
 *  - `subpath`   path of the collection root inside the repo ('' = repo root).
 *  - `ref`       branch to read (all five are on the repo default branch).
 *  - `excludeFolders` folder names skipped while reading — used for workshop
 *                collections that ship an answer-key folder duplicating every
 *                request, which would otherwise collide on every path.
 *  - `apiVersionLabel`/`lifecycle`/`tags` catalog metadata for the entity.
 */
export const SOURCES = [
  {
    id: 'github-rest-api',
    title: 'GitHub REST API',
    repo: 'github-rest-api-collection',
    subpath: '',
    ref: 'main',
    apiVersionLabel: 'v3',
    lifecycle: 'production',
    tags: ['bruno', 'rest', 'github', 'scm'],
    description:
      'Repository, user and search endpoints of the GitHub REST API, '
      + 'converted from the upstream Bruno collection.'
  },
  {
    id: 'scim-provisioning-api',
    title: 'SCIM 2.0 Provisioning API',
    repo: 'bruno-scim-api-collection',
    subpath: 'scim-collection',
    ref: 'main',
    apiVersionLabel: '2.0',
    lifecycle: 'production',
    tags: ['bruno', 'rest', 'scim', 'identity', 'provisioning'],
    description:
      'SCIM 2.0 user and group lifecycle management (create, patch, '
      + 'deactivate, delete) plus Service Provider Config.'
  },
  {
    id: 'orders-api',
    title: 'Orders API',
    repo: 'openapi-sync-ws',
    subpath: 'collections/Orders API',
    ref: 'main',
    apiVersionLabel: 'v1',
    lifecycle: 'production',
    tags: ['bruno', 'rest', 'orders', 'openapi-sync'],
    description:
      'Order and customer endpoints kept in sync with an upstream OpenAPI '
      + 'document via Bruno OpenAPI Sync. Carries recorded response examples.'
  },
  {
    id: 'bruno-e2e-demo-api',
    title: 'Bruno E2E Demo API',
    repo: 'bruno-demo-day-ws',
    subpath: 'collections/Bruno E2E Demo',
    ref: 'main',
    apiVersionLabel: 'v1',
    lifecycle: 'production',
    tags: ['bruno', 'rest', 'auth', 'e2e'],
    description:
      'End-to-end demo surface exercising basic, bearer, API-key and OAuth2 '
      + 'auth alongside CRUD, redirect and delay endpoints.'
  },
  {
    id: 'api-testing-practices',
    title: 'API Testing Best Practices',
    repo: 'Webinar-Best-Practices-Feb-2026-BRU',
    subpath: '',
    ref: 'main',
    // Every exercise folder ships a `Solution/` copy of its requests; reading
    // both would collide on every path and say nothing new.
    excludeFolders: ['Solution'],
    apiVersionLabel: 'v1',
    lifecycle: 'production',
    tags: ['bruno', 'rest', 'testing', 'auth', 'scripting'],
    description:
      'Reference collection from the Feb 2026 API Testing Best Practices '
      + 'webinar: variables, bearer/OAuth2 auth, assertions and chaining.'
  }
];

/** GitHub org every source above lives in. */
export const ORG = 'bruno-collections';

/** Backstage System entity all five APIs are grouped under. */
export const SYSTEM_NAME = 'bruno-collections';

/** Owner applied to the System and every API entity. */
export const OWNER = 'guests';

/** Browser URL for a source's collection root. */
export function sourceUrl(source) {
  const base = `https://github.com/${ORG}/${source.repo}`;
  return source.subpath
    ? `${base}/tree/${source.ref}/${encodeSubpath(source.subpath)}`
    : base;
}

/** Percent-encodes each path segment (these subpaths contain spaces). */
export function encodeSubpath(subpath) {
  return subpath.split('/').map(encodeURIComponent).join('/');
}
