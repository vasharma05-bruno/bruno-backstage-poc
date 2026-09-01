# UI-P6 — Submitting modal 1 creates the collection — **LOCKED**

**The bug.** `plugins/bruno/src/components/AddCollection/AddCollectionAction.tsx:67-72` — `onSubmit` only calls `setGenerated({ input, yaml: toCatalogInfoYaml(buildBrunoEntity(input)) })`. Nothing is created. The only path to a catalog entity is `catalogImportApi.submitPullRequest` at `GeneratedYamlDialog.tsx:279-284`, and even a merged PR produces a file that nobody has registered as a catalog location. A user can complete the entire flow and own nothing.

**Required behaviour.** Submitting modal 1 creates the Bruno entity. Modal 2 shows the generated `catalog-info.yaml` with Download and "Create pull request" both **optional** — closing modal 2 leaves the user with their collection.

**Approach (LOCKED — do not re-litigate).** Backstage has no insert-an-entity API. Entities come from a Location (a descriptor that must already exist) or an EntityProvider. `BrunoCollectionEntityProvider` already materialises a `kind: Bruno` entity from nothing but a folder URL. Give it a second, mutable source: UI-created collections persisted in the `bruno` backend plugin, read service-to-service.

**Standing constraints.** POC only — SSRF/IDOR documented in comments, not fixed. No tests. Never log a user or service token; never touch `.env`. Gates: `yarn tsc` 0 errors; `yarn lint:bruno plugins/bruno/src plugins/bruno-backend/src` 0 errors (the 5 pre-existing `no-explicit-any` warnings in `plugins/bruno-backend/src/types/*.d.ts` are expected — do NOT fix them). `yarn prettier:check` is red at baseline and structurally unsatisfiable — ignore it. Style: MUI v4 one-import-per-path, `import type` for type-only imports (`eslint.config.mjs:115` — `@typescript-eslint/consistent-type-imports`), staged-state discriminated unions in dialogs, heavy docblocks explaining WHY and what the alternative would have broken.

---

## 0. Coordinator amendments (read before §1 — these override the agent draft)

- **A1 — §4.6 case 3 is LOCKED, not a deviation awaiting a ruling.** The brief's literal wording ("on fetch failure, emit the config entries alone") is wrong and would destroy user data; `return` before `applyMutation` is the required behaviour. Open question Q3 is **closed** in favour of the skip. Do not implement the literal wording.
- **A2 — Q8 is RESOLVED.** `Action.hidden?: boolean` is verified at `node_modules/@material-table/core/types/index.d.ts:145`. Use the per-row `hidden` form in §5.6. Do not implement the `disabled` + tooltip fallback.
- **A3 — F1 and F2 independently verified by the coordinator** against `DefaultProviderDatabase.cjs.js:214` and `checkLocationKeyConflict.cjs.js:3-14`. Treat them as settled facts.
- **A4 — two stale-copy fixes are IN SCOPE for this phase**, because this phase is what makes them false: `BrunoApi.ts:63-65` (claims the backend still exposes `/connections`, `/dashboard`, `/collections/*` — removed in the teardown at `34f1960`) and `GeneratedYamlDialog.tsx:364-368` ("Nothing has been added to the catalog yet"). Both are already covered by §5.1 and §5.5; this note exists so they are not deferred as unrelated cleanup.

---

## 1. Platform facts (verified against HEAD and the installed `.d.ts` — do not re-derive)

**F1 — a `full` mutation deletes by set difference.**
`node_modules/@backstage/plugin-catalog-backend/dist/database/DefaultProviderDatabase.cjs.js:214`:
```js
const toRemove = oldRefs.map((row) => row.target_entity_ref).filter((ref) => !newRefsSet.has(ref));
```
`oldRefs` (`:188-196`) is every `refresh_state_references` row for this provider's `source_key`. `toRemove` is then passed to `deleteWithEagerPruningOfChildren` at `:47-52`. **An `applyMutation({ type: 'full', entities: [] })` removes every entity the provider has ever emitted.** This is the hazard §4 exists to prevent.

**F2 — `refresh_state` holds ONE `location_key` per `entity_ref`; first writer wins.**
- `operations/refreshState/updateUnprocessedEntity.cjs.js:18-23` — the UPDATE is guarded by `.where('location_key', locationKey).orWhereNull('location_key')`, so a differing key updates 0 rows and returns `false`.
- `operations/refreshState/insertUnprocessedEntity.cjs.js:12-26` — the INSERT then hits the unique `entity_ref` and returns `false`.
- `operations/refreshState/checkLocationKeyConflict.cjs.js:3-14` — returns the incumbent key.
- Provider path: `DefaultProviderDatabase.cjs.js:95` deletes the LOSER's own `refresh_state_references` row, then `:130-134` logs `Source <sourceKey> detected conflicting entityRef <ref> already referenced by <existingKey> and now also <newKey>`.
- Location/processor path: `DefaultProcessingDatabase.cjs.js:226-246` — same check, logs `Detected conflicting entityRef …` at `:233` and publishes on `CATALOG_CONFLICTS_TOPIC` (`dist/constants.cjs.js:3` -> `"experimental.catalog.conflict"`).

**F3 — a Location-emitted entity's `locationKey` is its location ref.**
`dist/processing/ProcessorOutputCollector.cjs.js:84` — `const locationKey = i.locationKey === void 0 ? location : i.locationKey ?? void 0;`. So a merged `catalog-info.yaml` registered as a location claims `url:https://…/catalog-info.yaml`, which can never equal our provider's `bruno-collection:bruno-collection-provider` (`BrunoCollectionEntityProvider.ts:19,147`). Consequence in §9 Q1.

**F4 — `deriveOrigin` preserves a declared origin.**
`plugins/bruno-backend/src/processor/BrunoKindProcessor.ts:78-84` returns the declared `usebruno.com/origin` unchanged when it is one of `ORIGINS` (`:62` — `['descriptor','config','ui','file']`). This is precisely what makes the provider stamping `'ui'` survive every reprocess cycle. `ORIGIN_ANNOTATION` is `:48`; `BrunoOrigin` is exported at `:60`.

**F5 — the frontend origin gate already exists.**
`plugins/bruno/src/lib/brunoEntity.ts:175-196` — `collectionOrigin(entity)` reads `BRUNO_ORIGIN_ANNOTATION` (`:158`) first, then falls back to the location-annotation shape (`:181-195`). The fallback can return `'descriptor' | 'config' | 'file' | 'unknown'` but **never `'ui'`** — `'ui'` is reachable only from a stamped annotation. The delete affordance is therefore fail-safe by construction.

