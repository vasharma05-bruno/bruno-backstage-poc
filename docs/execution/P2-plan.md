# P2 — Backend runtime-connect + persistence — Execution Plan (LOCKED)

> Scope: **`plugins/bruno-backend` only.** No tests. No parser swap (`parseCollection` / `@usebruno/lang` untouched; do **not** introduce `@usebruno/filestore`). No frontend changes (that is P3). No `module.ts` change. Minimal diff; match existing file style (semicolons, single quotes, 2-space indent, `type`-only imports where possible).
>
> This plan was produced by a planning agent and **validated by the orchestrator** against the real tree (collectionService.ts `FileTree`/`parseCollection`/cache seam at :87/:305–324/:331–372/:145/:188/:212, plugin.ts deps :19–24 + auth policy :40–47, router.ts `RouterOptions` :9–13 + `express.json()` :31 + `MiddlewareFactory.error()` :72–73). Deps confirmed resolvable: `@backstage/integration@2.0.3`, `@octokit/rest@19.0.13`, `ScmIntegrations.fromConfig`, `Octokit.git.getTree/getBlob/repos.get`.

## Locked decisions (orchestrator) — do NOT re-litigate
1. **Persistence: inline schema creation.** In `createConnectionStore`, `await client.schema.hasTable('bruno_connections')` then `createTable(...)`. No `migrations/` directory, no change to `package.json` `files`. Portable across SQLite (better-sqlite3@12) + Postgres.
2. **User-token fetch: Octokit.** Implement `readUrlTreeViaOctokit(integrations, url, userToken, logger)` using `octokit.git.getTree({recursive:'true'})` + `octokit.git.getBlob(...)`, adapting output to the existing `FileTree = { files: Map<string,string> }`. Do **not** attempt to construct a token-scoped `GithubUrlReader` (no public seam — verified).
3. **Separate `connectedCache` Map.** Runtime-connected collections go in a `connectedCache` that `refresh()` never clears; `getCollection(id)` returns `cache.get(id) ?? connectedCache.get(id)`.
4. **URL identity keeps branch + subpath.** `normalizeGithubUrl` preserves `/tree/<branch>/<subpath>` (distinct subpaths are distinct collections). Not branch-agnostic.
5. **Error handling: broad catch → fallback.** In `readUrlTreeWithCreds`, try the service reader; on ANY error, if `userToken` is present attempt the Octokit fallback (rethrow the fallback's error if it also fails); if no `userToken`, rethrow the original.
6. **No direct `knex` dep.** Type through `DatabaseService.getClient()` return; do not `import 'knex'`.
7. **Auth: handler-level guard.** New `/connections/*` routes are authenticated-by-default (not in any `unauthenticated` whitelist). Each handler additionally calls `await httpAuth.credentials(req, { allow: ['user'] })`. No new `addAuthPolicy` entry. Existing `/health` + `/collections` policies unchanged.

---

## 1. Files to change

### 1.1 NEW — `plugins/bruno-backend/src/store/connectionStore.ts`
Small Knex-backed store. Intended surface:

```ts
import type { DatabaseService } from '@backstage/backend-plugin-api';

export interface BrunoConnectionRow {
  entityRef: string;    // column entity_ref (PK)
  githubUrl: string;    // github_url
  collectionId: string; // collection_id
  connectedBy: string;  // connected_by (userEntityRef)
  updatedAt: string;    // updated_at (ISO string)
}

export interface ConnectionStore {
  upsert(row: Omit<BrunoConnectionRow, 'updatedAt'>): Promise<void>;
  getByEntityRef(entityRef: string): Promise<BrunoConnectionRow | undefined>;
  delete(entityRef: string): Promise<void>;
}

export async function createConnectionStore(
  database: DatabaseService,
): Promise<ConnectionStore>;
```

Implementation:
- `const client = await database.getClient();`
- Ensure table (locked decision 1):
  ```ts
  if (!(await client.schema.hasTable('bruno_connections'))) {
    await client.schema.createTable('bruno_connections', table => {
      table.text('entity_ref').primary();
      table.text('github_url').notNullable();
      table.text('collection_id').notNullable();
      table.text('connected_by').notNullable();
      table.text('updated_at').notNullable();
    });
  }
  ```
- `upsert`: `client('bruno_connections').insert({ entity_ref, github_url, collection_id, connected_by, updated_at: new Date().toISOString() }).onConflict('entity_ref').merge()`.
- `getByEntityRef`: `client('bruno_connections').where({ entity_ref: entityRef }).first()` → map snake→camel (`rowToModel`), or `undefined`.
- `delete`: `client('bruno_connections').where({ entity_ref: entityRef }).delete()`.
- Keep small `rowToModel` helper; set `updated_at` in JS (avoid DB `now()`).

### 1.2 `plugins/bruno-backend/src/service/collectionService.ts`
Add (do NOT modify `parseCollection`, `buildTree`, `readLocalTree`, or any parser/helper):

- Imports: `import { ScmIntegrations, type ScmIntegrationRegistry } from '@backstage/integration';`, `import { Octokit } from '@octokit/rest';`, `import { createHash } from 'crypto';`.
- **Exports** `normalizeGithubUrl(url: string): string` and `collectionIdFromUrl(url: string): string` (algorithm in §3).
- Inside `createCollectionService` (after `const cache = ...` at :145): add
  ```ts
  const connectedCache = new Map<string, CachedCollection>();
  const integrations = ScmIntegrations.fromConfig(config);
  ```
- Extend the `CollectionService` interface (:93–97) and returned object (:200–216) with:
  ```ts
  connectFromUrl(input: { url: string; userToken?: string }):
    Promise<{ collectionId: string; detail: CollectionDetail }>;
  ```
  Implementation:
  ```ts
  const normalized = normalizeGithubUrl(input.url);
  const collectionId = collectionIdFromUrl(normalized);
  const tree = await readUrlTreeWithCreds(reader, integrations, normalized, logger, { userToken: input.userToken });
  const source: BrunoSourceConfig = { id: collectionId, name: collectionId, type: 'url', target: normalized };
  const collection = parseCollection(source, tree, logger);
  const requestCount = countRequests(collection.items);
  const detail: CachedCollection = { id: collectionId, name: collection.name, source: 'url', sourceUrl: normalized, requestCount, collection };
  connectedCache.set(collectionId, detail);
  return { collectionId, detail };
  ```
- Update `getCollection` (:212–214): `return cache.get(id) ?? connectedCache.get(id);`
- Leave `refresh` (:182–195) unchanged (it clears only `cache`; `connectedCache` survives — locked decision 3).
- **`readUrlTreeWithCreds`** (new sibling of `readUrlTree`; keep `readUrlTree` as the inner service fetch):
  ```ts
  async function readUrlTreeWithCreds(
    reader: UrlReaderService,
    integrations: ScmIntegrationRegistry,
    url: string,
    logger: LoggerService,
    opts?: { userToken?: string },
  ): Promise<FileTree> {
    try {
      return await readUrlTree(reader, url, logger);
    } catch (error) {
      if (opts?.userToken) {
        logger.info('Service reader failed; retrying with user OAuth token.');
        return await readUrlTreeViaOctokit(integrations, url, opts.userToken, logger);
      }
      throw error;
    }
  }
  ```
- **`readUrlTreeViaOctokit`** (new): parse `owner/repo/ref/subpath` from the normalized URL (support `/tree/<ref>/<subpath>` and bare `/owner/repo`); resolve `apiBaseUrl` via `integrations.github.byUrl(url)?.config.apiBaseUrl ?? 'https://api.github.com'`; `new Octokit({ auth: userToken, baseUrl: apiBaseUrl })`; if no ref, `repos.get` → `default_branch`; `git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' })`; for each `type==='blob'` entry whose path (relative to `subpath`) ends in `.bru` or `bruno.json`, `git.getBlob({ owner, repo, file_sha: sha })` → base64→utf8 → `files.set(relPath, text)` (strip `subpath` prefix so keys are collection-root-relative). Return `{ files }`. If `data.truncated`, `logger.warn(...)`. **Never** log/return/persist the token.

### 1.3 `plugins/bruno-backend/src/plugin.ts`
- Add to `deps` (:19–24): `database: coreServices.database`, `httpAuth: coreServices.httpAuth`, `userInfo: coreServices.userInfo`.
- Extend `init` destructure (:25) accordingly.
- After building `collectionService` (:26–30): `const connectionStore = await createConnectionStore(database);` (import it).
- Pass into `createRouter` (:32–34): `{ logger, config, collectionService, connectionStore, httpAuth, userInfo }`.
- Auth policy block (:40–47) unchanged (locked decision 7).

### 1.4 `plugins/bruno-backend/src/service/router.ts`
- Extend `RouterOptions` (:9–13): `connectionStore: ConnectionStore`, `httpAuth: HttpAuthService`, `userInfo: UserInfoService`.
- Imports: `import { InputError } from '@backstage/errors';`, `import type { HttpAuthService, UserInfoService } from '@backstage/backend-plugin-api';`, `import type { ConnectionStore } from '../store/connectionStore';`.
- Add three routes after `/collections/:id/docs` (before `/refresh`):
  - `POST /connections` — `const credentials = await httpAuth.credentials(req, { allow: ['user'] }); const { userEntityRef } = await userInfo.getUserInfo(credentials);` then read `{ entityRef, url, userGithubToken }` from `req.body` (`throw new InputError(...)` if `entityRef`/`url` missing); `const { collectionId, detail } = await collectionService.connectFromUrl({ url, userToken: userGithubToken });`; `await connectionStore.upsert({ entityRef, githubUrl: detail.sourceUrl!, collectionId, connectedBy: userEntityRef });`; `res.json({ collectionId, name: detail.name, requestCount: detail.requestCount });`. **Never echo `userGithubToken`.**
  - `GET /connections/:entityRef` — `await httpAuth.credentials(req, { allow: ['user'] });` `const row = await connectionStore.getByEntityRef(req.params.entityRef);` 404 if absent; else `res.json({ entityRef, collectionId, githubUrl, connectedBy, updatedAt })` (no token stored, so none can leak).
  - `DELETE /connections/:entityRef` — `await httpAuth.credentials(req, { allow: ['user'] });` `await connectionStore.delete(req.params.entityRef);` `res.status(204).end();`
- The existing `/collections/:id` + `/:id/docs` routes are unchanged but now also resolve connected ids via the shared `getCollection` (behavior extended by data, no code change).

### 1.5 `plugins/bruno-backend/package.json`
Add to `dependencies`: `"@backstage/integration": "^2.0.3"`, `"@octokit/rest": "^19.0.3"`. (No `knex` dep — locked decision 6.)

### 1.6 `plugins/bruno-backend/src/index.ts` / `module.ts`
No changes required. (`module.ts` builds its own service and never calls `connectFromUrl`; leaving `connectFromUrl` on the interface is harmless there.)

---

## 2. URL normalization + collection_id (precise)
`normalizeGithubUrl(input)`:
1. `const u = new URL(input.trim());`
2. `u.hostname = u.hostname.toLowerCase();`
3. Drop `u.hash` and `u.search`.
4. Collapse duplicate slashes in path; strip a single trailing slash (except root).
5. Keep `/tree/<branch>/<subpath>` as-is (identity — locked decision 4).
6. Return `` `${u.protocol}//${u.host}${normalizedPath}` `` (no query/hash/trailing slash).

`collectionIdFromUrl(input)`:
```ts
const normalized = normalizeGithubUrl(input);
return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
```
This id is the cache key and `:id` path param, so `GET /collections/:id` + `/:id/docs` serve connected collections with zero route changes.

---

## 3. Frontend contract this produces (for P3, not implemented here)
- `POST /connections` → `{ collectionId, name, requestCount }`
- `GET /connections/:entityRef` → `{ entityRef, collectionId, githubUrl, connectedBy, updatedAt }` or 404
- `DELETE /connections/:entityRef` → 204

---

## 4. Executor watch-list
1. **Never** log, return, or persist `userGithubToken`.
2. `onConflict('entity_ref').merge()` must work on both SQLite + Postgres (it does via Knex).
3. Check `git.getTree` `data.truncated` and warn.
4. `httpAuth.credentials({allow:['user']})` requires the P1 auth harness to issue user tokens; guest may not qualify — that is expected (connect needs a real session). Do not weaken the guard to accommodate guest.
5. Match existing error style; `throw new InputError`/`NotFoundError` flows through the existing `middleware.error()`.
6. Verify `plugins/bruno-backend` builds (`yarn workspace @usebruno/plugin-bruno-backend build`) — no tests.
