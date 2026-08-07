# N4-P1 — Linking & lifecycle UX (LOCKED plan)

Repo: /Users/vasharma05_bruno/Projects/usebruno-backstage · Branch: feat/next-steps-runtime-connect
Backstage 1.53 · Yarn 4. Feature code only in `plugins/bruno` (frontend) and `plugins/bruno-backend` (backend).
All line anchors read at HEAD of the four target files + their consumers.

Verified API facts:
- `githubAuthApiRef.getAccessToken(scope?, options?)` returns `Promise<string>`
  (`node_modules/@backstage/frontend-plugin-api/dist/index.d.ts:207`); `AuthRequestOptions.optional`
  at `:168`. With `{optional:true}` it resolves to `''` when there is no session (matches the
  existing `if (token)` guard in `useCollectionPicker.scan`).
- Backend `connectFromUrl` throws `InputError('No Bruno collection found at ...')` at
  `plugins/bruno-backend/src/service/collectionService.ts:317-319`; a genuinely missing repo makes
  `readUrlTreeWithCreds` (`:307`) throw (GitHub 404) before that.
- `BrunoClient.connect`/`discover` wrap all non-OK responses as
  `Error('Bruno backend request to <path> failed (<status>): <text>')`
  (`plugins/bruno/src/api/BrunoClient.ts:98-104`, `:120-126`). Errors are string-wrapped —
  classification must be a substring/status scan on that message.
- `collectionsStore.delete(collectionId)` ALREADY EXISTS
  (`plugins/bruno-backend/src/store/collectionsStore.ts:14`, impl `:75-79`). No store change needed.
- `connectedCache` is keyed by `collectionId` and is populated ONLY by `connectFromUrl`
  (`collectionService.ts:337-342`). `collectionIdFromUrl` is deterministic, so a repo that was both
  imported AND connected shares one `collectionId`. Deleting a purely-imported (never-connected) row
  therefore needs no eviction; but because the id can collide, the delete route SHOULD still call
  `evictConnected` defensively (see change 3, backend).

---

## Change 1 — Direct-connect a single collection

### 1a. Hook: `plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts`

The gesture invariant to preserve:
- `scan` (`:115`): FIRST await is `getAccessToken(['repo'], {optional:true})` (`:131`) — silent, no popup.
- `scanWithGithub` (`:154`): FIRST await of the handler is `getAccessToken(['repo'])` (`:163`) — popup.
- `link` (`:189`) / `linkWithGithub` (`:232`) unchanged in their await ordering.

Add an internal auto-link helper that connects a single discovered collection WITHOUT a new user
gesture, reusing the token already held for the current scan. It is invoked only from inside the
already-running `scan`/`scanWithGithub` async handlers, so it introduces no new first-await.

Edits:

1. Replace `resolveScan` (`:97-109`) so it returns the resolution decision instead of only setting
   state, and add an auto-link branch for exactly-one. New shape:
   - 0 collections -> `setState({status:'noCollections'})`, `setSelectedCollectionId('')`.
   - 1 collection -> `setSelectedCollectionId(c.collectionId)` then call
     `await autoLink(collections[0], token)` (do NOT set `'scanned'`; go straight to connecting).
   - >1 -> `setSelectedCollectionId('')`, `setState({status:'scanned', collections})` (dropdown path
     unchanged).
   `resolveScan` must accept the token it should reuse: change signature to
   `resolveScan(collections, token?: string)`. Callers pass the token they just fetched.

2. New private helper `autoLink(chosen: DiscoveredCollection, token?: string)`:
   - Sets `setState({status:'connecting'})`.
   - `const result = await brunoApi.connect(entityRef, chosen.githubUrl, token)`.
   - On success: `setState({status:'linked'})`, `emitConnectionChange(entityRef)`, `await onLinked(result)`.
   - On failure: mirror `link`'s catch (`:215-223`) — if `scanTokenRef.current` set -> classified
     error banner (change 4); else -> `setState({status:'needsGithubLink'})`.
   - `autoLink` runs INSIDE the `scan`/`scanWithGithub` try blocks, so `inFlight.current` is still
     true throughout; it must NOT toggle `inFlight` itself (the enclosing `finally` owns it).
   - It does NOT call `getAccessToken` — it uses the passed token only, preserving the first-await
     invariant. For the silent `scan` path the passed token is the `{optional:true}` token (possibly
     `undefined`); the backend connect then works for public repos and, if it needs auth, the catch
     falls to `needsGithubLink` exactly like today.

3. `scan` (`:130-147`): capture the resolved token in a local and pass it to `resolveScan`. Currently
   `token` is a local (`:131`); pass `token || undefined` into `resolveScan(result.collections, token || undefined)`.

