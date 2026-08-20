# N2-P2 — BrunoLinkProcessor — Execution Plan (LOCKED)

> A `CatalogProcessor` in `plugins/bruno-backend` that injects Bruno annotations onto externally-owned `kind:API` entities, reading links from the bruno backend over service-to-service HTTP (R-A). No tests, no frontend, no schema change, no refresh trigger (R-B minimal). Minimal diff (1 new file + ~5 lines in module.ts).
>
> Orchestrator-validated: `module.ts` registerInit deps = catalog/logger/config/reader/scheduler + `addEntityProvider` (no processor yet); `addProcessor(...processors)` exists on `catalogProcessingExtensionPoint`; `coreServices.auth` + `coreServices.discovery` present. Annotation keys confirmed identical in `plugins/bruno/src/lib/annotations.ts` and `BrunoEntityProvider.ts`. Bulk `GET /connections` (N2-P1) allows `service`.

## Locked decisions
1. **Method:** `preProcessEntity` (idiomatic for metadata enrichment; returns the mutated entity).
2. **Value mapping** (store has only `githubUrl` + `collectionId`): `bruno.dev/collection-path` ← `githubUrl`, `bruno.dev/source-url` ← `githubUrl`, `bruno.dev/collection-id` ← `collectionId`. Mirrors `BrunoEntityProvider` for url sources.
3. **TTL cache:** 30_000 ms default, constructor-configurable (`cacheTtlMs`); do NOT wire a config key. Single whole-list slot.
4. **R-A:** read links via service-to-service HTTP (`discovery.getBaseUrl('bruno')` + `auth.getPluginRequestToken({onBehalfOf: getOwnServiceCredentials(), targetPluginId:'bruno'})` → `fetch('${base}/connections', {Authorization: Bearer})`). Never throw out of `preProcessEntity` — on fetch failure log + serve stale/empty cache.
5. **R-B:** NO bespoke refresh trigger — rely on the catalog refresh loop; annotation appears within one pass. (Primary UX already immediate via `getConnection`; the annotation is for interop / stock Links card / catalog search.)

## New file — `plugins/bruno-backend/src/processor/BrunoLinkProcessor.ts`
Imports: `type { CatalogProcessor, CatalogProcessorEmit, LocationSpec } from '@backstage/plugin-catalog-node'`; `type { Entity }` + value `stringifyEntityRef` from `@backstage/catalog-model`; `type { AuthService, DiscoveryService, LoggerService } from '@backstage/backend-plugin-api'`.

Constructor (options-object, matching `BrunoEntityProvider` style):
```ts
constructor(private readonly options: {
  discovery: DiscoveryService;
  auth: AuthService;
  logger: LoggerService;
  cacheTtlMs?: number;
}) {}
```
`getProcessorName(): string` → `'BrunoLinkProcessor'`.

`async preProcessEntity(entity, _location, _emit, _originLocation, _cache): Promise<Entity>`:
1. If `entity.kind.toLowerCase() !== 'api'` → return `entity`.
2. If `entity.metadata.annotations?.['bruno.dev/collection-path']` already set → return `entity` (skips provider-materialized + prior injection).
3. `const ref = stringifyEntityRef(entity);` get link map via cached `getLinks()`; if no `map.get(ref)` → return `entity`.
4. Inject (spread-merge) the three annotations per decision 2; return `entity`.

Private `getLinks()`: TTL cache `{ map, expiresAt }`; on miss call `fetchAllLinks()`, build `Map` keyed by `row.entityRef`; on fetch error `logger.warn` + return last-known map or empty `Map` (never throw).

Private `fetchAllLinks()` (R-A): exactly the discovery + token-mint + `fetch('${baseUrl}/connections', {headers:{Authorization:`Bearer ${token}`}})` sequence; `if (!res.ok) throw`; parse `Array<{entityRef, collectionId, githubUrl}>`.

## `module.ts` edits
1. Import `BrunoLinkProcessor`.
2. Add to deps: `discovery: coreServices.discovery`, `auth: coreServices.auth`.
3. Destructure `discovery`, `auth` in `init`.
4. After the existing `catalog.addEntityProvider(...)`: `catalog.addProcessor(new BrunoLinkProcessor({ discovery, auth, logger }));`

No `plugin.ts`/`router.ts`/store/provider changes. No new deps (all present; `fetch` is a Node global).

## Executor watch-list
1. `preProcessEntity` must RETURN the entity in every branch (mutated or not); never throw for skip/fetch-fail.
2. Lookup key via `stringifyEntityRef(entity)` — matches how the frontend wrote the row.
3. Idempotency + kind:API gate before any fetch work where possible (but link lookup needs the map; gate on kind + existing-annotation first).
4. Build: `yarn workspace @usebruno/bruno-backend-plugin-poc build`. No tests.
