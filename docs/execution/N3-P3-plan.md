# N3-P3 — Imported-collections model + Dashboard "Add collection" — Execution Plan (LOCKED)

> A third way to add collections (NEXT-STEPS-3 §5, Feature B): an **"Add collection"** button at the top-right of the Bruno page imports **one or more** collections from a GitHub repo into Backstage as **imported-but-unlinked** records. They surface on the Collections dashboard as unlinked cards with a **"Link"** action; linking to an API entity happens later on the Link subpage. **Locked decision D-B = a NEW `bruno_collections` table** keyed by `collection_id` (`collection_id` PK, `github_url`, `name`, `imported_by`, `updated_at`), separate from `bruno_connections` (which stays the collection↔entity LINK table). The "FK" from `bruno_connections.collection_id` → `bruno_collections.collection_id` is **logical only** — `bruno_connections.collection_id` already exists (`connectionStore.ts:6,22`), so **no column change** to `bruno_connections`.
>
> **This plan is SPLIT into two coherent commits — recommended (see "Phase split" below):**
> - **N3-P3a — backend model + import + dashboard-union** (`plugins/bruno-backend/src` only, plus the two frontend client methods so the frontend can compile against them). Live-boot check = the new `bruno_collections` table migrates and `POST /collections/import` + `GET /dashboard` (unioned) respond.
> - **N3-P3b — frontend Add-collection modal + Link-subpage reconcile** (`plugins/bruno/src` only). Depends on P3a's endpoints + client methods being on HEAD.
>
> The orchestrator prefers two coherent commits over one sprawling one, and P3a/P3b are cleanly separable: P3a is a self-contained backend/model change that boots and serves; P3b is pure UI on top of already-shipped endpoints. **No STOP condition** — every field the plan needs is derivable from existing code.
>
> **Verified against HEAD `c97914d`** ("N3-P5: render API Docs via OpenCollection iframe"). P1/P2/P4/P5 are ALREADY committed (router already has `evictConnected` on DELETE `router.ts:170-179` and the `/collections/:id/opencollection.yml` route `router.ts:79-86`; `collectionService` already has `rebuildConnected`/`evictConnected` and the ghost-drop/discover-cache logic). Facts verified against HEAD:
> - **`bruno_connections` schema** (`connectionStore.ts:41-49`): `entity_ref` (PK, `.text().primary()`), `github_url` notNullable, `collection_id` notNullable, `connected_by` notNullable, `updated_at` notNullable. All `table.text(...)`. **`collection_id` already present** → no change needed to make it the logical FK.
> - **`createTable` idiom** (`connectionStore.ts:41-57`): guarded by `if (!(await client.schema.hasTable('bruno_connections')))`, wrapped in `try/catch` that re-throws ONLY if `hasTable` is still false after the catch (tolerates a concurrent replica winning the race). **Idempotent.** The new store MUST mirror this idiom verbatim.
> - **`BrunoConnectionRow`** (`connectionStore.ts:3-9`): `{ entityRef, githubUrl, collectionId, connectedBy, updatedAt }`. `ConnectionStore` interface (`:11-16`): `upsert(Omit<Row,'updatedAt'>)`, `getByEntityRef`, `delete`, `listAll`. `upsert` uses `.onConflict('entity_ref').merge()` (`:69-70`) and stamps `updated_at: new Date().toISOString()` (`:67`).
> - **`getDashboard(links: BrunoConnectionRow[]): Dashboard`** (`collectionService.ts:455-494`): builds `byId = Map<string, CachedCollection>` from `cache.values()` (config) then `connectedCache.values()` (`.detail`), indexes `links` by `collectionId` into `linksByCollectionId`, then for each cached collection emits a `DashboardCollection` with `linked: link !== undefined` and `entityRef: link?.entityRef ?? api:default/${sanitizeName(c.id)}`. Stats: `linkedEntities: links.length`. **Imported-unlinked collections are in NEITHER cache today → they don't appear.** This is the gap P3a closes.
> - **Router** route list (`router.ts:25-37` docblock + handlers): `GET /health`, `/collections`, `/collections/:id`, `/collections/:id/docs`, `/collections/:id/opencollection.yml`, `/dashboard` (`:88-92`, `httpAuth.credentials(req,{allow:['user','service']})` then `connectionStore.listAll()` → `getDashboard(links)`), `POST /connections` (`:94-120`, `allow:['user']` + `userInfo.getUserInfo(credentials)` → `userEntityRef`), `POST /connections/discover` (`:122-136`, `allow:['user']`), `GET /connections` (`:138-150`), `GET /connections/:entityRef` (`:152-168`), `DELETE /connections/:entityRef` (`:170-179`), `POST /refresh` (`:182-185`). `createRouter` deps (`RouterOptions`, `:16-23`): `logger, config, collectionService, connectionStore, httpAuth, userInfo`.
> - **`collectionIdFromUrl(url)`** (`collectionService.ts:202-205`): `sha256(normalizeGithubUrl(url)).slice(0,16)`. Discover already stamps each candidate's `collectionId` this way (`:436`) and returns the fully-qualified `githubUrl` (`:437`). So import can trust the client-supplied `collectionId` OR re-derive — plan re-derives on the server (never trust client-computed ids).
> - **`plugin.ts`** wiring: `createConnectionStore(database)` at `:47`; deps already include `database` (`:26`) and `scheduler` (`:27`); `createRouter({...})` at `:62-71`. The new store is built here and passed to `createRouter`.
> - **`plugins/bruno-backend/src/index.ts:24-45`** re-exports the shared contract types (frontend reuses them). New public types (`ImportedCollection`, an `imported` flag on `DashboardCollection`) must be added to `types.ts` and this re-export block.
> - **Frontend**: `BrunoPage.tsx` renders a local `useState` tab bar (Collections | Link API) inside `<Content>` — **NO router**; the two tabs are `tab===0 ? <CollectionsTab/> : <LinkApiTab/>` (`BrunoPage.tsx:14-31`). `CollectionsTab` fetches `brunoApi.getDashboard()` once in a `useEffect` (`CollectionsTab.tsx:28-49`) and renders `<CollectionGrid collections={filtered}/>`. `CollectionCard` (`CollectionCard.tsx:84-129`) shows a `linked` chip + an `OpenAction` (deep-links to `/catalog/.../bruno-docs`). `useCollectionPicker` (`useCollectionPicker.ts:18-23`) has `mode?: 'single'` (declared, currently unused) and an `onLinked` callback — it is a **single-entity SCAN→pick→LINK** machine tightly coupled to `entityRef` + `brunoApi.connect`.
> - **Lint baseline (pre-existing, judge NEW errors only)** — `yarn lint:bruno` over the P3 paths at HEAD reports **5 errors on unchanged code**: `collectionService.ts:300` (operator-linebreak), `collectionService.ts:684` (indent-binary-ops), `router.ts:41` (operator-linebreak), `router.ts:142` (arrow-parens), `connectionStore.ts:43` (arrow-parens). `yarn tsc` = **0 errors** at HEAD.