4. `scanWithGithub` (`:171-174`): after `resolveScan`, pass the held `token`:
   `resolveScan(result.collections, token)`. Because the popup already happened as the first await
   (`:163`) and the token is in `scanTokenRef`, auto-linking the single result is within the same
   gesture-safe context — no second popup.

5. State machine: no NEW state values needed. Single-collection now transitions
   `scanning -> connecting -> linked` (or `-> needsGithubLink`/`error`), never dwelling on `scanned`.
   Multi stays `scanning -> scanned -> (LINK) -> connecting -> linked`.

6. `link` (`:189`) and the >1 path are untouched. `linkWithGithub` (`:232`) untouched (still reached
   only from `needsGithubLink`, which the single path can still enter via `autoLink`'s catch).

### 1b. Presentational: `CollectionPickerFields.tsx`

Currently the single-found summary is rendered at `:92-100` (`scanned && !multiple`). With change 1a
the hook no longer rests in `scanned` for a single collection, so that block becomes effectively
dead for the auto path but is HARMLESS — keep it for the multi=false transient (it won't render
because state jumps to `connecting`). The `busy` indicator (`:40-47`) already covers `connecting`
with "Connecting…". No structural change required here beyond change 4's banner. The `>1` dropdown
block (`:66-90`) is unchanged.

### 1c. Entry A: `BrunoCard.tsx`

Button block `:187-223`. Today: `needsGithubScan`->Connect GitHub; `scanned`->LINK; `needsGithubLink`
->Connect GitHub; else SCAN. With auto-link, the `scanned` branch now only fires for >1 (dropdown +
LINK) — correct as-is. No code change to the button ladder is required: the single-collection case
simply never reaches the `scanned` branch and shows the busy/linked UI from `CollectionPickerFields`.
The `SCAN` button label/handler (`:214-221`) stays; a single click now scans AND links.

Confirm no change needed: the `busy` derived flag (`:153-155`) already includes `connecting`, so the
SCAN button disables through the auto-link.

### 1d. Entry B: `LinkPanel.tsx`

Button block `:150-186` is structurally identical to BrunoCard's — same conclusion: no ladder change
needed; the `scanned` branch (`:159-167`) now only serves >1. The manual-URL picker and the separate
"imported collection" dropdown (`:202-257`) are untouched.

---

## Change 2 — Unlink from the dashboard

### 2a. `CollectionCard.tsx`

- Import `useApi` from `@backstage/core-plugin-api`, `brunoApiRef` from `../../api/BrunoApi`, and
  `emitConnectionChange` from `../../lib/connectionEvents` (currently only presentational; add these).
- Extend props (`:84-87`) with `onChanged?: () => void` (a single callback used by both Unlink and
  Delete). Keep `onRequestLink`.
- Linked (non-imported, non-stub) cards render inside the `actions` box next to `OpenAction`
  (`:129-141`, the `else`/`OpenAction` branch). Add an "Unlink" `Button variant="outlined" size="small"`
  shown only when `collection.linked && collection.entityRef`.
- Handler `onUnlink`:
  - `if (!collection.entityRef) return;`
  - Guard with a local `busy` state (`const [busy,setBusy]=useState(false)`), set true.
  - Optional lightest confirm: `if (!window.confirm('Unlink this collection from its entity?')) return;`
    RECOMMENDED — no extra component, correct, and matches POC weight.
  - `await brunoApi.disconnect(collection.entityRef)` (exists,
    `plugins/bruno/src/api/BrunoClient.ts:167`, DELETE /connections/:entityRef).
  - `emitConnectionChange(collection.entityRef)`.
  - `props.onChanged?.()` to bump the dashboard refreshKey.
  - catch -> surface via a small `Typography color="error"` inline (reuse `busy`/error local).

### 2b. `CollectionGrid.tsx`

Add `onChanged?: () => void` to props (`:6-9`) and thread it to `CollectionCard` (`:15-19`):
`<CollectionCard collection={collection} onRequestLink={onRequestLink} onChanged={onChanged} />`.

### 2c. `CollectionsTab.tsx`

`refreshKey` already exists (`:33`, bumped at `:135`). Pass a bump callback into the grid at `:127`:
`<CollectionGrid collections={filtered} onRequestLink={onRequestLink} onChanged={() => setRefreshKey(k => k + 1)} />`.
The existing `useEffect` (`:35-56`) already depends on `refreshKey`, so the dashboard re-fetches.

Prop threading (exact): `CollectionsTab.setRefreshKey` -> `CollectionGrid.onChanged` ->
`CollectionCard.onChanged`.

---

## Change 3 — Delete an unlinked (imported) collection

### 3a. Backend store — NO CHANGE
`collectionsStore.delete(collectionId)` already exists (`collectionsStore.ts:14`, impl `:75-79`,
`where({collection_id}).delete()`). Do not re-add.

### 3b. Backend route: `plugins/bruno-backend/src/service/router.ts`

Add `router.delete('/collections/imported/:id', ...)`. PLACEMENT: immediately AFTER the existing
`router.get('/collections/imported', ...)` (`:99-111`) and BEFORE `router.get('/collections/:id', ...)`
(`:113`). This preserves Express route ordering so `/collections/imported/:id` is not shadowed by
`/collections/:id`. (The GET imported route is already registered before `/:id`; place the delete in
that same block.)

Handler:
```
router.delete('/collections/imported/:id', async (req, res) => {
  await httpAuth.credentials(req, { allow: ['user'] });   // match POST /collections/import (:71)
  const id = req.params.id;
  await collectionsStore.delete(id);
  collectionService.evictConnected(id);                   // defensive: id may collide with a connected id
  res.status(204).end();
});
```
Auth: `httpAuth.credentials(req, { allow: ['user'] })` — same mode as `POST /collections/import`
(`:71`) and `POST /connections` (`:166`).

Note on `evictConnected`: for a purely-imported row it is a no-op (id not in `connectedCache`, whose
only writer is `connectFromUrl` at `:337`). We include it because `collectionIdFromUrl` is
deterministic, so an id could also correspond to a live connected cache entry; the call is safe and
idempotent (`collectionService.ts:470-472`). Document this in the route comment.

Also update the router doc-block header (`:33-45`) to list `DELETE /collections/imported/:id`.

### 3c. Frontend API: `plugins/bruno/src/api/BrunoApi.ts`

Add to the `BrunoApi` interface (near `getImportedCollections`, `:44-45`):
```
/** DELETE /collections/imported/:id — removes an imported-but-unlinked collection. */
deleteImportedCollection(collectionId: string): Promise<void>;
```
No new type re-exports needed.

### 3d. Frontend client: `plugins/bruno/src/api/BrunoClient.ts`

Add method mirroring `disconnect` (`:167-179`):
```
async deleteImportedCollection(collectionId: string): Promise<void> {
  const base = await this.baseUrl();
  const path = `/collections/imported/${encodeURIComponent(collectionId)}`;
  const res = await this.fetchApi.fetch(`${base}${path}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Bruno backend request to ${path} failed (${res.status}): ${text}`
    );
  }
}
```
Expect 204 (no body). Mirrors `disconnect`.

### 3e. Frontend UI: `CollectionCard.tsx`

On imported-stub cards (`isImportedStub`, `:92`, rendered at `:130-137`), add a "Delete" button next
to "Link". Handler `onDelete`:
- optional `window.confirm('Delete this imported collection?')`.
- `await brunoApi.deleteImportedCollection(collection.id)` (stub uses `collection.id`).
- `props.onChanged?.()` (same callback threaded in change 2; no `emitConnectionChange` since a stub
  has no entityRef).
- catch -> inline `Typography color="error"`.

---

## Change 4 — Repo-not-found → small friendly banner

### 4a. Error classifier (new helper)

Add `plugins/bruno/src/lib/linkErrors.ts` (new file in `lib/`, alongside `connectionEvents.ts`):
```
export type LinkErrorKind = 'notFound' | 'needsAuth' | 'other';

/** Classify a scan/link failure from its (string-wrapped) message. */
export function classifyLinkError(e: unknown): LinkErrorKind {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes('no bruno collection found') ||
      msg.includes('(404)') || msg.includes('not found')) {
    return 'notFound';
  }
  if (msg.includes('(401)') || msg.includes('(403)') ||
      msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'needsAuth';
  }
  return 'other';
}
```
Substring/status scan is sufficient given `BrunoClient` string-wraps status as `(<status>)`
(`BrunoClient.ts:100-102`, `:122-124`) and the backend message is
`No Bruno collection found at ...` (`collectionService.ts:318`).

### 4b. Hook wiring: `useCollectionPicker.ts`

Add a new state variant `{ status: 'notFound' }` to the `State` union (`:7-16`).

- `scan` catch (`:143-144`): today unconditionally sets `needsGithubScan`. Change to classify:
  ```
  } catch (e) {
    const kind = classifyLinkError(e);
    if (kind === 'notFound') setState({ status: 'notFound' });
    else setState({ status: 'needsGithubScan' });  // needsAuth/other -> Connect GitHub prompt
  }
  ```
  Rationale: a genuine 404 no longer misreports as "connect your GitHub account".
- `autoLink` catch (change 1) and `link` catch (`:215-223`): when `scanTokenRef.current` is set (we
  had a token and still failed), classify — `notFound` -> `setState({status:'notFound'})`; otherwise
  the existing `error`/`needsGithubLink` behavior. When no token, keep `needsGithubLink` (public
  fetch failed; auth is the likely fix) UNLESS the message is clearly `notFound`, in which case set
  `notFound`.
- `scanWithGithub` catch (`:175-179`) and `linkWithGithub` catch (`:276-280`): after a successful
  popup+token, a failure here is almost certainly not-found or genuine error. Classify: `notFound`
  -> `setState({status:'notFound'})`; else keep the existing `error` banner (message shown small).

Import `classifyLinkError` from `../../lib/linkErrors`.

### 4c. Presentational: `CollectionPickerFields.tsx`

Add a small `notFound` banner block alongside the existing ones (place after `needsGithubScan`
`:49-56`), matching the compact `variant="body2"` style:
```
{state.status === 'notFound' && (
  <Grid item xs={12}>
    <Typography variant="body2" color="textSecondary">
      No Bruno collection found in that repository. Check the URL, or confirm the
      repo contains a bruno.json / opencollection.yml.
    </Typography>
  </Grid>
)}
```
The existing `error` block (`:111-117`) already renders small (`variant="body2" color="error"`) — no
raw dump. Keep it for `other`. The `needsGithubScan` (`:49-56`) / `needsGithubLink` (`:102-109`)
copy stays for genuine auth cases.

Exact banner copy:
- notFound: "No Bruno collection found in that repository. Check the URL, or confirm the repo
  contains a bruno.json / opencollection.yml."
- needsAuth (existing needsGithubScan): "Couldn't access this repository with the portal's
  credentials. If it's private, connect your GitHub account to continue." (unchanged, `:52-53`).

### 4d. Buttons

BrunoCard `:187-223` and LinkPanel `:150-186`: for `notFound` no action button is needed — fall
through to the default SCAN button (else branch) so the user can correct the URL and re-scan. Since
`notFound` is not `needsGithubScan`/`scanned`/`needsGithubLink`, both ladders already render SCAN for
it. No ladder edit required; verify the else covers `notFound` (it does).

---

## Files touched (summary)

Frontend:
- `plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts` (changes 1, 4)
- `plugins/bruno/src/components/CollectionPicker/CollectionPickerFields.tsx` (changes 1 note, 4)
- `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx` (verify only; no ladder edit)
- `plugins/bruno/src/components/BrunoPage/LinkApi/LinkPanel.tsx` (verify only; no ladder edit)
- `plugins/bruno/src/components/BrunoPage/CollectionCard.tsx` (changes 2, 3)
- `plugins/bruno/src/components/BrunoPage/CollectionGrid.tsx` (change 2 threading)
- `plugins/bruno/src/components/BrunoPage/CollectionsTab.tsx` (change 2 threading)
- `plugins/bruno/src/api/BrunoApi.ts` (change 3)
- `plugins/bruno/src/api/BrunoClient.ts` (change 3)
- `plugins/bruno/src/lib/linkErrors.ts` (NEW, change 4)

Backend:
- `plugins/bruno-backend/src/service/router.ts` (change 3 route + doc-block)
- `plugins/bruno-backend/src/store/collectionsStore.ts` — NO CHANGE (delete already present)

---

## Risk list & mitigations

1. Gesture-safety regression (OAuth popup blocked). RISK: auto-linking after a scan could insert a
   `getAccessToken` that is no longer the first await. MITIGATION: `autoLink` NEVER calls
   `getAccessToken`; it reuses the token already fetched by `scan` (silent, first-await preserved) or
   `scanWithGithub` (popup already opened as first await `:163`). No new first-await introduced.

2. Route ordering / shadowing. RISK: `/collections/imported/:id` shadowed by `/collections/:id`.
   MITIGATION: register the DELETE immediately after `GET /collections/imported` (`:99-111`) and
   strictly before `GET /collections/:id` (`:113`).

3. Double-fetch / double-submit. RISK: auto-link firing twice, or Unlink/Delete racing. MITIGATION:
   `autoLink` runs inside the existing `inFlight.current` guard window of scan/scanWithGithub (the
   enclosing `finally` releases it once); CollectionCard uses a local `busy` state to disable
   Unlink/Delete during the request. Dashboard refresh is a single `setRefreshKey` bump.

4. Stale closures in refresh threading. RISK: `onChanged` capturing a stale `setRefreshKey`.
   MITIGATION: use the functional updater `setRefreshKey(k => k + 1)` (already the pattern at `:135`),
   which is closure-safe.

5. Cache staleness after imported delete. RISK: deleting an imported row leaves a stale
   `connectedCache` entry if the id collides with a connected collection. MITIGATION: the DELETE
   route calls `evictConnected(id)` defensively (idempotent, `collectionService.ts:470-472`).

6. Error misclassification. RISK: substring scan mislabels an auth failure as not-found or vice
   versa. MITIGATION: check `no bruno collection found`/`404`/`not found` first (unambiguous
   backend/HTTP signals), then `401`/`403`; anything else -> small generic `error` banner (never a
   raw dump). Copy for `notFound` never mentions GitHub auth, fixing the current misleading message.

No app tests added (per instructions).