**F6 — services and APIs that exist.**
`coreServices.database` `node_modules/@backstage/backend-plugin-api/dist/index.d.ts:1584`; `coreServices.auth` `:1544`; `coreServices.discovery` `:1594`. `DatabaseService.getClient(): Promise<Knex>` `:346-364`. `AuthService.getPluginRequestToken({onBehalfOf, targetPluginId})` `:242-260`; `getOwnServiceCredentials()` `:232`. `HttpAuthService.credentials<TAllowed>(req, {allow})` returns `Promise<BackstageCredentials<BackstagePrincipalTypes[TAllowed]>>` `:445-470`, and `BackstageUserPrincipal.userEntityRef` is `:72-77` — so `allow:['user']` gives `credentials.principal.userEntityRef` directly, with no `coreServices.userInfo` dep. `isDatabaseConflictError(e: unknown): boolean` `:1745`, exported `:1873`.
`CatalogApi.getEntityByRef(ref, opts?): Promise<Entity | undefined>` `node_modules/@backstage/catalog-client/dist/index.d.ts:617`.
`CatalogTableProps.actions?: TableProps<CatalogTableRow>['actions']` `node_modules/@backstage/plugin-catalog/dist/index.d.ts:218`; `Action.hidden?: boolean` `node_modules/@material-table/core/types/index.d.ts:145`.
`EntityListContextProps.refresh?: () => void` `node_modules/@backstage/plugin-catalog-react/dist/index.d.ts:892`; `EntityRefLink` exported `:466,1254`.

**F7 — the dev database is in-memory.** `app-config.yaml:46-48` — `client: better-sqlite3`, `connection: ':memory:'`. UI-created collections do NOT survive a backend restart in the default dev config. So does the catalog, so the two stay consistent; but it must be documented (§8) and it drives §4's first-run branch.

**F8 — the refresh interval.** `plugins/bruno-backend/src/service/schedule.ts:4` — `DEFAULT_FREQUENCY_SECONDS = 60`; `readSchedule` `:14-29`; configured at `app-config.yaml:182-184`. This is the latency for a UI-created collection to appear **and** to disappear.

**F9 — the two `ManifestProbe` instances are deliberately separate.** `plugins/bruno-backend/src/plugin.ts:34-47` builds one for the router; `plugins/bruno-backend/src/module.ts:45-51` builds another for the catalog module. The reason is documented at `plugin.ts:35-40`. UI-P6 does not change this.

---

## 2. Store — `plugins/bruno-backend/src/store/uiCollectionStore.ts` (NEW)

Modelled on the removed `connectionStore` (`git show 34f1960^:plugins/bruno-backend/src/store/connectionStore.ts`) — `database.getClient()`, create-table-if-not-exists with the concurrent-creator tolerance at its `:49-56`, snake_case columns mapped to a camelCase model, no formal migrations.

```ts
export interface UiCollectionRow {
  /** `metadata.name` of the Bruno entity. Primary key. */
  name: string;
  /** The normalized collection folder URL. */
  url: string;
  owner?: string;
  partOf: string[];
  /** Entity ref of the user who added it. Recorded, not enforced (POC). */
  createdBy: string;
  createdAt: string;
}

export interface UiCollectionStore {
  insert(row: Omit<UiCollectionRow, 'createdAt'>): Promise<void>;
  getByName(name: string): Promise<UiCollectionRow | undefined>;
  listAll(): Promise<UiCollectionRow[]>;
  /** True when a row was removed, false when there was none. */
  delete(name: string): Promise<boolean>;
}

export async function createUiCollectionStore(
  database: DatabaseService
): Promise<UiCollectionStore>;
```

Table `bruno_ui_collections`:

| column | knex builder | null? |
|---|---|---|
| `name` | `table.text('name').primary()` | no |
| `url` | `table.text('url').notNullable()` | no |
| `owner` | `table.text('owner')` | yes |
| `part_of` | `table.text('part_of').notNullable()` | no |
| `created_by` | `table.text('created_by').notNullable()` | no |
| `created_at` | `table.text('created_at').notNullable()` | no |

### 2.1 `partOf[]` persistence — DECIDED: **a JSON string in a `text` column**

