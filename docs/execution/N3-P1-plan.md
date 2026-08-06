# N3-P1 — Cache lifecycle hardening — Execution Plan (LOCKED)

> Harden the two in-memory caches in `plugins/bruno-backend/src/service/collectionService.ts`. Four items, two of them correctness fixes: (1) **evict-on-disconnect** — the DELETE route drops the store row but never touches `connectedCache`, leaving a disconnect ghost; (2) **rehydrate-on-boot + periodic DB-driven rebuild of `connectedCache`** — read `bruno_connections` via `listAll()`, re-fetch service-visible collections with the SERVICE token, and DROP `connectedCache` entries whose row is gone (self-bounding ghost backstop); (3) **per-entry TTL + LRU size cap** on `connectedCache` (stale-while-revalidate; serve stale meanwhile, refresh on the tick); (4) a brief in-memory **discover-result session cache** keyed by normalized repo URL. No new deps, no schema change, no tests. Gated by repo-level `yarn tsc` (0 errors) + `yarn lint:bruno plugins/bruno-backend/src` (clean) — NOT backstage-cli build.
>
> Verified against HEAD `5d38531`: two plain `Map` caches at `collectionService.ts:206-207` (`cache`, `connectedCache`), NO TTL/LRU/bound. `refresh()` (`:251-265`) does `cache.clear()` then rebuilds the config `cache` only. `connectedCache.set(collectionId, detail)` at `:321` in `connectFromUrl`. `getCollection(id)` (`:282-284`) returns `cache.get(id) ?? connectedCache.get(id)`. `getDashboard()` iterates both (`:363-369`). DELETE `/connections/:entityRef` (`router.ts:159-163`) deletes the row then `204` — never evicts `connectedCache` (THE bug). `connectedCache` is keyed by **`collectionId`** but the store row PK is **`entity_ref`** (`connectionStore.ts`) — evict-on-disconnect MUST resolve the row's `collectionId` first. `CachedCollection extends CollectionDetail` (`:109`), a pure alias. `readUrlTreeWithCreds(reader, integrations, url, logger, opts?)` (`:528-549`): tries service `readUrlTree` first, falls back to Octokit ONLY when `opts.userToken` is set, else **re-throws** — so a background rebuild with no userToken is a pure service fetch that throws on private repos.

## ⚠️ Load-bearing topology fact (corrects the naive "rebuild on the scheduler" reading)

`createCollectionService` is instantiated **twice, independently**:
- **`plugin.ts:38`** (`bruno` backend plugin) — the instance the **router** uses. `connectedCache` is written here (`connectFromUrl` via `POST /connections`) and read here (`GET /collections/:id`, `/dashboard`, `DELETE`). Deps include `database` (→ `connectionStore`), NO `scheduler`.
- **`module.ts:65`** (`catalog` module) — a **separate** instance for `BrunoEntityProvider`. This is the one on the 60s scheduler (`BrunoEntityProvider.run()` → `collectionService.refresh()`), but it only materializes config-source catalog entities. **Its `connectedCache` is always empty** (no connect path ever writes to it).

**Therefore the connected-rebuild MUST run on the plugin.ts instance, not the module's provider tick.** Rebuilding on the provider tick would target the wrong (empty) cache and the router would never see it.

