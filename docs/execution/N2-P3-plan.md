# N2-P3 — Dashboard aggregate endpoint — Execution Plan (LOCKED)

> `GET /dashboard` in `plugins/bruno-backend`: stat tiles + per-collection cards + failed-source surfacing, in one call. No tests, no frontend (N2-P4 consumes), no processor change. Minimal diff, match style.
>
> Orchestrator-validated anchors: `CollectionService` interface :105; `loadSource` :189 (catch :214, `return undefined` :220); `refresh` :224; `sanitizeName` :141 (module-private → export it); provider entity name = `sanitizeName(source.id)`, `kind:'API'`, default namespace; router already destructures `connectionStore`, `httpAuth`, `userInfo`.

## Locked decisions
1. **Auth:** require `['user','service']` (handler-level `httpAuth.credentials`, like `/connections`) — the response embeds link/ownership topology. No `plugin.ts` policy change.
2. **entityRef:** for linked collections use `link.entityRef`; for provider/config collections **derive `api:default/${sanitizeName(c.id)}`** — so the card OPEN deep-link works for them. → **export `sanitizeName`** from `BrunoEntityProvider.ts` and import it into `collectionService.ts`.
3. **specType:** constant `'bruno-collection'` for all (truthful for provider entities). Catalog-entity `spec.type` enrichment = documented follow-up (needs a catalog client).
4. **No TTL cache** — compute on demand from `cache`+`connectedCache`+passed links (cheap, always current). `getDashboard` is synchronous and takes `links: BrunoConnectionRow[]` (router fetches via `listAll()` and passes in — no store wiring into the service).

## Response shape
`{ stats: { collections, totalRequests, linkedEntities }, collections: DashboardCollection[], failures: SourceFailure[] }`
`DashboardCollection = { id, name, requestCount, envCount, activeEnv?, specType?, linked, entityRef? }`.
`activeEnv` = first environment name (alphabetical, per R-D — env arrays are sorted; acceptable). `envCount` = environments.length.

## Types (`types.ts`, export; add to `index.ts` type block)
`DashboardCollection`, `SourceFailure { id, target, error }`, `DashboardStats { collections, totalRequests, linkedEntities }`, `Dashboard { stats, collections, failures }`.

## Failed-source capture (`collectionService.ts`)
- Add `let failures: SourceFailure[] = [];` next to `cache`/`connectedCache`.
- In `refresh` (:224), set `failures = [];` at the start (before the `Promise.all`), keep `cache.clear()`.
- In `loadSource` catch (:214-220), after the existing `logger.error`, `failures.push({ id: source.id, target: source.target, error: (error as Error).message });` then keep `return undefined`. Existing behavior unchanged.
- Import the new types into the type-import block. Import `BrunoConnectionRow` from `../store/connectionStore`.

## `getDashboard(links)` (interface :105 + returned object after `refresh`)
```ts
getDashboard(links: BrunoConnectionRow[]): Dashboard;
```
Impl: dedupe `cache` then `connectedCache` by id into a Map; index links by `collectionId`; for each collection push `{ id, name, requestCount, envCount: envs.length, activeEnv: envs[0]?.name, specType: 'bruno-collection', linked: !!link, entityRef: link?.entityRef ?? `api:default/${sanitizeName(c.id)}` }` and sum `requestCount`; return `{ stats: { collections: collections.length, totalRequests, linkedEntities: links.length }, collections, failures }`.

## `BrunoEntityProvider.ts`
Change `function sanitizeName` → `export function sanitizeName` (one word). No other change.

## Route (`router.ts`, with the read endpoints)
```ts
router.get('/dashboard', async (req, res) => {
  await httpAuth.credentials(req, { allow: ['user', 'service'] });
  const links = await connectionStore.listAll();
  res.json(collectionService.getDashboard(links));
});
```
Update the route-list doc comment. No new router imports.

## Executor watch-list
1. `getDashboard` stays synchronous + pure over in-memory maps + passed links; router does the async `listAll()`.
2. Don't alter `/collections` behavior or `loadSource`'s existing log+return.
3. Build: `yarn workspace @usebruno/plugin-bruno-backend build`. No tests.
