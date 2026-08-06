# N2-P1 — Verify-before-link + bulk connections read — Execution Plan (LOCKED)

> Backend-only (`plugins/bruno-backend`). No tests, no frontend, no processor (N2-P2), no dashboard (N2-P3), no discover (N2-P6). Minimal diff, match style.
>
> Orchestrator-validated: `connectFromUrl` is called ONLY from `router.ts:84` (so verify can't regress the provider/local/.bru paths); routes are POST `/connections`:75, GET `/connections/:entityRef`:103, DELETE:121; detectors `findBrunoJson`:585, `detectFormat`:603, `findOpenCollectionYml`:607; `@backstage/errors` NOT yet imported in collectionService.

## Locked decisions
1. **No-manifest → `InputError` (400)** (bad client input; matches the existing `InputError` on missing entityRef/url). 
2. Verify lives **only in `connectFromUrl`** — never in `parseCollection` (shared by the provider/local/.bru paths).
3. Bulk `GET /connections` allows **`['user','service']`** (processor calls it service-to-service).

## Edit 1 — verify-before-link (`collectionService.ts`)
- Add import: `import { InputError } from '@backstage/errors';`.
- In `connectFromUrl` (~:256), after `readUrlTreeWithCreds(...)` returns the tree and before building `source`/`parseCollection`:
  ```ts
  const hasManifest =
    findBrunoJson(tree) !== undefined || findOpenCollectionYml(tree) !== undefined;
  if (!hasManifest) {
    throw new InputError(
      `No Bruno collection found at ${normalized} (missing bruno.json / opencollection.yml)`
    );
  }
  ```
  (`normalized` = the already-normalized URL var in scope; detectors are module-scope, in scope here.) Runs before `connectedCache.set` and before the router's `upsert`, so a bad URL is neither cached nor stored.

## Edit 2 — `listAll()` on the store (`connectionStore.ts`)
- Interface (~:11-15): add `listAll(): Promise<BrunoConnectionRow[]>;`
- Impl (after `delete`, ~:79):
  ```ts
  async listAll(): Promise<BrunoConnectionRow[]> {
    const rows = await client('bruno_connections').select('*');
    return (rows as RawRow[]).map(rowToModel);
  }
  ```

## Edit 3 — bulk `GET /connections` route (`router.ts`)
- Insert **immediately before** `GET /connections/:entityRef` (~:103):
  ```ts
  router.get('/connections', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const rows = await connectionStore.listAll();
    res.json(
      rows.map(row => ({
        entityRef: row.entityRef,
        collectionId: row.collectionId,
        githubUrl: row.githubUrl,
        connectedBy: row.connectedBy,
        updatedAt: row.updatedAt
      }))
    );
  });
  ```
  Same per-row projection as the existing single-entity GET. No `plugin.ts` auth-policy change (`/connections` ≠ the unauthenticated `/collections`).

## Executor watch-list
1. Verify goes in `connectFromUrl` ONLY.
2. Bulk route registered before the `:entityRef` route; `allow:['user','service']`.
3. Build: `yarn workspace @usebruno/plugin-bruno-backend build`. No tests.