## Phase split (recommended)

| Sub-phase | Scope | Files | Boot/gate check |
|---|---|---|---|
| **N3-P3a** | New `bruno_collections` store + `POST /collections/import` + `GET /collections/imported` + dashboard union + types + client methods | `store/collectionsStore.ts` (NEW), `plugin.ts`, `router.ts`, `collectionService.ts`, `types.ts`, `index.ts`, `api/BrunoApi.ts`, `api/BrunoClient.ts`, `api/types.ts` | table migrates on an existing DB; `POST /collections/import` returns 200; `GET /dashboard` includes imported-unlinked cards |
| **N3-P3b** | Add-collection button + modal (multi-select), dashboard imported card + "Link" deep-link, Link-subpage reconcile (imported dropdown) | `BrunoPage.tsx`, `CollectionsTab.tsx`, `CollectionCard.tsx`, new `AddCollectionModal/`, `LinkApiTab.tsx`, `LinkPanel.tsx` | button opens modal; scan→multi-select→import; imported cards appear unlinked; Link picks an imported collection |

**Rationale for the split:** P3a is a coherent, independently-bootable backend commit (migration + endpoints + dashboard-union) that the orchestrator's live-boot check can validate on its own. P3b is pure frontend that only makes sense once the endpoints exist. Bundling them makes one ~10-file commit that mixes a DB migration with three React surfaces — harder to review and to roll back. The two client methods (`api/`) ship in **P3a** so the frontend has a stable, compiling contract to build against in P3b.

---

## Locked decisions

