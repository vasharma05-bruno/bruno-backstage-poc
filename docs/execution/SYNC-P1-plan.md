# SYNC-P1 — "Sync" button (live re-pull → update backend cache) · LOCKED

Add a **Sync** action that live-re-pulls a collection's source from GitHub and
replaces the backend cache entry, on:
- (a) the **BrunoCard** entity card (connected state), and
- (b) the **dashboard CollectionCard** (linked, non-stub).

Reuse the existing optional-GitHub-token flow (`getAccessToken(['repo'], { optional: true })`
→ `x-bruno-github-token` header), exactly like connect/discover. Public repos
sync anonymously; private repos via the user's OAuth token.

## Backend — `plugins/bruno-backend/src/service/collectionService.ts`

1. **Interface** (`CollectionService`, after `connectFromUrl`, ~line 127) add:
   ```ts
   syncCollection(input: {
     id: string;
     url: string;
     userToken?: string;
   }): Promise<CollectionDetail>;
   ```

2. **Implementation** — add a named `async function syncCollection` alongside
   `connectFromUrl` (~line 301) and expose it in the returned object literal
   (near `connectFromUrl,` ~line 415). Reuse `connectFromUrl` for the
   fetch+parse+cache-write, then mirror into the static `cache` when the id
   lives there:
   ```ts
   async function syncCollection(input: {
     id: string;
     url: string;
     userToken?: string;
   }): Promise<CollectionDetail> {
     // Re-fetch + re-parse from GitHub. connectFromUrl refreshes connectedCache
     // under collectionIdFromUrl(url) — the same key runtime-connected
     // collections already use, so their cache is updated in place.
     const { detail } = await connectFromUrl({
       url: input.url,
       userToken: input.userToken
     });
     // A static/provider collection lives in `cache` under its own id (which
     // may differ from collectionIdFromUrl(url)); mirror the fresh parse so
     // getCollection(id) returns updated data.
     if (cache.has(input.id)) {
       const mirrored: CachedCollection = { ...detail, id: input.id };
       cache.set(input.id, mirrored);
       return mirrored;
     }
     return detail;
   }
   ```
   `connectFromUrl` keeps the manifest check (throws `InputError` if the source
   lost its `bruno.json`/`opencollection.yml`) — sync inherits it.

## Backend — `plugins/bruno-backend/src/service/router.ts`

3. Add `POST /collections/:id/sync` (register with the other `/collections`
   routes — method+specific-path make it unambiguous vs `GET /collections/:id`):
   ```ts
   router.post('/collections/:id/sync', async (req, res) => {
     await httpAuth.credentials(req, { allow: ['user'] });
     const id = req.params.id;
     const userToken = githubTokenFromHeader(req);
     // Resolve the GitHub source URL: a runtime connection row first, else the
     // cached collection's own sourceUrl. Local collections (no GitHub source)
     // cannot be synced.
     const rows = await connectionStore.listAll();
     const row = rows.find((r) => r.collectionId === id);
     const url = row?.githubUrl ?? collectionService.getCollection(id)?.sourceUrl;
     if (!url) {
       res
         .status(404)
         .json({ error: `No syncable GitHub source for collection: ${id}` });
       return;
     }
     const detail = await collectionService.syncCollection({ id, url, userToken });
     res.json({
       collectionId: id,
       name: detail.name,
       requestCount: detail.requestCount
     });
   });
   ```
4. Add the endpoint to the router doc-comment endpoint list.

## Shared API — `plugins/bruno/src/api/`

5. **BrunoApi.ts** add to the interface:
   ```ts
   /** POST /collections/:id/sync — live re-pull from GitHub, refresh the cache. */
   sync(collectionId: string, token?: string): Promise<ConnectResult>;
   ```
6. **BrunoClient.ts** implement `sync` mirroring `connect()`:
   POST to `` `${base}/collections/${encodeURIComponent(collectionId)}/sync` ``,
   set `GITHUB_TOKEN_HEADER` only when `token` is present (no JSON body), parse
   `ConnectResult`, same error handling as the other methods.

## Frontend — `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx`

7. Import `githubAuthApiRef` from `@backstage/core-plugin-api`; add
   `const githubAuth = useApi(githubAuthApiRef);`. Add component state
   `const [syncing, setSyncing] = useState(false);` and
   `const [syncError, setSyncError] = useState<string | undefined>();`.
8. `onSync` handler (guard with the existing `inFlight` ref):
   - `const token = (await githubAuth.getAccessToken(['repo'], { optional: true })) || undefined;`
   - `await brunoApi.sync(state.collectionId, token);`
   - re-fetch `const d = await brunoApi.getCollection(state.collectionId);` and
     `setState({ status: 'connected', detail: d, collectionId: state.collectionId, sourceUrl: state.sourceUrl });`
   - on error: `setSyncError(...)` (do NOT drop the connected view); clear it at
     the start of each sync. Toggle `setSyncing`.
9. In the `connected` render: always show a **Sync** button (MUI `Button`
   variant outlined, sentence-case "Sync" per N4-P2 theme, `disabled={syncing}`)
   — for BOTH the annotation case (currently has no action row → add a row with
   just Sync) and the runtime case (Sync alongside the existing Disconnect /
   Change collection, which stay gated on `!hasAnnotation`). Render `syncError`
   inline (`Typography color="error"`) when set. Reuse the existing
   `classes.actionRow` styling for the button row.

## Frontend — `plugins/bruno/src/components/BrunoPage/CollectionCard.tsx`

10. Import `githubAuthApiRef`; add `const githubAuth = useApi(githubAuthApiRef);`.
11. `onSync` handler mirroring `onUnlink` (reuse existing `busy`/`error` + `onChanged`):
    - `setBusy(true); setError(undefined);`
    - `const token = (await githubAuth.getAccessToken(['repo'], { optional: true })) || undefined;`
    - `await brunoApi.sync(collection.id, token); onChanged?.();`
    - catch → `setError(...)`; finally `setBusy(false)`.
12. Add a **Sync** button (variant outlined, size small, `disabled={busy}`) in
    the non-stub branch next to OPEN / Unlink, shown only when
    `collection.linked` (a connection row is guaranteed → syncable). Local
    samples (`linked:false`) and imported stubs get no Sync.

## No change needed

`CollectionGrid.tsx` / `CollectionsTab.tsx` — the `onChanged` → `refreshKey`
reload plumbing already exists (N4-P1). `types.ts` — reuse `ConnectResult`; no
new type or re-export.

## Gates (from repo root, before commit)

- `yarn tsc` → **0 errors** (source of truth).
- `yarn lint:bruno <changed plugin paths>` → clean (`:fix` for autofixable style).

## Verification (live, when practical)

- `curl -s -o /dev/null -w '%{http_code}' -X POST :7007/api/bruno/collections/x/sync`
  → **401** unauthenticated (wiring proof).
- Manual: Sync on a connected BrunoCard and a linked dashboard card → request
  count refreshes; a private repo re-pulls via the user's OAuth token.