## Locked decisions
- **D1 — connected rebuild lives in `plugin.ts`.** Add `coreServices.scheduler` to the plugin's deps; register a dedicated scheduled task (`id: 'bruno-connected-rebuild'`) that calls `collectionService.rebuildConnected(await connectionStore.listAll())` at the `bruno.schedule` cadence. Also call it once at boot (rehydrate). **`module.ts` and `BrunoEntityProvider.ts` are UNTOUCHED** (except the D9 import swap).
- **D2 — isolate new logic in `rebuildConnected(links)`; leave `refresh()` unchanged.** `refresh()` still rebuilds only the config `cache` (its existing behavior on both instances is preserved). The connected lifecycle is a new, separate method. This keeps the diff surgical and changes no existing behavior.
- **D3 — `connectedCache` becomes `Map<string, ConnectedEntry>`** where `ConnectedEntry = { detail: CachedCollection; fetchedAt: number; stale: boolean }`. Reads unwrap `.detail`. Public types (`CollectionDetail`/`CollectionSummary`/`CachedCollection`) are UNCHANGED — all method return types stay identical.
- **D4 — TTL = 10 min (`CONNECTED_TTL_MS`).** Stale-while-revalidate: on read past TTL, set `stale=true`, return the stale `.detail` immediately (NO I/O on the read path); the actual re-fetch happens on the next `rebuildConnected` tick (service token). TTL is a module const, not new config.
- **D5 — LRU cap = 200 (`CONNECTED_MAX`), insertion-order `Map`.** On write, if at cap evict the oldest key; on read-hit, `delete`+re-`set` to move to MRU tail. Inline, no dependency.
- **D6 — DON'T-EVICT-ON-FETCH-FAILURE (load-bearing).** In `rebuildConnected`, an entry is dropped ONLY when its store row is gone (`collectionId` not in `links`). A SERVICE re-fetch that throws (user-token-private repo — the user token is never persisted, by design) MUST be caught, `warn`-logged (id only), and the last good entry KEPT (leave its `fetchedAt`/`detail`). Only a missing ROW evicts.
- **D7 — Discover session cache:** `Map<string, DiscoverEntry>` keyed by `normalizeGithubUrl(url)`, TTL 60s (`DISCOVER_TTL_MS`), max 50 (`DISCOVER_MAX`), in-memory. Token-blind: the result carries no secrets and roots are token-independent; a miss always re-walks (authenticated by the caller's token). Not durable.
- **D8 — Never log tokens/creds.** Log `collectionId` (and at most the normalized `sourceUrl`).
- **D9 — shared `readSchedule`.** Extract the existing `readSchedule(config)` (currently `module.ts:23-38`) + its `DEFAULT_FREQUENCY_SECONDS`/`DEFAULT_TIMEOUT_SECONDS` consts into `plugins/bruno-backend/src/service/schedule.ts` (single source of truth), imported by BOTH `module.ts` and `plugin.ts`. This is the ONLY change to `module.ts` (an import swap — no behavior change).

## Backend edits

### `plugins/bruno-backend/src/service/schedule.ts` (NEW)
Move `readSchedule` + the two `DEFAULT_*` consts here verbatim from `module.ts`. Export `readSchedule`. `import type { Config } from '@backstage/config'`, `import type { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api'`.

### `plugins/bruno-backend/src/service/collectionService.ts`
1. **Consts** near `:126`: `CONNECTED_TTL_MS = 10 * 60_000`, `CONNECTED_MAX = 200`, `DISCOVER_TTL_MS = 60_000`, `DISCOVER_MAX = 50`.
2. **Local types** near `:109`: `type ConnectedEntry = { detail: CachedCollection; fetchedAt: number; stale: boolean };` and `type DiscoverEntry = { result: DiscoverResult; fetchedAt: number };`.
3. **Interface** (`:111-124`): add `rebuildConnected(links: BrunoConnectionRow[]): Promise<void>;` and `evictConnected(collectionId: string): void;`. `refresh()` unchanged.
4. **Maps** (`:207`): change to `const connectedCache = new Map<string, ConnectedEntry>();`; add `const discoverCache = new Map<string, DiscoverEntry>();`.
5. **Inline LRU helpers** (near the other closure helpers, e.g. before `refresh`): `function lruSet<V>(m: Map<string, V>, k: string, v: V, max: number): void` (delete `k` then set for MRU order; if `m.size > max` delete `m.keys().next().value`); `function lruTouch<V>(m: Map<string, V>, k: string): V | undefined` (get; if present delete+re-set; return the value).
6. **Hoist `connectFromUrl`** out of the returned object literal into a named closure `async function connectFromUrl(input: { url: string; userToken?: string })` (so `rebuildConnected` can call it); reference it in the returned object as `connectFromUrl,`. Its cache write (`:321`) becomes `lruSet(connectedCache, collectionId, { detail, fetchedAt: Date.now(), stale: false }, CONNECTED_MAX)`.
7. **`getCollection`** (`:282-284`): `const hit = cache.get(id); if (hit) return hit; const e = lruTouch(connectedCache, id); if (!e) return undefined; if (Date.now() - e.fetchedAt > CONNECTED_TTL_MS) e.stale = true; return e.detail;` (no I/O).
8. **`getDashboard`** (`:367-369`): connected loop → `for (const e of connectedCache.values()) byId.set(e.detail.id, e.detail);`.
9. **New `rebuildConnected(links)`** (named closure; referenced in returned object). Control flow:
   ```
   const liveIds = new Set(links.map(l => l.collectionId));
   for (const id of [...connectedCache.keys()]) if (!liveIds.has(id)) connectedCache.delete(id);   // ghost drop (D6: row-gone only)
   const now = Date.now();
   for (const link of links) {
     const e = connectedCache.get(link.collectionId);
     if (e && now - e.fetchedAt <= CONNECTED_TTL_MS) continue;                 // fresh: skip (TTL guard)
     try { await connectFromUrl({ url: link.githubUrl }); }                    // SERVICE token (no userToken); writes wrapper via lruSet
     catch { logger.warn(`Background refresh of connected collection ${link.collectionId} failed; keeping cached copy.`); }  // D6: keep last good, do NOT delete
   }
   ```
   (`connectFromUrl`'s write-through handles `lruSet`/trim; no extra trim needed here. `connectFromUrl({url})` with no `userToken` = pure service fetch; on private-repo failure it throws → caught → entry kept.)
10. **New `evictConnected(collectionId)`**: `connectedCache.delete(collectionId); logger.info(\`Evicted connected collection ${collectionId} from cache.\`);`.
11. **`discoverCollections`** (`:324-360`): at entry, `const key = normalizeGithubUrl(input.url); const cached = lruTouch(discoverCache, key); if (cached && Date.now() - cached.fetchedAt <= DISCOVER_TTL_MS) return cached.result;` — else run the existing walk, then `lruSet(discoverCache, key, { result: { collections }, fetchedAt: Date.now() }, DISCOVER_MAX)` before returning `{ collections }`.

### `plugins/bruno-backend/src/service/router.ts`
DELETE `/connections/:entityRef` (`:159-163`): resolve the row FIRST, then evict.
```
const entityRef = req.params.entityRef;
const row = await connectionStore.getByEntityRef(entityRef);   // may be undefined
await connectionStore.delete(entityRef);                        // idempotent
if (row) collectionService.evictConnected(row.collectionId);
res.status(204).end();
```
(Confirm the DELETE handler already has `connectionStore` + `collectionService` in scope — both are `createRouter` deps.)

### `plugins/bruno-backend/src/plugin.ts`
- Add `scheduler: coreServices.scheduler` to `deps` (`:20-28`) and to the `init` destructure (`:29-37`).
- `import { readSchedule } from './service/schedule';`.
- After `connectionStore` is built (`:44`) and BEFORE `createRouter` (`:46`):
  ```
  await collectionService.rebuildConnected(await connectionStore.listAll());   // boot rehydrate
  const connectedRefresh = scheduler.createScheduledTaskRunner(readSchedule(config));
  await connectedRefresh.run({
    id: 'bruno-connected-rebuild',
    fn: async () => {
      await collectionService.rebuildConnected(await connectionStore.listAll());
    }
  });
  ```

### `plugins/bruno-backend/src/module.ts`
Only change: delete the local `readSchedule` + its two `DEFAULT_*` consts (`:13-38`) and add `import { readSchedule } from './service/schedule';`. Everything else unchanged. (`module.ts` still builds its own service + provider exactly as today.)

## Executor watch-list
1. `connectedCache` value type changed to `ConnectedEntry` → EVERY access unwraps `.detail`. After editing, `grep -n connectedCache collectionService.ts` and confirm no raw `.get(...)`/`.values()` is used as a `CollectionDetail`. Known sites: `getCollection` (`:283`), `getDashboard` (`:367-369`), `connectFromUrl` write (`:321`).
2. Do NOT change public types or method return types — `CollectionDetail`/`CollectionSummary`/`CachedCollection` stay identical; `listCollections`/`getCollection`/`getDashboard`/`connectFromUrl`/`discoverCollections`/`refresh` signatures unchanged.
3. `connectFromUrl` MUST be hoisted to a named closure and referenced in the returned object (`connectFromUrl,`) so `rebuildConnected` can call it. Keep its behavior identical (manifest check + parse + write-through).
4. **D6 is load-bearing:** the `catch` in `rebuildConnected` must NOT delete; only the "row gone" branch deletes. Verify by reading the final method.
5. `refresh()` is NOT modified and NOT called with args anywhere. `POST /refresh` (`router.ts:167`) and `BrunoEntityProvider.run()` keep calling `refresh()`.
6. `plugin.ts` gains a `scheduler` dep; `module.ts` loses its local `readSchedule` in favor of the shared import — confirm `module.ts` stays behaviorally identical (same schedule values).
7. D8: no `userToken`/Octokit `auth`/creds-in-URL in any new log line. Log `collectionId` only.
8. `import type { BrunoConnectionRow }` is already imported (used by `getDashboard`) — reuse it. Leading-`|` multi-line unions. `import type` for type-only imports.
9. Async re-fetches inside the scheduled `fn` are bounded by `bruno.schedule.timeoutSeconds` (default 30s) — same as the existing provider task.

## Risks
- **R-A** rebuild re-fetch cost: mitigated by the TTL `continue` guard (≤1 re-fetch / 10 min / entry); steady-state ticks do near-zero I/O. No batching (POC scale).
- **R-B** two scheduled tasks now exist (`bruno`'s connected-rebuild + the catalog module's provider refresh) at the same cadence — intentional and independent; different instances, different jobs.
- **R-C** boot `rebuildConnected` re-fetches every stored connection once at startup (cold cache), awaited before the router mounts. Bounded by connection count (POC scale) — acceptable; note it.
- **R-D** discover cache token-blindness: acceptable — result has no secrets, roots are token-independent, misses re-walk authenticated.

## Gates (authoritative — NOT backstage-cli build)
```
yarn tsc                                   # 0 errors, repo-level
yarn lint:bruno plugins/bruno-backend/src  # clean
```
No tests. Minimal changes, no new deps.