- **D-B (given) — new `bruno_collections` table.** Keyed by `collection_id` (PK). Columns: `collection_id` (PK, text), `github_url` (text, notNullable), `name` (text, notNullable), `imported_by` (text, notNullable), `updated_at` (text, notNullable). No change to `bruno_connections`.
- **D1 — SECOND store module `store/collectionsStore.ts`, NOT extend `connectionStore.ts`.** Recommended: a separate `createCollectionsStore(database)` + `CollectionsStore` interface + `ImportedCollectionRow` type, mirroring `connectionStore.ts` verbatim (same `hasTable`-guarded idempotent `createTable`, same `rowToModel`, same `.onConflict(...).merge()` upsert). Rationale: `connectionStore.ts` is a tight, single-table module; a second table with a different PK and a different lifecycle (imported vs linked) belongs in its own module for the same "clean separation" the D-B table split buys. Extending `connectionStore.ts` would give it two unrelated schemas and two `createTable` blocks in one factory — avoid.
- **D2 — `CollectionsStore` interface:** `upsert(row: Omit<ImportedCollectionRow,'updatedAt'>): Promise<void>` (`.onConflict('collection_id').merge()`), `listAll(): Promise<ImportedCollectionRow[]>`, and `delete(collectionId: string): Promise<void>` (present for symmetry/future un-import; not wired to a route in P3). `getByCollectionId` is **not needed** by P3 (import is a blind upsert; dashboard reads `listAll`) — omit to keep the surface minimal. `ImportedCollectionRow = { collectionId, githubUrl, name, importedBy, updatedAt }`.
- **D3 — `getDashboard` gains a second arg: `getDashboard(links: BrunoConnectionRow[], imported: ImportedCollectionRow[]): Dashboard`.** The router passes `imported = await collectionsStore.listAll()`. Union order into `byId`: config `cache` → `connectedCache` → **imported** (imported entries are added ONLY if `byId` does not already have that `collection_id`). **Dedupe rule: keyed by `collection_id`.** A cached (config or connected) collection ALWAYS wins over an imported row (it has full parsed data — requestCount, envs; the imported row has only name/url). This means an imported collection that is later ALSO connected/config-materialized shows as a normal (full-data) card, not a stub.
- **D4 — imported-unlinked card representation.** New optional field `imported?: boolean` on `DashboardCollection` (and mirror in `api/types.ts`). An imported-only stub card sets `imported: true`, `linked: false`, `requestCount: 0`, `envCount: 0`, `specType: undefined`, and **`entityRef` LEFT UNDEFINED** (do NOT synthesize the `api:default/...` placeholder for a stub — a stub has no OPEN target; the frontend renders a **"Link"** action instead). A cached collection keeps today's behavior (`imported` unset/false). The dashboard `stats.collections` counts every card (cached + imported stubs); `stats.linkedEntities` stays `links.length` (unchanged).
- **D5 — `POST /collections/import`, `allow:['user']`, records `imported_by` via `userInfo`.** Mirrors `POST /connections` auth exactly (`router.ts:94-96`). Body: `{ collections: Array<{ githubUrl: string; name: string }> }` (the frontend sends the selected discovered candidates' `githubUrl` + `name`; **the server re-derives `collection_id` via `collectionIdFromUrl(githubUrl)`** — never trusts a client-computed id). Upserts each into `bruno_collections`. Response: `{ imported: number }` (count). Validates `collections` is a non-empty array (throw `InputError` otherwise, mirroring `:99,:126`).
- **D6 — LIST imported: a dedicated `GET /collections/imported`, `allow:['user','service']`, returns `ImportedCollection[]`** (mirrors the `/connections` list at `:138-150`). Rationale: the Link-subpage reconcile (P3b) needs the imported list independently of the dashboard aggregate, and the dashboard already gets the imported rows folded in via D3. Two consumers, two shapes — a thin list endpoint is cleaner than overloading `/dashboard`.
- **D7 — Route ORDERING (load-bearing).** `POST /collections/import` and `GET /collections/imported` are two-segment literal paths (`/collections/import`, `/collections/imported`) and MUST be registered **BEFORE** the one-segment param route `GET /collections/:id` (`router.ts:55`) — otherwise `:id` would greedily match `import`/`imported`. Express matches in registration order for same-method routes; the existing `/collections/:id/docs` and `/collections/:id/opencollection.yml` are safe because they are `:id` + a further literal segment, but `/collections/imported` is `/collections/<literal>` and WOULD be shadowed by `:id` if registered after it. **Register both new `/collections/*` routes immediately after `GET /collections` (`router.ts:53`) and before `GET /collections/:id` (`:55`).** Note the methods differ (`POST import` vs `GET :id`), so `import` is technically safe by method; but `GET /collections/imported` collides by method with `GET /collections/:id` — hence the ordering is mandatory. Put both together above `:id` for clarity.
- **D8 — frontend: dedicated `AddCollectionModal`, NOT a `'multi'` extension of `useCollectionPicker` (lower-risk, justified).** `useCollectionPicker` is a single-entity SCAN→pick→**LINK-to-entityRef** machine: every terminal path calls `brunoApi.connect(entityRef, ...)` and `emitConnectionChange(entityRef)`, and its whole gesture-safe OAuth choreography is built around one target entity. Import has **no entity**, needs **multi-select**, and ends in `brunoApi.importCollections(...)` not `connect`. Generalizing the hook to `'multi'` would fork nearly every branch (`link`, `linkWithGithub`, `resolveScan`, `onLinked`) on a mode flag — high blast-radius on a hook that BrunoCard + LinkPanel both depend on. Instead, the modal **reuses only the `discover` client call** (public silent-token → explicit "Connect GitHub" gesture, same two-step pattern, re-implemented locally in ~40 lines) + a checkbox list + `importCollections`. This keeps `useCollectionPicker` untouched (zero regression risk to P2's card/link picker). The `mode?: 'single'` seam is left as-is (still unused). Documented trade-off: a small amount of scan-choreography duplication vs. destabilizing the shared hook — the POC favors isolation.
- **D9 — Link deep-link is IN-PAGE state, not URL routing.** `BrunoPage` has no router — tabs are `useState`. So the imported card's **"Link"** action lifts the tab index + a `preselectImportedCollectionId` into `BrunoPage` state: clicking "Link" sets `tab = 1` (Link API) and passes the collection id down to `LinkApiTab`. No new route, no `useNavigate`. (A URL-param approach would require adding a router to BrunoPage — out of scope and heavier.)
- **D10 — Link-subpage reconcile = MINIMAL VERSION (a second "Link an imported collection" path), scope-flagged.** The just-refactored `LinkPanel` (P2) is a clean SCAN→pick→LINK-by-URL surface driven by `useCollectionPicker`. The full §5 vision (replace manual entry with an imported-collections dropdown) would rework that panel. **Minimal version:** ADD (not replace) a second affordance in `LinkPanel` — a dropdown/list of imported collections (from `GET /collections/imported`) with a **"Link this collection"** button that calls `brunoApi.connect(selectedEntityRef, imported.githubUrl)` directly (no scan — the imported row already carries the fully-qualified `githubUrl`). The existing manual-URL SCAN path stays as the "import + link in one step" shortcut (§5 note). When P3b's deep-link (D9) preselects an imported collection, the dropdown opens with it pre-chosen. **Scope flag:** this is additive and small (~1 client call + a dropdown + a connect button); it does NOT touch `useCollectionPicker`. If even this proves large during execution, the fallback is to ship the imported dropdown as a THIRD panel/section under the Link tab rather than inside `LinkPanel` — but the minimal in-panel version is preferred and expected to be small.
- **D11 — Add-collection button placement.** Top-right of the Bruno page. Since `BrunoPage` renders a `<Content>` with a `<Tabs>` bar and the PageLayout owns the `<Header>`, put the button on the **Collections tab header row** (top-right, in a flex row above the stat tiles in `CollectionsTab`) OR lifted to `BrunoPage` beside the Tabs. **Decision: place it in `CollectionsTab`** (top-right of the tab body, a flex row wrapping the existing search box area) — it is contextually a Collections-tab action and avoids threading modal state through `BrunoPage`. The modal's `onImported` callback triggers a dashboard re-fetch (bump the existing effect's dep or add a `refreshKey`).
- **D12 — Never log tokens/secrets; `import type` for type-only; leading-`|`/`=` unions; `@stylistic/arrow-parens` = parens around single arrow args.** The import route logs nothing sensitive (at most the count + `imported_by` user ref, which is already public). The store never logs.

---

## N3-P3a — Backend edits

### `plugins/bruno-backend/src/store/collectionsStore.ts` (NEW)
Mirror `connectionStore.ts` structure verbatim (idempotent `hasTable`-guarded `createTable`, `rowToModel`, factory). `import type { DatabaseService } from '@backstage/backend-plugin-api';`

```ts
export interface ImportedCollectionRow {
  collectionId: string;
  githubUrl: string;
  name: string;
  importedBy: string;
  updatedAt: string;
}

export interface CollectionsStore {
  upsert(row: Omit<ImportedCollectionRow, 'updatedAt'>): Promise<void>;
  listAll(): Promise<ImportedCollectionRow[]>;
  delete(collectionId: string): Promise<void>;
}

type RawRow = {
  collection_id: string;
  github_url: string;
  name: string;
  imported_by: string;
  updated_at: string;
};
```
- `rowToModel(row)` → `{ collectionId, githubUrl, name, importedBy, updatedAt }`.
- `createCollectionsStore(database)`: `const client = await database.getClient();` then the SAME guarded/try-catch `createTable('bruno_collections', table => { table.text('collection_id').primary(); table.text('github_url').notNullable(); table.text('name').notNullable(); table.text('imported_by').notNullable(); table.text('updated_at').notNullable(); })` idiom as `connectionStore.ts:41-57` (re-check `hasTable` in the catch, re-throw only if still absent).
- `upsert`: `.insert({ collection_id, github_url, name, imported_by, updated_at: new Date().toISOString() }).onConflict('collection_id').merge()`.
- `listAll`: `select('*')` → `map(rowToModel)`.
- `delete`: `.where({ collection_id }).delete()`.
- Lint note: the `.map(rowToModel)` and any single-arg arrow MUST use parens (`row => ...` is what the baseline flags at `connectionStore.ts:43`; write `(row) => ...` in NEW code to stay clean).

### `plugins/bruno-backend/src/types.ts`
- Add `imported?: boolean;` to `DashboardCollection` (`:156-165`, after `entityRef`). Docblock: "True for a collection imported (§5) but not yet materialized/connected — a stub card with a Link action."
- Add a new exported interface (near `DashboardCollection` or after `ConnectionRecord`-analog types):
  ```ts
  /** An imported-but-unlinked collection (GET /collections/imported). */
  export interface ImportedCollection {
    collectionId: string;
    name: string;
    githubUrl: string;
    importedBy: string;
    updatedAt: string;
  }
  ```

### `plugins/bruno-backend/src/service/collectionService.ts`
- `import type { ImportedCollectionRow } from '../store/collectionsStore';` (add beside the existing `import type { BrunoConnectionRow } from '../store/connectionStore';` at `:42`).
- **Interface** (`:129`): change to `getDashboard(links: BrunoConnectionRow[], imported: ImportedCollectionRow[]): Dashboard;`.
- **`getDashboard` impl** (`:455-494`): add the `imported` param; after the two existing `byId` loops (config `cache` `:457-459`, `connectedCache` `:460-462`), add:
  ```ts
  for (const row of imported) {
    if (!byId.has(row.collectionId)) {
      importedStubs.set(row.collectionId, row);
    }
  }
  ```
  Then, after the existing `for (const c of byId.values())` card loop (`:470-483`), append imported stubs (those NOT in `byId`) as stub cards:
  ```ts
  for (const row of importedStubs.values()) {
    collections.push({
      id: row.collectionId,
      name: row.name,
      requestCount: 0,
      envCount: 0,
      specType: undefined,
      linked: false,
      imported: true
      // entityRef intentionally omitted for stubs (D4)
    });
  }
  ```
  (Declare `const importedStubs = new Map<string, ImportedCollectionRow>();` alongside `byId`. `linkedEntities: links.length` and `totalRequests` are unchanged — stubs add 0.) **Watch:** the existing cards set `entityRef: link?.entityRef ?? api:default/${sanitizeName(c.id)}` — leave that path exactly as-is; ONLY the new stub branch omits `entityRef`.

### `plugins/bruno-backend/src/service/router.ts`
- `import type { CollectionsStore } from '../store/collectionsStore';` (beside the `ConnectionStore` type import at `:12`).
- Add `collectionsStore: CollectionsStore;` to `RouterOptions` (`:16-23`) and destructure it (`:41-42`).
- Update the route-list docblock (`:25-37`) to add the two new routes.
- **New routes, registered immediately after `GET /collections` (`:53`) and BEFORE `GET /collections/:id` (`:55`)** (D7 ordering — mandatory):
  ```ts
  router.post('/collections/import', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef } = await userInfo.getUserInfo(credentials);
    const { collections } = req.body ?? {};
    if (!Array.isArray(collections) || collections.length === 0) {
      throw new InputError('`collections` must be a non-empty array.');
    }
    let count = 0;
    for (const c of collections) {
      if (!c?.githubUrl || !c?.name) {
        throw new InputError('Each collection needs `githubUrl` and `name`.');
      }
      await collectionsStore.upsert({
        collectionId: collectionIdFromUrl(c.githubUrl),
        githubUrl: c.githubUrl,
        name: c.name,
        importedBy: userEntityRef
      });
      count += 1;
    }
    res.json({ imported: count });
  });

  router.get('/collections/imported', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const rows = await collectionsStore.listAll();
    res.json(
      rows.map((row) => ({
        collectionId: row.collectionId,
        name: row.name,
        githubUrl: row.githubUrl,
        importedBy: row.importedBy,
        updatedAt: row.updatedAt
      }))
    );
  });
  ```
  Add `import { collectionIdFromUrl } from './collectionService';` — verify it is exported (`collectionService.ts:202` `export function collectionIdFromUrl`). It is.
- **`GET /dashboard`** (`:88-92`): pass imported rows:
  ```ts
  const links = await connectionStore.listAll();
  const imported = await collectionsStore.listAll();
  res.json(collectionService.getDashboard(links, imported));
  ```

### `plugins/bruno-backend/src/plugin.ts`
- `import { createCollectionsStore } from './store/collectionsStore';` (beside `createConnectionStore` at `:8`).
- After `const connectionStore = await createConnectionStore(database);` (`:47`): `const collectionsStore = await createCollectionsStore(database);`.
- Add `collectionsStore` to the `createRouter({...})` call (`:62-71`).
- (No new dep; `database` already in `deps`.)

### `plugins/bruno-backend/src/index.ts`
- Add `ImportedCollection` to the re-exported type block (`:24-45`, keep alphabetical).

### `plugins/bruno/src/api/types.ts` (frontend contract — ships in P3a)
- Add `imported?: boolean;` to `DashboardCollection` (`:162-171`, after `entityRef`).
- Add:
  ```ts
  /** GET /collections/imported response entry. */
  export interface ImportedCollection {
    collectionId: string;
    name: string;
    githubUrl: string;
    importedBy: string;
    updatedAt: string;
  }
  ```

### `plugins/bruno/src/api/BrunoApi.ts`
Add to the `BrunoApi` interface (after `getDashboard`, `:35`), with `import type { ImportedCollection } from './types';` added to the type import block (`:2-9`):
```ts
/** POST /collections/import — import one or more collections (unlinked). */
importCollections(
  collections: Array<{ githubUrl: string; name: string }>
): Promise<{ imported: number }>;
/** GET /collections/imported — imported-but-unlinked collections. */
getImportedCollections(): Promise<ImportedCollection[]>;
```

### `plugins/bruno/src/api/BrunoClient.ts`
Add `ImportedCollection` to the type import block (`:3-10`) and two methods mirroring the existing style (`connect` for POST error-handling, `getJson` for the GET):
```ts
async importCollections(
  collections: Array<{ githubUrl: string; name: string }>
): Promise<{ imported: number }> {
  const base = await this.baseUrl();
  const res = await this.fetchApi.fetch(`${base}/collections/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Bruno backend request to /collections/import failed (${res.status}): ${text}`
    );
  }
  return (await res.json()) as { imported: number };
}

async getImportedCollections(): Promise<ImportedCollection[]> {
  return this.getJson<ImportedCollection[]>('/collections/imported');
}
```

---

## N3-P3b — Frontend edits

### `plugins/bruno/src/components/BrunoPage/AddCollectionModal/` (NEW)
A dedicated modal (D8) reusing only `brunoApi.discover` + `brunoApi.importCollections`. Files:
- `AddCollectionModal.tsx` — a MUI `Dialog` with: a GitHub URL `TextField`, a **Scan** button, a busy/`Progress` state, an error line, and on scan-success a **checkbox list** of `DiscoveredCollection` (name + `collectionPath || '(root)'` + `requestCount`) with a **"Select all"** checkbox, plus an **Import selected** button (disabled until ≥1 checked). Scan uses the same silent-token → explicit "Connect GitHub" two-step as `useCollectionPicker.scan/scanWithGithub` (`useApi(githubAuthApiRef)`, `getAccessToken(['repo'], { optional: true })` first; on catch show a "Connect GitHub" button whose handler makes `getAccessToken(['repo'])` its FIRST await). Import calls `brunoApi.importCollections(selected.map((c) => ({ githubUrl: c.githubUrl, name: c.name })))`, then calls the `onImported()` prop and closes. Props: `{ open: boolean; onClose: () => void; onImported: () => void }`.
- `index.ts` — `export { AddCollectionModal } from './AddCollectionModal';`.
- Reuse `validateUrl`-equivalent inline (mirror `useCollectionPicker.ts:75-93`) or a light check; keep it small.
- **Never log the token.** Keep the token in a local `useRef`/local var; never `console.log`.

### `plugins/bruno/src/components/BrunoPage/CollectionsTab.tsx`
- Add an **"Add collection"** button top-right (D11): a flex row above/around the search box (`Box` with `display:flex, justifyContent:space-between`), button `variant="contained"` opening the modal (`const [addOpen, setAddOpen] = useState(false)`).
- Add a `refreshKey` state; include it in the `useEffect` dep array (`:49`) so `onImported` can re-fetch the dashboard (`setRefreshKey((k) => k + 1)`).
- Render `<AddCollectionModal open={addOpen} onClose={() => setAddOpen(false)} onImported={() => { setAddOpen(false); setRefreshKey((k) => k + 1); }} />`.
- **Link deep-link plumbing (D9):** `CollectionsTab` receives `onRequestLink?: (collectionId: string) => void` from `BrunoPage`; pass it down to `CollectionGrid` → `CollectionCard`. (See BrunoPage change.)

### `plugins/bruno/src/components/BrunoPage/CollectionGrid.tsx`
- Thread an optional `onRequestLink?: (collectionId: string) => void` prop through to each `CollectionCard`.

### `plugins/bruno/src/components/BrunoPage/CollectionCard.tsx`
- When `collection.imported && !collection.linked`: render a **"Link"** button (contained, small) instead of the `OpenAction`, calling `props.onRequestLink?.(collection.id)`. Show an "imported" chip (e.g. a neutral/secondary `Chip label="imported"`). Keep the existing `linked` chip + `OpenAction` for non-stub cards.
- Add optional prop `onRequestLink?: (collectionId: string) => void`.

### `plugins/bruno/src/components/BrunoPage/BrunoPage.tsx`
- Lift `tab` (already local) + a new `preselectImported` state (`useState<string | undefined>()`).
- Pass `onRequestLink={(id) => { setPreselectImported(id); setTab(1); }}` to `<CollectionsTab/>`.
- Pass `preselectImportedCollectionId={preselectImported}` to `<LinkApiTab/>`; clear it after consumption (LinkApiTab calls back, or BrunoPage clears on tab change).

### `plugins/bruno/src/components/BrunoPage/LinkApi/LinkApiTab.tsx`
- Accept `preselectImportedCollectionId?: string` and thread it into `<LinkPanel/>`.

### `plugins/bruno/src/components/BrunoPage/LinkApi/LinkPanel.tsx` (D10 — minimal, additive)
- Add a second section under the existing SCAN-by-URL panel: **"Link an already-imported collection"**. On mount (or when `selectedRef` set), fetch `brunoApi.getImportedCollections()` into local state; render a `TextField select` dropdown (like `CollectionPickerFields`'s multi dropdown) of imported collections (`name` + short url). A **"Link this collection"** button calls `brunoApi.connect(selectedRef, chosen.githubUrl, token?)` (silent-token first, same two-step), then `emitConnectionChange(selectedRef)` + `onLinked()`.
- If `preselectImportedCollectionId` is set, pre-select that entry in the dropdown.
- **Do NOT touch `useCollectionPicker`.** This section owns its own tiny connect flow (reuse the silent-token pattern inline, ~30 lines) OR — simpler — reuse `brunoApi.connect` with a silent `getAccessToken(['repo'],{optional:true})`. Keep the existing picker path unchanged.

---

## Executor watch-list
1. **Route ordering (D7) is load-bearing.** `GET /collections/imported` collides by method+prefix with `GET /collections/:id`; register BOTH new `/collections/*` routes **before** `router.ts:55`. Verify by hitting `GET /collections/imported` and confirming it does NOT 404 as "Unknown collection: imported".
2. **`getDashboard` signature changes to two args** — every caller must update. Only caller is `router.ts:91` (`GET /dashboard`). `grep -n getDashboard` after editing: the interface (`:129`), the impl (`:455`), and the router call must all match `(links, imported)`.
3. **Dedupe by `collection_id` (D3):** imported rows are added to the card list ONLY when NOT already in `byId` (config/connected win). Never emit two cards for one `collection_id`.
4. **Stub cards omit `entityRef` (D4)** — do NOT synthesize `api:default/...` for imported stubs (that placeholder is only for cached-but-unlinked cards). The frontend keys the "Link" vs "OPEN" action on `imported && !linked`.
5. **Server re-derives `collection_id`** via `collectionIdFromUrl(githubUrl)` in the import route — never trust a client id. `collectionIdFromUrl` is exported from `collectionService.ts:202`.
6. **`import type` for the new row/collection types** in `collectionService.ts` and `router.ts`. Leading-`|` unions; single-arg arrows get parens (`(row) => ...`) — the baseline already flags bare `row =>` at `connectionStore.ts:43`, so NEW code must use parens.
7. **New store mirrors the idempotent idiom** (`hasTable` guard + try/catch re-check). Do NOT create the table unconditionally.
8. **Never log tokens.** The Add-collection modal + LinkPanel imported-path hold the OAuth token locally; no `console.log`. The import route logs at most the count.
9. **`useCollectionPicker` is UNTOUCHED** in both P3a and P3b (D8/D10). Confirm no edits to `useCollectionPicker.ts` / `CollectionPickerFields.tsx`.
10. **BrunoPage has no router** — the Link deep-link is in-page tab state (D9), not `useNavigate`.
11. **Frontend/backend `DashboardCollection` + `ImportedCollection` must stay in sync** across `plugins/bruno-backend/src/types.ts`, `plugins/bruno-backend/src/index.ts` (re-export), and `plugins/bruno/src/api/types.ts`.
12. **P3a ships the client methods** so P3b compiles; but P3a's frontend `api/*` changes are type/method-only (no UI) — they compile independently.

## Risks
- **R-A — migration on an existing DB with live rows.** `bruno_collections` is a NEW additive table; `bruno_connections` is untouched (no ALTER). The `hasTable`-guarded `createTable` is idempotent and safe on a populated DB — first boot creates it, subsequent boots skip. Zero risk to existing `bruno_connections` rows. Live-boot check: confirm the table appears and existing connections still load.
- **R-B — dedupe correctness.** If a collection is imported AND later connected/config-materialized, both a `bruno_collections` row and a cache entry exist for the same `collection_id`. D3 makes the cache win (full data), so no double card. If the import row's `github_url` differs trivially (e.g. trailing slash) from the connected URL, `collectionIdFromUrl`/`normalizeGithubUrl` collapse them (normalizer strips trailing slash, lowercases host) → same id → deduped. Verify with a repo imported then connected.
- **R-C — scope of the Link reconcile (D10).** Kept minimal (additive dropdown + a direct `connect`; no picker rework). If it grows, fall back to a separate section rather than restructuring `LinkPanel`. Flagged; expected small.
- **R-D — stub card has no requestCount/envs.** An imported-only card shows `0 requests / 0 envs` until it is connected/refreshed (it was never fetched, only its URL+name were stored). This is intentional (import ≠ fetch-and-parse) but the UI should read as a "pending/import" stub, not a broken card. Mitigation: the "imported" chip + "Link" action communicate the state.
- **R-E — private-repo scan in the modal.** Same as the card/link picker: needs a user OAuth token. The modal reuses the silent→explicit two-step; a private repo with no session shows "Connect GitHub". Import itself needs no token (it only stores name+url; it does NOT fetch). So a user can import a private collection's URL even without connecting GitHub — but the dashboard stub stays at 0 requests until a later connect (with creds) fetches it. Acceptable for the POC; note it.
- **R-F — `imported` field additive to `DashboardCollection`.** Optional, defaults undefined → existing cards unaffected; older frontend ignoring it still works. No breaking change.

## Gates (authoritative — NOT backstage-cli build)
```
yarn tsc                                                                              # 0 errors, repo-level
# P3a:
yarn lint:bruno plugins/bruno-backend/src plugins/bruno/src/api                       # NEW code clean
# P3b:
yarn lint:bruno plugins/bruno/src/components/BrunoPage                                 # NEW code clean
```
**Baseline note (judge NEW errors only):** the pre-existing style baseline over the P3 paths already reports **5 errors on unchanged files**: `collectionService.ts:300` (operator-linebreak), `collectionService.ts:684` (indent-binary-ops), `router.ts:41` (operator-linebreak), `router.ts:142` (arrow-parens), `connectionStore.ts:43` (arrow-parens). NEW code (`collectionsStore.ts`, the new router routes, the `getDashboard` union edit, the new types, the client methods, the AddCollectionModal, the CollectionCard/Grid/Tab/BrunoPage/LinkPanel edits) must introduce **zero new errors**. No tests. One new file per store; no new heavy deps.

**Commit:** one phase = one commit each (P3a, then P3b). The orchestrator runs gates + a live-boot check (DB migration of `bruno_collections` + `POST /collections/import` / `GET /collections/imported` / unioned `GET /dashboard`) and commits.