*(Coordinator cross-check #2. Column type: `text`. Serialisation: `JSON.stringify(string[])` on write, `JSON.parse` in a try/catch on read.)*

Write: `part_of: JSON.stringify(row.partOf ?? [])`.
Read: a `parsePartOf(raw: unknown): string[]` helper —
```ts
if (typeof raw !== 'string') return [];
try { const v = JSON.parse(raw);
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : []; }
catch { return []; }
```
mirroring the tolerance of `readPartOf` at `plugins/bruno-backend/src/service/brunoConfig.ts:119-127`.

Why `text` + JSON and not `table.json()` or a join table:

1. **`text` is the only column type whose read-back value is byte-identical on better-sqlite3 and postgres.** Both dialects hand back a `string`. Knex's `table.json()` maps to a native `json` column on postgres, where `node-postgres` parses it to a JS value on read, and to `text` on sqlite, where it stays a string. That divergence forces a `typeof row.part_of === 'string' ? JSON.parse(...) : row.part_of` fork that can only ever be exercised on one dialect at a time — untestable in a repo with no test suite, and silently wrong on whichever dialect the author did not boot.
2. **`partOf` is never queried.** It is copied verbatim into `spec.partOf` by the provider (`BrunoCollectionEntityProvider.ts:193`). It is never filtered, joined, aggregated or indexed on. A join table buys index-able membership queries nobody asks for.
3. **A join table needs referential integrity sqlite does not give us.** `ON DELETE CASCADE` is not enforced by sqlite unless `PRAGMA foreign_keys = ON`, which Backstage's better-sqlite3 connector does not guarantee. The alternative is a hand-rolled two-statement delete inside a transaction — more failure modes than the feature has.
4. **It matches both removed stores.** `connectionStore.ts:43-49` used `table.text()` for every column without exception. Keeping the idiom identical keeps the create-table-if-not-exists block copy-reviewable.

`insert` must NOT use `.onConflict().merge()` (which the removed store did) — a duplicate name is an error the user has to see, not something to silently overwrite. Wrap the insert and rethrow `isDatabaseConflictError(e)` (F6) as `ConflictError` so a race between two concurrent creates produces the same message as the pre-check.

---

## 3. Routes on the `bruno` plugin

### 3.1 Wiring — `plugins/bruno-backend/src/plugin.ts`

- `:20-33` deps — add `database: coreServices.database`. The teardown at `34f1960` removed it (`git show 34f1960^:plugins/bruno-backend/src/plugin.ts:28`); re-add it in the same position, with a docblock line saying what it stores.
- `:34` init destructure — add `database`.
- After the probe construction at `:41-47`, add `const uiCollections = await createUiCollectionStore(database);`.
- `:49-57` `createRouter({ ... })` — add `uiCollections` and `refreshSeconds: readRefreshSeconds(config)`.
- **No new `addAuthPolicy` block.** `:60-63` (`/health`) and `:72-75` (docs `user-cookie`) are the only two, and the new routes want the default barrier. Adding a policy for them would loosen, not tighten.
- **No `coreServices.userInfo` dep.** F6 — `allow:['user']` narrows the return type to `BackstageCredentials<BackstageUserPrincipal>`, so `credentials.principal.userEntityRef` is available without it. The old code used `userInfo` (`git show 34f1960^:…/router.ts:287`); do not reintroduce the dep.

### 3.2 `plugins/bruno-backend/src/service/router.ts`

- `:18-26` `RouterOptions` — add `uiCollections: UiCollectionStore;` and `refreshSeconds: number;` with docblocks.
- `:45` destructure — add both.
- `:28-41` router docblock — extend the route table with the three new routes and say plainly that this plugin is now the write model for UI-created collections, which is why it grew a database again.
- **Placement: insert all three routes after the probe route's closing `});` at `:122`, before the docs route at `:144`.**
- **Route ordering.** The only literal under `/collections` is `POST /collections/probe` (`:74`). `DELETE /collections/:name` is a different method, so Express cannot confuse them; `DELETE /collections/probe` would bind `:name='probe'` and 404 honestly. Registering the new routes *after* `:122` keeps the literal first in the stack so the rule still holds if anyone later adds `POST /collections/:name`.

#### Route A — `POST /collections` — auth `allow: ['user']`

**Why user-only, explicitly.** This is a user-initiated write whose `created_by` column is read off the principal. There is no service caller — the provider only ever reads. Admitting `['service']` would let any backend plugin holding a plugin token mint catalog-visible entities with no user attribution, and the column would have to be spoofable from the body.

```
const credentials = await httpAuth.credentials(req, { allow: ['user'] });
const createdBy = credentials.principal.userEntityRef;
```

Body `{ url, name, owner?, partOf? }`. Order of operations:

1. `url` must be a non-empty string -> else `InputError('A collection URL is required.')`.
2. `name` must be a non-empty string matching the entity-name grammar. Mirror `ENTITY_NAME_PATTERN` / `MAX_ENTITY_NAME_LENGTH` from `plugins/bruno/src/components/AddCollection/generateCatalogInfo.ts:38-39`; do NOT import across the plugin boundary (the frontend already duplicates `BRUNO_API_VERSION` for the same reason, `generateCatalogInfo.ts:20-28`). Add the constants beside the route with a "keep in step with generateCatalogInfo.ts:38-39" note.
3. `owner` optional string; `partOf` optional `string[]`, filtered with the same `Array.isArray && every(typeof === 'string')` guard.
4. `const normalized = probe.normalize(url)` inside try/catch -> `InputError` on throw. **Store the normalized form**, so the provider's `claimed` key and the `url:` location annotation are the same string the config path would produce (`BrunoCollectionEntityProvider.ts:83,166`). The provider re-normalises; `normalize` is idempotent.
5. **Manifest validation (required).** `const snapshot = await probe.probe(url)`.
   - throw -> `InputError('Backstage could not read this URL: ' + message)`.
   - `undefined` -> `InputError('No bruno.json or opencollection.yml/.yaml found at ' + normalized + '. Point at the folder that holds the collection.')`.
   This is the "a folder with no manifest cannot be stored" requirement. It reuses the router's own probe instance (F9); the duplicated tree read is already accounted for at `plugin.ts:35-40`, and this call warms the cache the ingest a few seconds later reads from.
6. **Duplicate name rejection — two checks, one message.**
   - `await uiCollections.getByName(name)` -> `ConflictError` naming the existing URL and telling the user to pick a different name.
   - Config collision: compute each configured entry's would-be name with the shared helper from §4.3 and reject with a `ConflictError` naming `app-config.yaml` and the URL. Without this the create *succeeds* and the entity then never appears, because the provider's `claimed` guard (`:121-131`) silently skips it — a create that looks fine and does nothing is the worst outcome available.
   - The `insert` catch on `isDatabaseConflictError` rethrows the first message (race).
7. `await uiCollections.insert({ name, url: normalized, owner, partOf, createdBy })`.
8. `res.status(201).json({ name, namespace: 'default', entityRef: 'bruno:default/' + name, url: normalized, refreshSeconds })`.
   `refreshSeconds` is what lets modal 2 quote the real number instead of hardcoding 60.

POC comment above the route, matching the posture at `router.ts:71-73`: any authenticated user may ask the backend to read any URL its integrations can reach (SSRF + private-repo existence oracle), and any authenticated user may add a collection anyone else can see. Documented, not fixed.

#### Route B — `GET /collections` — auth `allow: ['service']`

**`['service']` is REQUIRED and is the whole point.** `BrunoCollectionEntityProvider` calls this with a plugin token minted by `auth.getPluginRequestToken` (F6), whose principal type is `service`. Without `'service'` in the allow-list every provider tick is a 403 and no UI-created collection ever reaches the catalog.

**`'user'` is deliberately NOT added.** No frontend caller needs it: the dashboard's delete gate reads `collectionOrigin(entity)` off the entity (F5), and modal 2 polls `catalogApi.getEntityByRef`. The response carries `created_by` — a user entity ref — for every UI collection in the instance, so admitting `'user'` would be a gratuitous cross-user disclosure with no consumer. If a later phase needs a user-facing list, widen it to `['user','service']` **then**, and say so in the docblock.

Response: `UiCollectionRow[]`, JSON, unwrapped array — the reader in §4.1 asserts `Array.isArray`.

#### Route C — `DELETE /collections/:name` — auth `allow: ['user']`

`allow: ['user']` for the same reason as Route A: user-initiated destructive write, no service caller.

- `const removed = await uiCollections.delete(req.params.name)`.
- `!removed` -> `NotFoundError` saying no collection of that name was added from the Bruno UI, and that collections defined in `app-config.yaml` or by a `catalog-info.yaml` are removed by editing that file. This is what makes an attempt to delete a config- or descriptor-origin collection say so instead of silently succeeding.
- `res.json({ deleted: true, name, refreshSeconds })`.
- POC IDOR comment: any authenticated user may delete any UI-created collection; `created_by` is recorded and not enforced. Beta hardening = a permission + an ownership check.

All three rely on the existing error middleware at `:191-192` to map `InputError`->400, `ConflictError`->409, `NotFoundError`->404.

---

## 4. Provider — config union stored, degraded-never-fatal

### 4.1 `plugins/bruno-backend/src/provider/storedCollections.ts` (NEW)

Recovered pattern: `git show 34f1960^:plugins/bruno-backend/src/processor/BrunoLinkProcessor.ts:114-133`.

```ts
export interface StoredCollection {
  name: string; url: string; owner?: string; partOf: string[];
  createdBy: string; createdAt: string;
}
export interface StoredCollectionReader { list(): Promise<StoredCollection[]>; }
export function createStoredCollectionReader(options: {
  discovery: DiscoveryService; auth: AuthService;
}): StoredCollectionReader;
```

Body, carried forward verbatim from the recovered reference:
- `const baseUrl = await discovery.getBaseUrl('bruno')` (ref `:115`).
- `const { token } = await auth.getPluginRequestToken({ onBehalfOf: await auth.getOwnServiceCredentials(), targetPluginId: 'bruno' })` (ref `:116-119`).
- `await fetch(baseUrl + '/collections', { headers: { Authorization: 'Bearer ' + token } })` (ref `:120-122`).
- `if (!res.ok) throw new Error('GET /collections failed with ' + res.status + ' ' + res.statusText)` (ref `:123-127`) — **status and statusText only**, never the body and never the request headers.
- `if (!Array.isArray(body)) throw new Error('GET /collections returned a non-array body')` (ref `:128-132`).
- Per-row shape guard the reference did not need: drop rows without a string `name`/`url`; run `partOf` through the same array guard as §2.1.

**Token hygiene, carried forward verbatim.** The token is a function-local `const`, used only as the `Authorization` header, never returned, never stored on the reader, never put in an `Error` message. **The reader THROWS; it does not log.** The caller logs with the structured second argument —
```ts
logger.warn('…', error instanceof Error ? error : new Error(String(error)));
```
— exactly as at `BrunoLinkProcessor.ts:104-107`, never string-interpolated, so a caught auth/fetch error whose `message` echoes the request cannot smuggle the bearer token into a log line. **This constraint is non-negotiable and applies to every new log call in this phase.**

The reader deliberately does not swallow failures the way `BrunoLinkProcessor.getLinks` did (ref `:101-110`): the provider must be able to tell "the list is empty" from "I could not ask", because those two have opposite consequences under a `full` mutation.

### 4.2 `plugins/bruno-backend/src/module.ts`

- `:32-38` deps — add `discovery: coreServices.discovery` and `auth: coreServices.auth`. Both were removed by the teardown at `34f1960`; re-add them.
- `:39` init destructure — add both.
- After the probe at `:45-51`, add `const storedCollections = createStoredCollectionReader({ discovery, auth });`.
- `:53-60` `new BrunoCollectionEntityProvider({...})` — add `storedCollections`.
- `:15-26` module docblock — the provider bullet at `:18-20` currently says "one entity per `bruno.collections[]` entry"; change to "one entity per `bruno.collections[]` entry **and** per collection added from the Bruno UI, read service-to-service from `GET /api/bruno/collections`."

The reader is **injected, not constructed inside the provider**, so the provider stays a pure function of its inputs and the §4.4 skip branch is reachable by handing it a reader that throws — the only way to exercise that branch without a live backend, in a repo with no test suite.

### 4.3 `BrunoCollectionEntityProvider.ts` — name derivation, extracted

Extract the derivation currently inlined at `:120` (`entry.name ?? sanitizeName(lastPathSegment(url))`) so Route A can pre-check config collisions with the same rule:

```ts
/** The entity name a collection URL yields when no explicit name is set.
 *  Exported so `POST /collections` rejects a config collision with a clear
 *  message instead of leaving the `claimed` guard below to skip it silently. */
export function collectionNameFromUrl(normalizedUrl: string): string {
  return sanitizeName(lastPathSegment(normalizedUrl));
}
```
`:120` becomes `const name = entry.name ?? collectionNameFromUrl(url);`. `lastPathSegment` (`:199-205`) stays private.

### 4.4 `BrunoCollectionEntityProvider.ts` — `run()` (`:65-155`)

Add a private field after `:39`:
```ts
/** The last stored list this PROCESS fetched successfully. Undefined until the
 *  first success — see the skip branch in `run()` for why that matters. */
private lastStored?: StoredCollection[];
```

Insert at the top of `run()`, after the destructure at `:69` and **before** `entities`/`claimed` at `:71-74`:

```ts
let stored: StoredCollection[];
try {
  stored = await this.options.storedCollections.list();
  this.lastStored = stored;
} catch (error) {
  if (this.lastStored === undefined) {
    logger.warn(
      'BrunoCollectionEntityProvider could not read the UI-created '
      + 'collections and has none cached from an earlier run in this process; '
      + 'SKIPPING this refresh entirely. Emitting now would apply a `full` '
      + 'mutation whose entity set is missing every UI-created collection, '
      + 'and a full mutation deletes by set difference — the catalog would '
      + 'drop them all.',
      error instanceof Error ? error : new Error(String(error))
    );
    return;                       // <<< NO applyMutation. Nothing is deleted.
  }
  logger.warn(
    'BrunoCollectionEntityProvider could not read the UI-created '
    + 'collections; emitting the last set this process read successfully.',
    error instanceof Error ? error : new Error(String(error))
  );
  stored = this.lastStored;
}
```

Then build one iteration source, replacing the `for (const entry of readBrunoCollections(config, logger))` header at `:76`:

```ts
type SourceEntry = {
  url: string; name?: string; partOf: string[]; owner?: string;
  origin: 'config' | 'ui';
};
const sources: SourceEntry[] = [
  ...readBrunoCollections(config, logger).map((e) => ({ ...e, origin: 'config' as const })),
  ...stored.map((s) => ({
    url: s.url, name: s.name, partOf: s.partOf, owner: s.owner, origin: 'ui' as const
  }))
];
for (const entry of sources) {
```

**Config entries go first, deliberately.** The `claimed` guard at `:121-131` is first-wins. `app-config.yaml` is the operator's file and cannot be edited from the UI; a UI-created collection can be renamed by whoever made it. So the UI one is the one that should lose. Extend the message at `:123-128` to name which side is which, because "set `name:` on one of the two bruno.collections entries" is wrong advice when one of the two came from the UI.

**Everything from `:81` to `:130` is otherwise unchanged.** Stored entries go through the same `probe.normalize` guard (`:81-92`), the same `probe.probe` tolerance (`:94-107` — a transient read failure emits the entity anyway rather than deleting it), the same no-manifest skip (`:109-118`), and the same `claimed` map. That is the requirement: one loop, one set of guards, config-vs-store collisions caught by machinery that already works.

`:132-140` becomes:
```ts
entities.push(buildEntity({
  name, url, partOf: entry.partOf, owner: entry.owner, manifest, origin: entry.origin
}));
```

`:143-149` `applyMutation` is **unchanged** — same `type: 'full'`, same `locationKey` (`:147`). A stored collection is emitted by the same provider under the same key as a config one, so the two can never conflict with each other in `refresh_state`.

`:151-154` `logger.info` — extend to break the count down: `emitted N Bruno entity(ies) (C from config, U from the UI), skipped S.`

### 4.5 `buildEntity` (`:158-196`)

- Input type `:158-164` gains `origin: BrunoOrigin;`.
- `:165` destructure gains `origin`.
- `:186` `[ORIGIN_ANNOTATION]: 'config'` -> `[ORIGIN_ANNOTATION]: origin`.
- Rewrite the comment at `:181-185`: it currently explains why only this provider knows the entity came from config. It now also carries which of the two mutable sources it came from — and that `BrunoKindProcessor.deriveOrigin` (`:78-84`) preserves it, which is what makes `'ui'` survive every reprocess cycle and light up `collectionOrigin` on the frontend (F4, F5).
- Import: `import type { BrunoOrigin } from '../processor/BrunoKindProcessor';` — `:1-17` already imports `ORIGIN_ANNOTATION` from that module; add the type to a separate `import type` line per `consistent-type-imports`.
- **Do NOT re-export `BrunoOrigin` from `index.ts`.** The frontend has its own copy (`plugins/bruno/src/lib/brunoEntity.ts:155`) with a documented `'unknown'` addition; an unused re-export is dead code.

### 4.6 Coordinator cross-check #1 — the exact control flow that makes an empty emission impossible

There are exactly three ways `run()` reaches `applyMutation` (`:143`), and none can pass a set missing the UI-created collections:

| # | condition | what happens | can UI entities be deleted? |
|---|---|---|---|
| 1 | `list()` resolves | `stored` = the truth, `lastStored` updated, emit config union stored | No — the set is complete by construction. |
| 2 | `list()` throws, `lastStored !== undefined` | emit config union `lastStored` (stale but non-empty), warn | No — every previously-emitted UI ref is still in `newRefsSet`, so `DefaultProviderDatabase.cjs.js:214` puts none of them in `toRemove`. |
| 3 | `list()` throws, `lastStored === undefined` | **`return` before `applyMutation`** | No — the mutation never runs, so `replaceUnprocessedEntities` (`:43`) is never called and `toRemove` is never computed. |

Case 3 is the only one that could ever produce an emission missing all UI entities, and it is the one that returns early. This is stronger than "emit the config entries alone": emitting config-only in case 3 **would** delete them, because the catalog's `refresh_state_references` rows persist across a backend restart (F1) and `list()` failing on the first tick after a restart is exactly when the fetch is most likely to fail (the `bruno` plugin may not have finished initialising). **Locked by coordinator amendment A1.**

The cost of case 3 is that configured collections are also not emitted on that tick. That is a <= `frequencySeconds` delay (60 s by default, F8) in a failure case only, and the alternative is destroying user data. On every subsequent tick, either `list()` succeeds (case 1) or `lastStored` is still undefined and it skips again — it never degrades into a deletion.

`run()` itself still cannot throw for any other reason: the `normalize` and `probe` calls remain inside the loop's guarded region for the reason already documented at `:77-80`.

---

## 5. Frontend

### 5.1 `plugins/bruno/src/api/BrunoApi.ts`

Add to the interface at `:67-92`:
```ts
export interface CreateCollectionInput {
  name: string; url: string; partOf: string[]; owner?: string;
}
export interface CreatedCollection {
  name: string; namespace: string; entityRef: string; url: string;
  /** The provider's refresh interval, so the dialog can quote the real number. */
  refreshSeconds: number;
}
createCollection(input: CreateCollectionInput): Promise<CreatedCollection>;
deleteCollection(name: string): Promise<void>;
```
Update the interface docblock at `:52-66`: it currently says the client is "deliberately small" because the catalog is the read model, and that the backend's remaining store routes "have no frontend caller any more" (`:63-65`). **That sentence is stale at HEAD — the teardown at `34f1960` removed those routes entirely — and this phase makes it doubly wrong.** Replace it: the catalog is still the read model, but it has no **write** model, so the one thing a browser cannot do through `catalogApi` — bring a new entity into existence — goes through here and is then materialised by `BrunoCollectionEntityProvider` on its next tick.

### 5.2 `plugins/bruno/src/api/BrunoClient.ts`

- `createCollection` -> `POST ${base}/collections` via `this.fetchApi.fetch` (never `window.fetch` — `:8-18`), `Content-Type: application/json`.
- `deleteCollection` -> `DELETE ${base}/collections/${encodeURIComponent(name)}`.
- Shared error extraction: on non-2xx, `await response.json().catch(() => undefined)`, and if the body is `{ error: { message: string } }` (the shape the `MiddlewareFactory` handler at `router.ts:191-192` emits) throw `new Error(body.error.message)`; otherwise throw a plain status/statusText error. **The 409 message must reach the dialog verbatim** — the duplicate-name sentence is the entire value of that status code, and collapsing it to "HTTP 409" repeats the mistake `probeCollection` was written to avoid (`:33-45`).
- Do not mirror `probeCollection`'s "a 400 is parsed, not thrown" behaviour: there is no success-shaped 4xx here.

### 5.3 `plugins/bruno/src/components/AddCollection/AddCollectionAction.tsx`

Replace `interface Generated` (`:15-19`) with a staged discriminated union, matching the house pattern (`GeneratedYamlDialog.tsx:55-60`):

```ts
type Flow
  = | { status: 'closed' }
    | { status: 'form'; error?: string }
    | { status: 'creating' }
    | { status: 'created';
        input: BrunoEntityInput; yaml: string; created: CreatedCollection };
```

- `:42-44` — `open`/`generated` become one `flow` state; `initialPartOf` stays.
- `open` for modal 1 is derived: `flow.status === 'form' || flow.status === 'creating'`.
- `:46-65` deep-link effect — `setOpen(true)` becomes `setFlow({ status: 'form' })`. The `window.location.search` comment at `:53-58` and the `replace` at `:62-64` are unchanged and must stay.
- `:67-72` `onSubmit` becomes async and returns `Promise<boolean>` (see 5.4):
  ```ts
  setFlow({ status: 'creating' });
  try {
    const created = await brunoApi.createCollection({
      name: input.name, url: input.url, partOf: input.partOf, owner: input.owner
    });
    setFlow({ status: 'created', input,
      yaml: toCatalogInfoYaml(buildBrunoEntity(input)), created });
    return true;
  } catch (e) {
    setFlow({ status: 'form',
      error: e instanceof Error ? e.message : String(e) });
    return false;
  }
  ```
  The YAML still comes from the same `buildBrunoEntity`/`toCatalogInfoYaml` pair (`generateCatalogInfo.ts:129,168`), so the preview, the download and the PR still share one string and the docblock at `generateCatalogInfo.ts:9-13` stays true.
- Needs `const brunoApi = useApi(brunoApiRef)` — new import from `../../api`.
- `:80-83` header button — `setFlow({ status: 'form' })`.
- `:88-93` — pass `submitting={flow.status === 'creating'}` and `error={flow.status === 'form' ? flow.error : undefined}`; `onClose` -> `setFlow({ status: 'closed' })`.
- `:95-103` — render modal 2 on `flow.status === 'created'`, passing the two new props `entityRef={flow.created.entityRef}` and `refreshSeconds={flow.created.refreshSeconds}`.
- Class docblock `:21-37` — the "modal 1 closes AS modal 2 opens" hand-off (`:23-29`) is still true; add that modal 1 now stays open and disabled while the create is in flight, so a rejected name lands back on the field that produced it rather than on a dead end.

### 5.4 `plugins/bruno/src/components/AddCollection/AddCollectionDialog.tsx`

- Props `:119-130` — `onSubmit` becomes `(input: BrunoEntityInput) => Promise<boolean>`; add `submitting?: boolean` and `error?: string`.
- `:298-309` `submit` becomes async: `const ok = await onSubmit({...}); if (ok) reset();`.
  **`reset()` must move off the unconditional path at `:308`.** Today it fires on every submit; after this change a failed create would empty the form the user has to fix — and a rejected name is the single most likely failure. The promise return is the minimal signal; it needs no extra state and the dialog already owns `reset` (`:281-288`), whose docblock about staying mounted (`:277-280`) remains correct.
- Render `error` under the actions as `Typography variant="body2" color="error"`, mirroring `GeneratedYamlDialog.tsx:418-426`.
- `:478-485` submit button — label `Generate catalog-info.yaml` -> **`Add collection`**; `disabled={!canSubmit || submitting}`; `startIcon={submitting ? <CircularProgress size={16} /> : undefined}`; label `Adding…` while submitting. `CircularProgress` is already imported (`:4`).
- Intro copy `:368-372` — currently "Nothing is created yet". Replace with: *"Point Backstage at a collection in source control. Submitting registers it in the catalog. The next step shows the equivalent `catalog-info.yaml`, which you can download or open as a pull request if you also want the descriptor in your repository — both are optional."*
- **Class docblock `:101-118` must be rewritten.** `:113` says "Submitting does NOT create anything" and `:116-117` says "the catalog has no 'create entity' endpoint". The second sentence is still TRUE and is now the interesting part: there is still no create endpoint, which is why the create goes to the Bruno backend's store and is materialised by `BrunoCollectionEntityProvider` on its next tick — so the entity appears within `bruno.schedule.frequencySeconds`, not instantly. Say exactly that. Keep the whole paragraph at `:105-112` about why the URL probe gates the form; it is unchanged and is now load-bearing on the backend too (§3.2 Route A step 5).

### 5.5 `plugins/bruno/src/components/AddCollection/GeneratedYamlDialog.tsx`

New props on `:165-174`: `entityRef: string` and `refreshSeconds: number`.

**A second state union, separate from `Stage` (`:55-60`)** — the landing poll runs independently of the pull-request stage, because a user can be mid-PR while the entity lands:
```ts
type Landing
  = | { status: 'waiting' }
    | { status: 'landed' }
    | { status: 'timed-out' };
```

**The poll.**
- `catalogApi.getEntityByRef(entityRef)` — F6. The `catalogApi` is already resolved at `:88` via `useApiHolder`; keep that (a host app need not register it) and skip the poll if it is absent.
- **Interval: 3000 ms.** The provider tick is `refreshSeconds` (60 by default, F8), so the entity lands at an arbitrary point in a 60 s window. 3 s costs at most ~20 cheap catalog reads per flow and bounds the "it is there but we have not noticed" gap to 3 s. Faster buys nothing — the entity does not appear sooner. Slower makes the success feel late.
- **The first poll fires immediately on mount**, not after the first interval: a provider tick may have fired between the create and the dialog rendering.
- **Give up after `refreshSeconds * 2 + 30` seconds** (150 s at the default) — two full provider cycles plus a margin for the catalog's own stitch.
- A **thrown** error from `getEntityByRef` (backend down, token refresh) is treated as another "not yet" and the poll continues; one transient 500 must not end the wait. A resolved `undefined` is likewise "not yet" (F6 — the client returns `undefined` for a missing ref rather than throwing).
- Cleanup: a `cancelled` flag plus `clearInterval` in the effect teardown, matching `AddCollectionDialog.tsx:171,198-201`.
- The effect must not run when `open` is false, matching the guard at `:215-217`.

**Copy per state — this is the honesty requirement. Do not claim the entity exists before it does.**
- `waiting` — **"{name} has been added."** *"Backstage re-reads its collection list every {refreshSeconds} seconds, so the entity appears in the catalog shortly; this message becomes a link when it does. You can close this window — the collection is registered either way."* with a `CircularProgress size={16}` (already imported, `:7`).
- `landed` — **"{name} is in the catalog."** plus `<EntityRefLink entityRef={entityRef} defaultKind="Bruno" />` (F6 — exported from `@backstage/plugin-catalog-react`; `EntityRefLinks` is already used at `BrunoPage.tsx:108`).
- `timed-out` — **"{name} is registered but has not appeared in the catalog yet."** *"That usually means the collection could not be re-read from source control on the last refresh — check the backend log for `BrunoCollectionEntityProvider`. It will appear on a later refresh; nothing needs to be re-submitted."* Explicitly not phrased as a failure, because it is not one: the row is stored and the next tick will pick it up.

**Lead paragraph `:364-368` is now FALSE and must be replaced.** It currently reads "Nothing has been added to the catalog yet — Backstage reads entities from source control, so this file has to land in a repository first." Replace with: *"Your collection is registered. This is the equivalent `catalog-info.yaml` — you only need it if you also want the descriptor committed to your repository. Downloading it and opening a pull request are both optional."*

**Dialog title `:470`** — `Add {name} to the catalog` -> `{name} added`.

**`Close` `:431-433`** stays the always-available exit, disabled only while a PR is in flight, as it already is. The user must always be able to leave with their collection.

**The PR conflict warning — LOCKED, and this is the whole of the conflict handling.**
Add a **fifth `<li>`** to the `limits` list at `:306-334`, in the same `<ul className={classes.limits}>`, rendered inside the existing `WarningPanel severity="info" title="Before you open a pull request" defaultExpanded` at `:386-392` — which sits **above** the title/body fields (`:395-416`) and above the button (`:443-454`), so it is read **before** the click. Both `WarningPanel` details documented at `:300-305` (`defaultExpanded`, and `children` not `message`) still apply.

> This collection is already registered from the Bruno UI. If you merge this pull request and then also register the file as a catalog location, two sources will claim the entity name `{name}`. Backstage keeps whichever source claimed it first — the one you just created — and logs a conflict for the other, so the descriptor will appear to do nothing. Delete this collection from the Bruno dashboard first if you want the descriptor to own it.

**Explicitly NOT done, and this is locked:**
- `submit()` (`:261-293`) is untouched beyond copy. It does **not** call `deleteCollection`, does not disable the stored row, does not mark it superseded. **A stored entry stays authoritative; creating a PR never removes or supersedes it.**
- `close()` (`:244-247`) is unchanged apart from also resetting the landing state.
- **No automatic conflict detection and no auto-removal.** A cheap read-only detection idea is parked in §9 Q2.

### 5.6 Delete affordance — `plugins/bruno/src/components/BrunoPage/BrunoPage.tsx`

**The gate is `collectionOrigin(entity) === 'ui'` from `plugins/bruno/src/lib/brunoEntity.ts:175` and nothing else.** Do not re-derive origin from `ANNOTATION_LOCATION`; that fallback exists inside `collectionOrigin` (`:181-195`) and is deliberately unable to return `'ui'` (F5), which is what makes an unstamped or older-backend entity hidden rather than wrongly deletable. `changeRoute`/`useChangeRoute` (`lib/changeRoute.ts:47,84`) are built on the same accessor — do not invent a second way of deciding origin.

`BrunoPage` at `:225-264` is stateless; the action's `onClick` needs component state. Extract a `BrunoCollectionsTable` component inside the `EntityListProvider` (`:239-261`), exactly as `BrunoStatTiles` (`:190-200`) was extracted for the same reason:

```tsx
function BrunoCollectionsTable(): JSX.Element {
  const [pending, setPending] = useState<Entity | undefined>();
  const actions: TableProps<CatalogTableRow>['actions'] = [
    (row) => ({
      icon: () => <DeleteOutlineIcon fontSize="small" />,
      tooltip: 'Remove this collection',
      hidden: collectionOrigin(row.entity) !== 'ui',
      onClick: () => setPending(row.entity)
    })
  ];
  return (<>
    <CatalogTable columns={columns} actions={actions} title="Collections" />
    {pending && <DeleteCollectionDialog open entity={pending}
      onClose={() => setPending(undefined)} />}
  </>);
}
```
`:258` `<CatalogTable columns={columns} title="Collections" />` is replaced by `<BrunoCollectionsTable />`. The explicit-title comment at `:252-257` moves with it. `actions` is typed by `CatalogTableProps.actions` (F6); the per-row function form is what material-table uses for conditional visibility, and `Action.hidden` is verified present (coordinator amendment A2).

**`plugins/bruno/src/components/BrunoPage/DeleteCollectionDialog.tsx` (NEW)** — staged union:
```ts
type Stage = { status: 'confirm' } | { status: 'deleting' }
  | { status: 'deleted'; refreshSeconds: number }
  | { status: 'error'; message: string };
```
- `confirm` copy must be honest about latency **and** about what is not deleted: *"Removing **{name}** deletes the record Backstage created when you added it from this dashboard. The collection in source control is untouched, and any `catalog-info.yaml` you committed for it is untouched. The entity disappears from the catalog on the next refresh — about a minute by default."*
  The exact figure is not available in the `confirm` state (the dashboard has no create response); the `DELETE` response carries `refreshSeconds` (§3.2 Route C), so the `deleted` state quotes the real number. This one approximate wording is deliberate — do not add a config read or a second round trip just to firm it up.
- `deleted`: *"{name} removed. It disappears from this list within {refreshSeconds} seconds."* Post the same sentence via `alertApiRef` (already used at `BrunoEntityHeader.tsx:103,88-97`) and close.
- `error`: the message verbatim — a `NotFoundError` here means the entity claims `usebruno.com/origin: ui` but has no store row (a hand-authored descriptor may declare it; `BrunoKindProcessor.ts:73-76` explicitly accepts that), and the route's message says so.
- **Do NOT call `useEntityList().refresh?.()`** (F6) on success. The row is still in the catalog until the provider's next tick, so a refresh would re-render the same row and read as "the delete did not work". The alert carries the truth instead.
- `useApi(brunoApiRef)` for `deleteCollection`.

**Not touched:** `BrunoEntityHeader.tsx:203-211`'s `UnregisterEntityDialog`. Unregistering a provider-emitted entity removes the `refresh_state` row, and the next provider tick re-creates it — see §9 Q4.

---

## 6. Types, re-exports and config

- `plugins/bruno-backend/src/index.ts` (`:18-37`) — add, matching how `createManifestProbe` / `createRouter` are exported at `:29-30`:
  ```ts
  export { createUiCollectionStore } from './store/uiCollectionStore';
  export { createStoredCollectionReader } from './provider/storedCollections';
  export type { UiCollectionRow, UiCollectionStore } from './store/uiCollectionStore';
  export type { StoredCollection, StoredCollectionReader } from './provider/storedCollections';
  ```
  Do **not** add `collectionNameFromUrl` — both it and its caller live inside `plugins/bruno-backend/src`, so no cross-package export is needed. No other index change.
- `plugins/bruno-backend/src/service/schedule.ts` — add `export function readRefreshSeconds(config: Config): number` and have `readSchedule` (`:14-29`) call it, so the route and the docs quote one number. Not added to `index.ts` (`readSchedule` is not exported there either).
- **`plugins/bruno-backend/config.d.ts` — NO CHANGE.** Nothing new is configurable: the store is not config-driven, and `bruno.schedule` (`config.d.ts:69-83`) already governs the latency. Stated explicitly so the implementer does not invent a knob.
- `plugins/bruno-backend/package.json` — no new dependencies. `knex` types arrive through `DatabaseService.getClient()` (F6); `@backstage/errors` is already a dependency.
- `plugins/bruno/package.json` — no new dependencies.

---

## 7. Sequencing

1. `store/uiCollectionStore.ts` (new). Compiles standalone.
2. `service/schedule.ts` — `readRefreshSeconds`.
3. `service/router.ts` — `RouterOptions` + the three routes.
4. `plugin.ts` — `database` dep, store construction, router options. **Backend now compiles and boots; the routes are live and the provider still ignores them.**
5. `provider/storedCollections.ts` (new) + `collectionNameFromUrl` extraction + `buildEntity` `origin` param.
6. `provider/BrunoCollectionEntityProvider.ts` — `lastStored`, the try/catch, the merged `sources` loop.
7. `module.ts` — `discovery`/`auth` deps, reader construction. **End-to-end backend done: `POST /collections` then wait <=60 s for the entity.**
8. `index.ts` re-exports.
9. `api/BrunoApi.ts` + `api/BrunoClient.ts`.
10. `AddCollectionAction.tsx` + `AddCollectionDialog.tsx`. **Modal 1 now creates.**
11. `GeneratedYamlDialog.tsx` — poll, copy, fifth limit.
12. `BrunoPage.tsx` + `DeleteCollectionDialog.tsx`.
13. Docs (§8).

Steps 1-4 and 5-7 are each independently compilable; do not interleave them.

---

## 8. Documentation of the ~60 s latency — three places, and only three

1. **`plugins/bruno-backend/README.md`** — add one `## Adding a collection from the UI` section: the `bruno_ui_collections` table, the three routes with their auth modes, the service-to-service read, and the statement that a UI-created collection appears in (and disappears from) the catalog within `bruno.schedule.frequencySeconds`. Also state the F7 caveat: with the default dev database (`better-sqlite3` / `:memory:`) UI-created collections do not survive a backend restart. **Do not rewrite the rest.** The README is stale at HEAD — `:1-8` describes `kind: API` and `:30-46` documents a `bruno.sources` block that no longer exists (`readBrunoCollections` reads `bruno.collections`, `brunoConfig.ts:34`). Fixing that is a separate task; flag it, do not do it here.
2. **`app-config.yaml:182-184`** — a comment on the `bruno.schedule` block: this is also the latency for a collection added from the Bruno UI to appear, and for a deleted one to disappear.
3. **The UI itself** — modal 2's `waiting`/`timed-out` copy (§5.5) and the delete confirm copy (§5.6), which is where it actually matters.

---

## 9. Open questions and decisions

1. **A merged PR that is also registered as a catalog location — what the conflict looks like, and what this plan does.** *(Verified, not speculative.)* Two sources claim `bruno:default/<name>` with different `locationKey`s: the provider's `bruno-collection:bruno-collection-provider` (`BrunoCollectionEntityProvider.ts:19,147`) and the descriptor's `url:https://…/catalog-info.yaml` (F3). `refresh_state` holds one `location_key` per `entity_ref`, and F2 makes it **first-writer-wins**. **Net effect:** the UI-created entity keeps the ref; the descriptor's entity never enters the catalog; the user sees a registered location that appears to do nothing; a warn lands in the backend log. **Recovery is clean:** deleting the UI collection makes the next provider tick emit a `full` mutation without it, `DefaultProviderDatabase.cjs.js:214` puts it in `toRemove`, the `refresh_state` row is pruned, and the descriptor's location wins on its next refresh. **This plan's response is warn-only, before the click** (§5.5's fifth limit), with the recovery spelled out in the copy. No detection, no auto-removal — locked.
2. **Cheap read-only conflict detection (parked, NOT in the edit list).** Modal 2 already polls `getEntityByRef`; once landed it could compare `collectionOrigin(entity)` and `ANNOTATION_LOCATION` against what we created and surface a passive "this entity is now owned by a descriptor" note. It would also catch the reverse race. Not planned: it adds a second meaning to the poll's success state, and the failure mode it detects is already warned about before the click.
3. ~~Deviation from the brief's degrade path~~ — **CLOSED by coordinator amendment A1.** The skip is the locked behaviour. Do not implement the brief's literal wording.
4. **`UnregisterEntityDialog` on a UI-created entity (unresolved, not addressed).** `BrunoEntityHeader.tsx:203-211` offers it for every Bruno entity. For a provider-emitted one it removes the `refresh_state` row and the next tick re-creates it — the entity comes back within ~60 s with no explanation. This is pre-existing for config-origin collections and this phase adds a second class of entity with the same behaviour. Options: hide the menu item when `collectionOrigin(entity) !== 'descriptor'`, or route it to `DeleteCollectionDialog` for `'ui'`. **Not planned here** — it is an entity-page change and this phase is scoped to the dashboard. Recommend a follow-up.
5. **In-memory dev database (F7).** `app-config.yaml:46-48` is `better-sqlite3` / `:memory:`, so UI-created collections do not survive a backend restart. The catalog is equally ephemeral, so the two stay consistent and nothing is *inconsistent* — but a reviewer testing across a restart will see their collection vanish and should not read that as a bug. Documented in §8.1; no code change. **Consequence for live verification: do NOT restart the backend between creating a collection and checking that the entity appeared.**
6. **Poll interval and give-up window are judgement calls, not derived.** 3 s and `refreshSeconds * 2 + 30` are reasoned in §5.5 but not measured. If the give-up window proves too short on a slow catalog stitch, raise the multiplier — the `timed-out` copy is deliberately written so that hitting it is not a failure.
7. **`created_by` is recorded and never read.** The list route (the only reader) is service-only, and nothing surfaces it. It is stored for the Beta ownership check that §3.2 Route C's IDOR comment describes. If that check is not coming, the column is dead weight — flagging rather than dropping it, because removing it later needs a migration this store does not have.
8. ~~material-table per-row `hidden`~~ — **RESOLVED by coordinator amendment A2.** `Action.hidden?: boolean` verified at `@material-table/core/types/index.d.ts:145`. Use `hidden`; no fallback.
9. **Could not verify:** whether Backstage's better-sqlite3 `:memory:` connector gives each plugin an isolated in-memory database. It does not affect correctness here (the `bruno` plugin only reads its own table, keyed by name), but a shared in-memory DB would put `bruno_ui_collections` alongside the catalog's tables. Worth a glance at boot; no plan change either way.
