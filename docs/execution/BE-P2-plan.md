# BE-P2 — OpenCollection generation + Entity Sync, Phase 2 — **LOCKED**

**Branch:** `feat/bruno-entity-kind` · **Spec:** `docs/Bruno Backstage Plugin PRD - Entity.md` (sole source of truth) · **Builds on:** `docs/execution/BE-P1-plan.md` (LOCKED, merged)

**Scope — exactly two PRD sections:**
- §"Post ingestion" — generate the OpenCollection YAML for the whole collection and store it "in a similar fashion as the openapi definition is stored".
- §"Entity Sync" — sync the stored YAML and other fields, "similar to how sync functions in backstage".

**Out of scope:** Bruno Dashboard, Bruno entity page and tabs, Bruno Card on API entity pages, add-collection-via-UI/PR flow, Unlink.

All line numbers below were re-verified against the working tree and `node_modules` on 2026-08-31.

---

## 0. Platform facts (F1–F4 from BE-P1 still bind; F8–F13 are new)

**F8 — `kind: API` stores its definition inline as a plain string.**
`node_modules/@backstage/catalog-model/dist/schema/kinds/API.v1alpha1.schema.json.esm.js:50-56` — `spec.required = ['type','lifecycle','owner','definition']`; `:93-97` — `definition: { type:'string', description:'The definition of the API, based on the format defined by the type.', minLength: 1 }`.
`node_modules/@backstage/plugin-api-docs/dist/components/ApiDefinitionCard/ApiDefinitionCard.esm.js:12` takes the entity straight off React context (`useEntity()`) and `:23`, `:27`, `:42` read `entity.spec.definition` — **there is no fetch**. Widget dispatch is `definitionWidgets.find(d => d.type === apiEntity.spec.type)` (`plugin-api-docs/dist/plugin.esm.js:25-27`), plain string equality on `spec.type`.
`catalog-model/dist/schema/Entity.schema.json.esm.js` declares `spec: { type: 'object', description: … }` with **no** `additionalProperties: false`, so an arbitrary `spec.definition` on a foreign kind validates.

**F9 — there is no platform cap on entity size, and a large string does *not* bloat the search index.**
Grepping `@backstage/plugin-catalog-backend/dist` for size limits yields only `MAX_ANCESTOR_DEPTH = 32` and `buildEntitySearch.cjs.js:16-17` `MAX_KEY_LENGTH/MAX_VALUE_LENGTH = 200`. `buildEntitySearch.cjs.js:69-79`: a value longer than 200 chars is written as `{ original_value: null, value: null }` — one null row, not 100 KB. But `mapToRows` still does `String(rawValue).toLocaleLowerCase('en-US')` on the whole string at **every stitch**.

**F10 — the stock catalog table does NOT project fields.**
`@backstage/plugin-catalog-react/dist/hooks/useEntityListProvider.esm.js:78`, `:92`, `:109` call `queryEntities`/`getEntities` with **no `fields`** argument. `fields` exists end-to-end (`@backstage/catalog-client/dist/index.d.ts:420`, `:468`; server side `plugin-catalog-backend/dist/service/createRouter.cjs.js:92` → `parseEntityTransformParams`), but nothing in `EntityListProvider`/`CatalogTable` uses it. Phase 3's dashboard, being "similar to how Backstage renders the API page", will therefore receive every `spec.definition` in full unless Phase 3 writes its own fetch.

**F11 — `resultHash` is computed over the *processed* entity, not the input.**
`plugin-catalog-backend/dist/processing/DefaultCatalogProcessingEngine.cjs.js:157-161`:
`hashBuilder.update(stableStringify({...result.completedEntity})).update(…deferredEntities).update(…relations).update(…refreshKeys).update(…parents)`, then `if (resultHash === previousResultHash) { track.markSuccessfulWithNoChanges(); return; }`.
Processing always restarts from the **unprocessed** entity, so diffing the incoming `spec.definition` is *not* what keeps the hash stable. **Only byte-determinism of the generated string is.** A changing `exportedAt` rewrites the entity, re-stitches it, rebuilds its search rows and bumps `metadata.etag` every 100–150 s (F4), for every Bruno entity.

**F12 — every UrlReader we use supports `readTree` etag revalidation.**
`@backstage/backend-plugin-api/dist/index.d.ts:1298-1334` defines `UrlReaderServiceReadTreeOptions.etag`; `:1399` the response carries a new `etag`.
`@backstage/backend-defaults/dist/entrypoints/urlReader/lib/GithubUrlReader.cjs.js:90-93` — resolves the commit sha via a metadata call, then `throw new NotModifiedError()` **before** downloading the tarball; `:152` `return { files, etag: commitSha }`.
`GitlabUrlReader.cjs.js:130-131` and `BitbucketCloudUrlReader.cjs.js:91-92` do the same (GitLab: commit sha; Bitbucket Cloud: last-commit short hash).
⇒ Revalidation costs **one metadata API call**, not a tarball download + full parse. And a matching etag is a *proof* that the tree is unchanged, which is a stronger byte-stability guarantee than generator determinism alone.

**F13 — sync semantics.**
`plugin-catalog-backend/dist/service/DefaultRefreshService.cjs.js:8-21` — `refresh()` marks the entity plus its `location:` ancestors for reprocessing: **processors re-run, providers do not.** There is no on-demand provider trigger in 1.53.
`plugin-catalog/dist/components/AboutCard/AboutCard.esm.js:105-106` — `allowRefresh = entityLocation?.startsWith("url:") || entityLocation?.startsWith("file:")`; `:109` `catalogApi.refreshEntity(stringifyEntityRef(entity))`.
`plugin-catalog-backend/dist/service/createRouter.cjs.js:56-79` — `POST /refresh`, auth `await httpAuth.credentials(req)` with **no restriction** ⇒ user **or** service principal.
BE-P1 already stamps `url:` locations for provider entities (`BrunoCollectionEntityProvider.ts:154`, `:166-168`), so the gate passes on both entry points.

---

## 1. Design decisions (the four questions, answered)

### Q1 — Where does the generated YAML live? → **`spec.definition`, a plain string.**

Chosen because the PRD says "stored in a similar fashion as the openapi definition is stored", and F8 shows that fashion is exactly an inline `spec.definition` string read off the entity in React context. Phase 4 gets it for free from `useEntity()`; Phase 3's table never has to touch it.

Schema change in `brunoEntityV1alpha1Schema` (`BrunoKindProcessor.ts:78-112`): add `definition` to `spec.properties`, **NOT** to `spec.required`, and **without `minLength`**. `kind: API` uses `minLength: 1`; we deliberately do not, because an empty string reaching `validateEntityKind` would throw → `ok:false` → F3 → the entity never lands. We also never write `''` (the builder returns `undefined`, not `''`).

**Precedence differs from BE-P1's metadata rule.** For `title`/`description`/`version`, authored metadata wins (`BrunoKindProcessor.ts:203-211`). For `spec.definition` the processor **overwrites unconditionally** whenever generation succeeds: it is derived data, no one hand-writes an OpenCollection document into a `catalog-info.yaml`, and letting a stale authored value win would make Sync a permanent no-op. When generation fails, whatever was there is left alone (usually nothing).

**Rejected — an annotation.** `EntityMeta.schema.json.esm.js:84-93` types annotation values as unconstrained strings and `KubernetesValidatorFunctions.esm.js:40-42` `isValidAnnotationValue` accepts any string, so it is *legal* — but annotations are specified as "non-identifying auxiliary information", the value would be re-lowercased into a search row on every stitch under a 200-char guard that then nulls it anyway, and rendering a document out of an annotation is unidiomatic in every Backstage plugin.

**Rejected — a bespoke `spec.openCollection`.** Loses the PRD's stated symmetry with `kind: API`, and buys nothing: we own the kind schema either way.

### Q2 — What generates it, and when? → **`BrunoKindProcessor.preProcessEntity`, from a snapshot cached in `ManifestProbe`.**

- **Processor, not provider.** BE-P1 §1(b) established that both entry points converge on this processor immediately after emission; putting generation here is the only way one implementation serves both. It must be `preProcessEntity` and not `postProcessEntity` so the written `spec.definition` is still subject to `SchemaValidEntityPolicy` and `validateEntityKind` (BE-P1 §5 alt. 2). And per F13, refresh re-runs processors — so putting generation here is what makes Sync work at all.
- **Not a scheduled task.** A third schedule means a third cache and a third parse path, and it would still have to write through a provider or processor to reach the entity.
- **Reconciling the full-repo parse with F4's 100–150 s cadence.** `ManifestProbe` already owns the fetch, the normalized-URL cache key, the TTL/LRU and the error caching (`manifestProbe.ts:71-174`). Phase 2 makes **one** `readTree` produce **both** the manifest metadata and the definition, cached as one entry. Consequences:
  - Exactly one tree read per URL per TTL, shared by the processor and the provider (BE-P1 §3.D's whole point).
  - Post-TTL, the read is an **etag revalidation** (F12): one metadata call, `NotModifiedError`, cache timestamp refreshed, **the same string instance returned**. No re-download, no re-parse, no regeneration.
  - A real re-parse happens only when the repo's commit sha actually moved.
  - The provider (60 s tick) and the processor (100–150 s) share the same entry, so there is no double-fetch and no reason to split `probe()` into a cheap and an expensive variant. A split would *cost* a second read whenever the provider warmed a manifest-only entry that the processor then had to upgrade.

**Cost admitted:** on a genuine change, `parseCollection` runs synchronously over the whole tree, blocking the event loop for tens of milliseconds (a 239-request collection is ~220 KB of source; see §2 measurements). Once per collection per change. Recorded as R2.

### Q3 — What does Sync mean per entry point? → **native `refreshEntity` for both. No new HTTP route in Phase 2.**

| | authored `catalog-info.yaml` | `bruno.collections[]` |
|---|---|---|
| Refresh button visible | yes — location is already `url:`/`file:` from the catalog location | yes — provider stamps `url:` (`BrunoCollectionEntityProvider.ts:154`, `:166`) |
| What re-runs | location ancestors are re-read (descriptor re-parsed) **and** processors re-run | processors re-run only (F13) |
| Definition regenerated | yes, subject to `bruno.cacheTtlSeconds` | yes, same |
| Authored `title`/`description`/`version` picked up | yes | n/a |
| Config changes (`partOf`, `name`) picked up | n/a | **no** — provider-owned; next scheduled tick only (`bruno.schedule.frequencySeconds`, default 60 s). See §7 "Cannot deliver". |

**Why no route.** The `ManifestProbe` instance is constructed in `module.ts:65` — inside `brunoCatalogModule`, whose `pluginId` is `catalog`. The Bruno HTTP router lives in `brunoPlugin` (`plugin.ts:19`, `pluginId: 'bruno'`). Reaching the module's probe from the plugin's route handler would be a shared in-process import across a plugin boundary — precisely what the standing constraints forbid — and it would be silently wrong on any multi-replica deployment, where the evict lands in a process that is not the one serving the next processing run. Registering the route *from the catalog module* via `coreServices.httpRouter` is technically permitted (`BackendInitializer.cjs.js:146-165` only forbids cross-plugin *extension points*), but it would mount Bruno paths under `/api/catalog/*`, where they can shadow the catalog's own `:namespace/:kind/:name` routes. Neither is worth it to shrink a 60-second window.

**What replaces the eviction.** Lower the probe's hard TTL from 300 s to **60 s (configurable)** and add etag revalidation (F12), so the marginal cost of a shorter TTL is one metadata call rather than a tarball. Sync then converges within `bruno.cacheTtlSeconds` of the click, deterministically, with no new surface.

**`ManifestProbe.evict` stays and stays unused.** It remains the correct seam the moment the cache becomes shared (a `CacheService`-backed store, or a route living in the same plugin as the probe). Its doc comment is updated to say exactly why Phase 2 does not call it, so the next reader does not "fix" it by wiring a cross-plugin import.

**Auth mode of any new/changed route: none — Phase 2 adds and changes zero HTTP routes.** The Sync client call is `catalogApi.refreshEntity(stringifyEntityRef(entity))` → `POST /api/catalog/refresh`, gated by the catalog's own `httpAuth.credentials(req)` (`createRouter.cjs.js:69`) which accepts `user` and `service`. No `httpRouter.addAuthPolicy` change. Route-ordering rule is not exercised; the note stands for later phases that `router.ts:169` already registers the literal `/collections/:id/opencollection.yml` and a `.yaml` sibling must sit beside it, above any `:param` route.

### Q4 — Byte-stability. → **Three layers; the etag is the strongest.**

Per F11 the only thing that protects `resultHash` is that the generated string is byte-identical across runs.

1. **Remove the volatile stamp from the stored variant.** `openCollectionExport.ts:239` writes `exportedAt: new Date().toISOString()` on every call. Add an options parameter; the entity path passes `exportedAt: null`, which omits the key entirely. The two router call sites (`router.ts:165`, `:176`) omit the option and keep today's behaviour byte-for-byte.
2. **Deterministic input order.** `readTree.ts:41-49` inserts files into the Map in archive order. `buildTreeForDir`/`buildTreeForDirYml` iterate `tree.files.keys()`, and `sortItems` (`collectionService.ts:1612-1630`) falls back to **insertion index** when `seq` is absent on both operands; `findBrunoJson` (`:779-789`) breaks equal-length ties by Map order. Sorting the admitted paths before reading contents makes item order a pure function of content, for both parse paths, at zero cost.
3. **Etag short-circuit (the real guarantee).** Cache the `readTree` etag. On revalidation a `NotModifiedError` returns the **same cached string instance** — regeneration never runs, so the question of determinism does not even arise for the common case. Determinism (1 + 2) covers the case where the sha moved but the collection folder did not.

**Deliberately not stamped: a generation timestamp or the source commit sha.** We have the sha for free (it *is* the etag), and `usebruno.com/source-commit` would be tempting for provenance — but the etag is the sha of the whole repo/branch, so any unrelated push would rewrite every Bruno entity in that repo and re-stitch it. Listed as Q4 in §8.

---

## 2. The size trade-off — measured, decided

**Measured, in this repo and against real collections:**

| Reference | Size |
|---|---|
| Existing `kind: API` entities in `examples/bruno-collections.yaml`, each with an inline OpenAPI `spec.definition` | 4,986 / 12,242 / 17,516 / 20,713 / 21,953 bytes per document |
| `bruno/packages/bruno-tests/yml-collection` — real OpenCollection layout, 4 request files + 2 envs + manifest | 13,231 bytes total; manifest itself 381 bytes ⇒ **~3 KB per request** |
| `bruno/packages/bruno-tests/collection` — 239 `.bru` files | 220,254 bytes of source ⇒ **~0.9 KB per request in `.bru`**, and OpenCollection YAML is not smaller |

⇒ **mid-size collection (40–80 requests): ~60–200 KB. A 239-request collection: ~300–600 KB.** Roughly **10× the OpenAPI definitions already inlined in this repo.**

**The cost path is real and unmitigated by the platform.** Per F10 the stock `EntityListProvider` sends no `fields` projection, so a Phase 3 dashboard built the standard way pulls every definition in full: 50 collections × 120 KB ≈ 6 MB per dashboard load. Per F9 the platform imposes no cap and the search index is unaffected, but `buildEntitySearch` still lowercases the full string at every stitch.

**Decision: inline (PRD-faithful), with a hard cap and an explicit, non-lossy fallback.**

- Cap: `bruno.definition.maxBytes`, default **1 MiB** (`1048576`), measured as `Buffer.byteLength(yaml, 'utf8')`. 1 MiB admits every realistic collection (the largest reference above is ~600 KB) while bounding the pathological case and the probe cache's memory.
- **On exceed: omit, never truncate.** A truncated YAML document is invalid and would break Phase 4's renderer with a parse error instead of an explanation. Concretely: `spec.definition` is not written, one `logger.warn` is emitted, and the entity is stamped
  `usebruno.com/definition-omitted: 'size'` and `usebruno.com/definition-bytes: '<n>'`.
  Both values are pure functions of content, so they do not churn `resultHash`. The entity still lands, still enriched, still related.
- Phase 4 falls back to the existing per-request route `GET /api/bruno/collections/:id/opencollection.yml` (`router.ts:169`) for oversized collections. Recorded here so Phase 4 plans for it; nothing is built for it in Phase 2.
- **Mitigation available to Phase 3, stated not implemented:** pass `fields: ['kind','metadata','spec.type','spec.url','spec.partOf','relations']` on a bespoke `queryEntities` call rather than using `EntityListProvider` unmodified (`catalog-client/dist/index.d.ts:420`).

**Rejected — storing only a URL/pointer.** That is exactly the architecture the PRD's first paragraph tears down ("From an annotation linked collection to an API, we want to remove all of this"), and it would leave Phase 4 fetching from `/api/bruno/*` per entity page, reintroducing the cross-plugin coupling BE-P1 removed.

---

## 3. Security — storing collection data on a catalog entity

> **REVISED 2026-08-31 by the requester, and this supersedes the original §3.**
> The YAML must come from the **same pipeline as Bruno's own "Generate docs"**,
> with no Backstage-only redaction on top. The bespoke redaction this section
> originally specified has been removed.

**What Bruno's "Generate docs" actually redacts — verified, not assumed.**
Both the desktop app (`bruno-app/.../GenerateDocumentation/index.js` →
`transformCollectionToSaveToExportAsFile` → `brunoToOpenCollection` →
`jsyaml.dump`) and the CLI (`bruno docs generate`) funnel through
`brunoToOpenCollection`. Redaction happens in exactly **one** place:

- `bruno-converters/src/opencollection/environment.ts:90-92` —
  `toOpenCollectionEnvironments` omits the **value** of an environment variable
  flagged `secret` and writes `secret: true` instead. Non-secret variables keep
  their values.

**What it does NOT redact**, verified by reading the source:
- **Auth values.** `bruno-converters/src/opencollection/common/auth.ts` contains
  zero redaction; `basic.password`, `bearer.token`, `digest.password`,
  `apikey.value`, `oauth2.clientSecret` are all copied through, and
  `transformCollectionToSaveToExportAsFile` copies them into the transform.
- **Header and query/path param values.**
- **Request bodies, `script.req`/`script.res`, `tests`, `docs`.**

Separately, the app and CLI both **exclude environments entirely** unless the
user opts in (a checkbox list in the app, `--envs` in the CLI).

**Decision: match Bruno exactly, everywhere.** One pipeline, Bruno's semantics,
no extra redaction — for both `GET /collections/:id/opencollection.yml` and the
entity's `spec.definition`. Rationale given by the requester: a collection
documented from Backstage and the same collection documented from Bruno must
produce the same document; a Backstage-only redaction pass makes the two
silently diverge and makes the Backstage-rendered docs worse than Bruno's for
the same input.

**The consequence, recorded rather than hidden.** `spec.definition` lives on a
catalog entity, readable by anything that can read the catalog — strictly
broader than the per-user, per-collection docs route. So a credential that is
**hardcoded** into a `.bru` file — in an auth block, a header value, a body, or
a script — reaches the catalog in plaintext. The mitigation is the same one
Bruno itself relies on: keep credentials in **secret environment variables** or
as `{{placeholders}}`, and they never enter the document. This is R8 and it is
accepted, not open.

**`bruno.definition.redaction` does not exist.** It was specified by the
original §3, implemented, and then removed when this decision was taken. Do not
reintroduce it without revisiting the Bruno-parity requirement above.

**`redactCollectionDetail` (`openCollectionExport.ts`) is unchanged and stays
strict.** It serves the plugin's own JSON detail endpoint
(`GET /collections/:id`), has no Bruno-parity obligation, and has never emitted
auth values or environment values. That asymmetry is deliberate; the code says
so at the function.

**Two things that remain true:** per F9 the definition never reaches
`entity_search` as a searchable value (`buildEntitySearch.cjs.js:69-79` nulls
anything over 200 chars), and per BE-P1 §5.10 `ManifestProbe` still has **no
`userToken` parameter** — every read uses the host's `integrations.*`
credential.

## 4. The `.yaml` body-parser defect — every site enumerated

BE-P1 §3.C made `opencollection.yaml` *detectable* but left the OpenCollection **body** parser reading only `.yml` (recorded there as R5, "inert in Phase 1; blocking for OpenCollection generation"). Phase 2 parses bodies, so it is now blocking. Complete enumeration:

| # | File:line | Current | Fix |
|---|---|---|---|
| 1 | `scm/treeFilter.ts:39-47` | `isCollectionFile` admits `.yml`, not `.yaml` | replaced by `selectCollectionFiles` (below) |
| 2 | `scm/github.ts:185` | `isCollectionFile(rel)` in the user-token blob walk | `selectCollectionFiles` two-pass |
| 3 | `service/collectionService.ts:648` | `entry.name.endsWith('.yml')` in `walkLocal` | `selectCollectionFiles` post-pass |
| 4 | `service/collectionService.ts:1307` | `if (!key.endsWith('.yml')) continue` (env files) | `isOpenCollectionBodyFile(key)` |
| 5 | `service/collectionService.ts:1311` | `key === envDir + '.yml'` | `key === envDir + '.yml' \|\| key === envDir + '.yaml'` |
| 6 | `service/collectionService.ts:1323` | `baseName(key).replace(/\.yml$/, '')` | `stripOpenCollectionExtension(baseName(key))` |
| 7 | `service/collectionService.ts:1379` | `if (!file.endsWith('.yml')) continue` (request files) | `isOpenCollectionBodyFile(file)` |
| 8 | `service/collectionService.ts:1383` | `file === 'opencollection.yml'` | `isOpenCollectionManifest(file)` (already exported) |
| 9 | `service/collectionService.ts:1384` | `file === 'folder.yml'` | `isFolderManifest(file)` |
| 10 | `service/collectionService.ts:1417` | `joinPosix(dir, 'folder.yml')` | try `folder.yml` then `folder.yaml`; first hit wins |
| 11 | `service/collectionService.ts:1512` | `baseName(key).replace(/\.yml$/, '')` | `stripOpenCollectionExtension(baseName(key))` |

Sites 4–11 move to `service/collectionParser.ts` in §5.B; the line numbers above are pre-move, for locating the code.

**`{ format: 'yml' }` is a dialect, not an extension.** `node_modules/@usebruno/filestore/dist/types.d.ts` — `export type CollectionFormat = 'bru' | 'yml'`. Every `parseRequest`/`parseFolder`/`parseEnvironment`/`parseCollection` call keeps `{ format: 'yml' }` unchanged; a `.yaml` file's *contents* parse identically.

**Tree admission needs two passes, not a wider predicate.** BE-P1 §3.A rejected a blanket `.yaml` clause because `commonRootPrefix` (`collectionService.ts:890-908`) is the fallback collection root when no manifest is found (`:731`, `:1247`), and a stray root-level `.yaml` would shift it and mis-root manifest-less collections on the `bruno.sources` path. That objection still holds — so the fix is not a wider per-path predicate but a **set-aware selection**:

```ts
// scm/treeFilter.ts
export function selectCollectionFiles(paths: Iterable<string>): string[]
```
- Always admits `.bru`, `bruno.json`, `.yml`, `opencollection.yaml`, `readme.md` — byte-identical to today's `isCollectionFile`.
- Additionally admits `*.yaml` **only if** the set contains at least one `opencollection.yaml`, and only for paths at or below that manifest's directory.
- Returns the result **sorted lexicographically** (this is layer 2 of Q4).

`isCollectionFile` is kept and exported (it is the per-path core `selectCollectionFiles` uses) so nothing else needs to move.

**Known consequence, accepted:** when `opencollection.yaml` sits at the tree root, root-level `.yaml` files such as `catalog-info.yaml` are admitted and then reach `parseRequestFileYml`, which already guards `parseRequest` in a try/catch and logs one `warn` before skipping (`collectionService.ts:1459-1466`). That is at most one warn per stray file per genuine re-parse (≤ once per `cacheTtlSeconds`). A deny-list of well-known filenames was rejected as arbitrary and unmaintainable.

---

## 5. Ordered edit list

> **Superseded in part.** Every mention of a `redaction` option / `RedactionMode`
> / `bruno.definition.redaction` below (§5.F.3-4, §5.G, §5.H.3, §5.I, §5.N, §5.O)
> was implemented and then **removed** when §3 was revised — the export now
> mirrors Bruno's "Generate docs" with no Backstage-only redaction. Read those
> items for the rest of their content; ignore the redaction plumbing.


Order matters. A→B are the lowest layer and compile standalone; C depends on B; D–E on B/C; F on D–E; G–J on F.

### A. `plugins/bruno-backend/src/scm/treeFilter.ts` — shared predicates + selection

Keep `OPEN_COLLECTION_MANIFEST_NAMES`, `isOpenCollectionManifest`, `isBrunoJsonManifest`, `isCollectionFile` **as they are**. Add:

```ts
/** Both accepted spellings of an OpenCollection body file. `format:'yml'` in
 *  @usebruno/filestore is a DIALECT name, not an extension — both spellings
 *  parse identically (filestore dist/types.d.ts: CollectionFormat='bru'|'yml'). */
export function isOpenCollectionBodyFile(relPath: string): boolean;

/** `folder.yml` or `folder.yaml`, at any depth or as a bare filename. */
export function isFolderManifest(relPath: string): boolean;

/** Drops a trailing `.yml`/`.yaml`. Used for the request-name fallback. */
export function stripOpenCollectionExtension(name: string): string;

/**
 * Chooses the files a collection parse needs, from the FULL path set, and
 * returns them sorted.
 *
 * Set-aware rather than per-path because a bare `.yaml` cannot be classified
 * in isolation: a blanket clause would pull `catalog-info.yaml` and
 * `.github/**` into the tree and shift `commonRootPrefix` — the fallback
 * collection root when no manifest is found — silently mis-rooting
 * manifest-less collections on the `bruno.sources` path.
 *
 * Sorted because item order is otherwise archive order: `sortItems` falls back
 * to insertion index when `seq` is absent, so an unsorted tree makes the
 * generated definition non-deterministic and rewrites the entity every cycle.
 */
export function selectCollectionFiles(paths: Iterable<string>): string[];
```

### B. `plugins/bruno-backend/src/scm/readTree.ts` — etag-aware sibling

Add, above `readTreeViaUrlReader`:

```ts
export interface ScmTreeRead {
  files: ScmFileTree;
  /** The reader's tree identity — the commit sha for all three providers.
   *  Feed it back as `etag` to get a NotModifiedError instead of a download. */
  etag: string;
}

export async function readTreeWithEtag(args: {
  reader: UrlReaderService;
  url: string;
  logger: LoggerService;
  etag?: string;
  userToken?: string;
}): Promise<ScmTreeRead>;
```

Body = today's `readTreeViaUrlReader` (`:32-50`) with three changes: pass `etag` through to `reader.readTree`, return `response.etag`, and replace the per-file `isCollectionFile` filter with `selectCollectionFiles(treeFiles.map(f => f.path.split('\\').join('/')))` followed by a content read in the returned (sorted) order.

`readTreeViaUrlReader` becomes a one-line delegate returning `.files`, so `gitlab.ts:178` (`readTreeWithUserToken`, typed `Promise<ScmFileTree>`) and `collectionService.ts:672` are untouched. **Do not** change `readTreeViaUrlReader`'s signature — that would break the `ScmProvider.readTreeWithUserToken` contract (`scm/types.ts:110`).

Update the doc comment: it says "`files()` is called exactly once here" — still true — and must now note that `NotModifiedError` propagates to the caller.

### C. `plugins/bruno-backend/src/scm/index.ts`

Extend the export block at `:14-15`:
```ts
export { readTreeViaUrlReader, readTreeWithEtag } from './readTree';
export type { ScmTreeRead } from './readTree';
export {
  isCollectionFile,
  isOpenCollectionManifest,
  isBrunoJsonManifest,
  isOpenCollectionBodyFile,
  isFolderManifest,
  stripOpenCollectionExtension,
  selectCollectionFiles
} from './treeFilter';
```

### D. `plugins/bruno-backend/src/scm/github.ts` — site 2

In `readTreeWithUserToken` (`:148-196`), replace the per-entry `isCollectionFile(rel)` test at `:185` with a two-pass: build the candidate `rel` list from `tree.tree` first, run `selectCollectionFiles` over it, then fetch blobs in the returned sorted order. This both fixes the `.yaml` defect on this path and reduces blob calls. The `tree.truncated` warn at `:171-175` stays (see R5).

### E. **NEW** `plugins/bruno-backend/src/service/collectionParser.ts` — pure extraction from `collectionService.ts`

**Why this and not the alternatives.** Phase 2 needs a `NormalizedCollection`, and the only parser is `parseCollection` (`collectionService.ts:728`, bru) / `parseCollectionYml` (`:1247`, yml), both module-private. BE-P1 §3.D deliberately kept the `kind: Bruno` spine free of `collectionService.ts` because later phases delete that module wholesale. That decision is **honoured, not revisited**, by moving the part that *survives* — the parser — into its own module:

- **Rejected: export `parseCollection` and import it.** Cheapest, but it hangs the entire Bruno spine off the 1,668-line module slated for deletion. (`BrunoCollectionEntityProvider.ts:12` already imports `sanitizeName` from there, so the wall is not absolute — but `sanitizeName` is six lines that move trivially, whereas the parser is ~950.)
- **Rejected: duplicate the parser.** ~950 lines, guaranteed drift between the docs route and the entity.
- **Chosen: extract.** One direction only: `collectionService.ts` → `collectionParser.ts`, and `definitionBuilder.ts` → `collectionParser.ts`. No cycle. When the annotation-model service, router and stores are deleted, `collectionParser.ts` stays.

**Exact move (pure cut/paste, no logic change except the §4 fixes):**

Move **out of** `collectionService.ts`:
- types `RawRequest` (`:73-91`), `RawCollectionBru` (`:92-100`), `RawEnv` (`:102-114`), `FileTree` (`:116-118`)
- consts `BODY_MODES` (`:151-158`), `AUTH_MODES` (`:160-165`)
- everything from the `/* Parsing / normalization */` banner (`:720`) to EOF (`:1668`)

Move **with it** these imports: `path` (for `toPosix`), `@usebruno/lang` (`bruToJsonV2`, `collectionBruToJson`, `bruToEnvJsonV2`), `@usebruno/filestore` (`parseRequest`, `parseCollection as parseYmlCollection`, `parseFolder as parseYmlFolder`, `parseEnvironment as parseYmlEnvironment`), the `../types` types actually referenced, and from `../scm`: `isBrunoJsonManifest`, `isOpenCollectionManifest`, `isOpenCollectionBodyFile`, `isFolderManifest`, `stripOpenCollectionExtension`.

**Exported from `collectionParser.ts`:** `parseCollection`, `countRequests`, `findAllCollectionRoots`, `sliceTreeAtRoot`, `toPosix`, and `export type { FileTree }`. (`toPosix` must be exported because `walkLocal` in `collectionService.ts` still uses it.) Everything else stays module-private.

**`collectionService.ts` retains:** `readBrunoSources`, `sanitizeName`, `collectionIdFromUrl`, `createCollectionService`, `readLocalTree`, `walkLocal`, `readUrlTree`, `readUrlTreeWithCreds`, `resolveRef`, and its `CachedCollection`/`ConnectedEntry`/`DiscoverEntry`/`CollectionService` declarations, plus imports from `./collectionParser`.

Apply the §4 fixes (sites 4–11) **in the new file**, and in `walkLocal` (site 3) rebuild `files` through `selectCollectionFiles` as a post-pass so local trees get the same admission and the same sorted order.

**Verification net:** `yarn tsc` at 0 errors is the proof the move is complete. Anything missed surfaces as a compile error, not as a runtime surprise.

**Explicitly out of scope of the move:** `sanitizeName` and `collectionIdFromUrl` stay in `collectionService.ts`. They are not parsing, and `BrunoCollectionEntityProvider.ts:12` already depends on the former; relocating them is a later-phase cleanup.

### F. `plugins/bruno-backend/src/service/openCollectionExport.ts` — signature, stamp, redaction

1. **Signature:** `toOpenCollectionYaml(detail: CollectionDetail)` (`:232`) → `toOpenCollectionYaml(collection: NormalizedCollection, options?: OpenCollectionExportOptions)`. The body only ever used `detail.collection` (`:233`), so this removes a synthetic-object requirement from the new caller.
   ```ts
   export interface OpenCollectionExportOptions {
     /** ISO timestamp for `extensions.bruno.exportedAt`. `null` OMITS the key —
      *  required for the catalog-stored variant: a per-call timestamp changes
      *  `resultHash` every reprocess cycle and rewrites the entity. Default:
      *  `new Date().toISOString()`, preserving today's route behaviour. */
     exportedAt?: string | null;
     /** `'standard'` (default) or `'strict'`. See BE-P2 §3. */
     redaction?: 'standard' | 'strict';
   }
   ```
2. **Stamp:** at `:235-242`, write `exportedAt` only when the resolved value is a string.
3. **Redaction — `standard`:** add `SECRET_NAME_PATTERN` and a `redactNamedValues(pairs)` helper; apply it to `item.headers` and `item.params` inside `mapRequest` (`:186-203`). A value matching `/^\{\{.*\}\}$/` after trimming passes through untouched (it is a reference, mirroring `generateCollectionHtml`'s `maskSecret`).
4. **Redaction — `strict`:** additionally `script: { req: null, res: null }`, `tests: null`, and `mapBody` returns `{ mode, [mode]: REDACTED }` for raw modes and `[]` for form modes.
5. Rewrite the module doc comment: R-D (`:21`) is now partially closed (headers/params by name) and the exact residual — bodies, scripts, tests under `standard` — is named, with a pointer to BE-P2 §3.
6. **`redactCollectionDetail` (`:96-109`) is unchanged.**

### G. **NEW** `plugins/bruno-backend/src/service/definitionBuilder.ts`

One small pure module, so `manifestProbe.ts` stays about caching:

```ts
export interface BuiltDefinition {
  /** The OpenCollection 1.0.0 YAML, or undefined when it could not be
   *  produced or exceeded the cap. */
  definition?: string;
  /** Byte length of what WOULD have been stored. 0 when generation failed. */
  bytes: number;
  /** Set only when `definition` is undefined. */
  omitted?: 'size' | 'error';
}

export interface DefinitionOptions {
  maxBytes: number;
  redaction: 'standard' | 'strict';
}

export function buildDefinition(input: {
  tree: Map<string, string>;
  /** Normalized collection URL — seeds the parser's fallback name/id. */
  url: string;
  /** Manifest name, when the probe found one. */
  name?: string;
  logger: LoggerService;
  options: DefinitionOptions;
}): BuiltDefinition;
```

Body: build the `BrunoSourceConfig` shim `{ id: url, name: name ?? lastPathSegment(url), type: 'url', target: url }` → `parseCollection(source, { files: tree }, logger)` → `toOpenCollectionYaml(normalized, { exportedAt: null, redaction })` → measure `Buffer.byteLength(yaml,'utf8')` → return.

**Everything is inside one `try/catch`.** On a throw: `logger.warn` naming the URL and the message, return `{ bytes: 0, omitted: 'error' }`. Never rethrow — a parse failure must degrade the entity, not delete it (F3).

Imports: `./collectionParser`, `./openCollectionExport`. No import of `collectionService.ts`, `manifestProbe.ts`, or anything under `provider/` or `processor/` — one direction only.

### H. `plugins/bruno-backend/src/service/manifestProbe.ts` — snapshot + etag + TTL

1. **New exported type**, beside `CollectionManifest` (`:42-51`):
   ```ts
   /** A manifest plus the generated OpenCollection definition for the whole
    *  collection. One `readTree` produces both, so the processor and the
    *  provider share a single fetch. */
   export interface CollectionSnapshot extends CollectionManifest {
     /** OpenCollection YAML, redacted per `bruno.definition.redaction`.
      *  Undefined when generation failed or the cap was exceeded. */
     definition?: string;
     definitionBytes: number;
     definitionOmitted?: 'size' | 'error';
   }
   ```
2. **Widen `probe`** (`:57`) to `probe(url: string): Promise<CollectionSnapshot | undefined>`. `CollectionSnapshot` is assignable to `CollectionManifest`, so `BrunoCollectionEntityProvider.ts:91` (`let manifest: CollectionManifest | undefined`) still compiles with **zero changes**. `evict` and `normalize` are unchanged.
3. **Options** gain `definition: DefinitionOptions` (required — the caller reads it from config) and keep `ttlMs`/`failureTtlMs`/`max`.
4. **Cache entry** (`:66-69`) gains `etag?: string` on the `found` and `absent` variants.
5. **`probe` body** (`:130-165`):
   - Fresh-within-TTL hit → `unwrap(cached)` unchanged.
   - Stale hit **with** an etag → `readTreeWithEtag({ reader, url: normalized, logger, etag })`. On `NotModifiedError` (`import { NotModifiedError } from '@backstage/errors'`, already a declared dependency, `package.json:28`): rewrite `fetchedAt` on the **existing** entry via `lruSet` and return the **same** value object. Do not regenerate. Log at `debug`, never `info` — this is the hot path.
   - Any other outcome → today's flow, plus `buildDefinition(...)` on the `found` branch and the new `etag` stored on the entry.
   - `absent` entries also store the etag, so a repo with no manifest is revalidated cheaply too.
6. **`DEFAULT_TTL_MS`** (`:34`) `5 * 60_000` → `60_000`, overridable. Justification in the comment: with etag revalidation the marginal cost of a shorter TTL is one metadata API call, not a tarball download plus a full parse (F12), and a five-minute window makes the PRD's Sync button look broken.
7. **`DEFAULT_MAX`** (`:36`) `200` → `100`, with the memory bound in the comment: `max × bruno.definition.maxBytes` is the worst case (100 MiB at the 1 MiB cap; ~15 MB at realistic sizes).
8. **`evict`** (`:170-172`) — unchanged code, updated doc comment stating that Phase 2 deliberately does not call it and why (BE-P2 §1 Q3), so nobody wires a cross-plugin import to reach it.
9. Rewrite the module header: it now also parses and generates; **the "no `userToken` parameter, ever" paragraph (`:11-15`) stays verbatim and no `userToken` is added.**

### I. `plugins/bruno-backend/src/service/brunoConfig.ts` — two readers

Append, in the same tolerant style as `readBrunoCollections`:

```ts
/** Reads `bruno.definition`. Both fields are optional; an unrecognised
 *  `redaction` value logs and falls back to 'standard'. */
export function readDefinitionOptions(
  config: Config, logger?: LoggerService
): DefinitionOptions;

/** Reads `bruno.cacheTtlSeconds` as milliseconds. Undefined when unset, so
 *  the probe keeps its own default. */
export function readCacheTtlMs(config: Config): number | undefined;
```

Home justification unchanged from BE-P1 §3.I: this is the Bruno spine's config reader and it imports nothing from `collectionService.ts`.

### J. `plugins/bruno-backend/src/processor/BrunoKindProcessor.ts`

1. **Schema** (`:78-112`) — add after `partOf`:
   ```
   definition: {
     type: 'string',
     description:
       'The generated OpenCollection YAML for the whole collection. Written by '
       + 'the processor; any authored value is overwritten. Absent when '
       + 'generation failed or the collection exceeded `bruno.definition.maxBytes`.',
     examples: ['opencollection: 1.0.0\\ninfo:\\n  name: My Collection\\n']
   }
   ```
   **No `minLength`** — unlike `kind: API` (F8). A `''` reaching `validateEntityKind` throws, which makes the run `ok:false` and deletes the entity (F3). Not added to `spec.required` for the same reason: degraded entities must validate. Update the top-level `examples` block (`:54-69`) accordingly.
2. **Annotation constants** — add beside `SOURCE_LOCATION_ANNOTATION` (`:22`):
   `usebruno.com/definition-omitted`, `usebruno.com/definition-bytes`. The `usebruno.com/*` prefix matches the existing keys in `examples/bruno-collections.yaml:31-33`.
3. **`preProcessEntity`** (`:164-246`) — after the manifest branch, before the metadata precedence block:
   ```ts
   const definition = manifest.definition;
   const omitted = manifest.definitionOmitted;
   ```
   Extend the annotation object built at `:213` with, when `omitted` is set, `{'usebruno.com/definition-omitted': omitted, 'usebruno.com/definition-bytes': String(manifest.definitionBytes)}` — and, when it is not set, **delete** any stale values of those two keys, so an over-cap collection that later shrinks stops claiming to be omitted.
4. **No-change guard** (`:224-231`) — extend with `&& definition === (entity as BrunoEntity).spec.definition` and an annotation comparison. Keep the existing comment noting this is an allocation guard, not a correctness one (F11).
5. **Return** (`:233-245`) — add a `spec` key:
   ```ts
   spec: {
     ...(entity as BrunoEntity).spec,
     ...(definition !== undefined && { definition })
   }
   ```
   Never mutate the input. Note in a comment that when `definition === undefined` the previous value is left in place: a transient generation failure must not blank a good definition.
6. **Degraded paths** (`:191`, `:200`) — unchanged. `withSourceLocation` (`:257-280`) is unchanged. Nothing new throws; nothing new emits an error result (F3).
7. Extend the class doc comment (`:127-145`) with the generation responsibility and the "processor overwrites `spec.definition`, authored metadata wins for title/description/version" asymmetry, with the reason.

### K. `plugins/bruno-backend/src/types.ts`

`BrunoEntity.spec` (`:222-232`) gains:
```ts
    /** The generated OpenCollection YAML for the whole collection. Written by
     *  BrunoKindProcessor; never authored. Absent when generation failed or
     *  the collection exceeded `bruno.definition.maxBytes`. */
    definition?: string;
```
No other type changes here — `DefinitionOptions` and `BuiltDefinition` live in `definitionBuilder.ts`, `CollectionSnapshot` in `manifestProbe.ts`, next to their implementations.

### L. `plugins/bruno-backend/src/module.ts`

At `:65`, thread the config through:
```ts
const probe = createManifestProbe({
  config, reader, logger,
  ttlMs: readCacheTtlMs(config),
  definition: readDefinitionOptions(config, logger)
});
```
Import the two readers from `./service/brunoConfig`. No `deps` change; no `moduleId` change; provider and processor registrations (`:67-79`) are otherwise untouched.

### M. `plugins/bruno-backend/src/index.ts`

- `:31` → `export type { CollectionManifest, CollectionSnapshot, ManifestProbe } from './service/manifestProbe';`
- Add `export { readBrunoCollections, readCacheTtlMs, readDefinitionOptions } from './service/brunoConfig';` (replacing the single export at `:25`).
- `createCollectionService` (`:26`) is unchanged; `collectionParser.ts` and `definitionBuilder.ts` are **not** re-exported — they are internals with no external consumer, and exporting them would be dead surface.

### N. `plugins/bruno-backend/config.d.ts`

Insert after the `collections` block, before `schedule`:
```ts
    /**
     * How long a fetched collection stays cached before the probe revalidates
     * it. Revalidation is an ETag check — one metadata API call, not a tree
     * download — so a short value is cheap. This is also the upper bound on
     * how long a Sync (catalog entity refresh) takes to show new content.
     * Default 60.
     * @visibility backend
     */
    cacheTtlSeconds?: number;
    /**
     * Controls the OpenCollection YAML stored on each `kind: Bruno` entity.
     * @visibility backend
     */
    definition?: {
      /**
       * Hard cap on the stored YAML, in bytes. Over the cap the definition is
       * OMITTED (never truncated — a truncated document is invalid YAML) and
       * the entity is annotated `usebruno.com/definition-omitted: size`.
       * Default 1048576.
       * @visibility backend
       */
      maxBytes?: number;
      /**
       * How much to strip before storing. `standard` drops environment values,
       * auth secrets, and header/param values whose NAME looks secret.
       * `strict` additionally drops request bodies, scripts and tests.
       * Applies only to the entity copy; `/api/bruno/collections/:id/
       * opencollection.yml` is unaffected. Default `standard`.
       * @visibility backend
       */
      redaction?: 'standard' | 'strict';
    };
```
`@visibility backend` on every field — none of this reaches the browser.

### O. `app-config.yaml`

Under `bruno:` (`:148`), between `collections:` (`:162-166`) and `schedule:` (`:167`):
```yaml
  # PRD §"Post ingestion" / §"Entity Sync". The generated OpenCollection YAML
  # is stored inline on each Bruno entity's `spec.definition`, mirroring how a
  # kind: API entity stores its OpenAPI document.
  #
  # SECURITY: an entity is readable by anything that can read the catalog, which
  # is strictly broader than the per-user, per-collection
  # /api/bruno/collections/:id/opencollection.yml route. `standard` redacts
  # environment values, auth secrets, and header/param values with secret-looking
  # names; it does NOT redact request bodies, scripts or tests. Set `strict` if
  # your collections carry credentials in those places.
  definition:
    maxBytes: 1048576
    redaction: standard
  # Also the upper bound on how long a Sync takes to show new content.
  cacheTtlSeconds: 60
```
`catalog.rules`, the `bruno-entity.yaml` location entry, `sources`, `collections` and `schedule` are **unchanged**.

### P. `examples/bruno-entity.yaml`

**Comment-only change.** Append to the header comment: `spec.definition` is generated and stored by the processor, is never authored, and any authored value is overwritten. The entity body is unchanged.

---

## 6. Consumers and call sites

| Call site | Change |
|---|---|
| `service/router.ts:165` | `toOpenCollectionYaml(detail)` → `toOpenCollectionYaml(detail.collection)`. No options ⇒ byte-identical output to today. |
| `service/router.ts:176` | Same. |
| `service/manifestProbe.ts:145` | `readTreeViaUrlReader` → `readTreeWithEtag`, plus etag plumbing (§5.H). |
| `service/collectionService.ts:672` | **No change** — `readTreeViaUrlReader` keeps its signature. |
| `scm/gitlab.ts:178` | **No change** — same reason. |
| `scm/github.ts:185` | Two-pass `selectCollectionFiles` (§5.D). |
| `service/collectionService.ts` (imports at `:1-52`, body at `:720-1668`) | Parser extracted to `collectionParser.ts`; imports rebalanced (§5.E). |
| `provider/BrunoCollectionEntityProvider.ts` | **No change.** `probe()`'s widened return type is assignable to the `CollectionManifest` annotation at `:91`. The provider must **not** write `spec.definition` — identity is its job, enrichment is the processor's (BE-P1 §1). |
| `module.ts:65` | Probe gains `ttlMs` + `definition` (§5.L). |
| `module.ts:79` | **No change** — `new BrunoKindProcessor({ logger, probe })` still. |
| `index.ts:25`, `:31` | Extended (§5.M). |
| `packages/backend/src/index.ts` | **No change.** `brunoCatalogModule` already registered. |
| `packages/app/**`, `plugins/bruno/**` | **No change.** Phase 2 is backend-only. |
| `plugin.ts` | **No change.** No new routes, no `addAuthPolicy` change. |

**Routes:** zero added, zero changed. **Auth policies:** unchanged — `/health` unauthenticated, `/collections/:id/docs` `user-cookie` (`plugin.ts:77-92`). **Cross-plugin boundary:** none crossed; the probe reads git through the injected `UrlReaderService` and never touches the catalog's DB or the `bruno` plugin's.

---

## 7. Cannot deliver

**1. Sync does not re-read `bruno.collections[]` on click.** `DefaultRefreshService` re-runs processors, never providers (F13), and 1.53 has no on-demand provider trigger. So for a config-created entity, clicking Sync re-fetches the collection and regenerates the definition — but a change to `partOf`, `name`, or `url` in `app-config.yaml` is picked up only on `BrunoCollectionEntityProvider`'s next scheduled tick (`bruno.schedule.frequencySeconds`, default 60 s). Authored `catalog-info.yaml` entities do not have this gap: their location *is* re-read on refresh. Not worth a bespoke provider-trigger route to close a 60-second gap that closes itself.

**2. Sync is "within `cacheTtlSeconds`", not instantaneous.** The probe cache is shared by design (BE-P1 §3.D) and is not reachable from an HTTP handler in the same plugin (§1 Q3). With the default 60 s TTL a click converges within a minute. `ManifestProbe.evict` exists as the seam and is deliberately not wired.

**3. `spec.definition` cannot be a required field on `kind: Bruno`.** `kind: API` requires it (F8); we cannot, because a collection whose repo is unreachable, whose manifest is missing, or which exceeds the cap must still land as a degraded entity, and a validation failure would make the run `ok:false` and delete it (F3).

**4. Carried forward, unchanged from BE-P1 §6:** `metadata.name` cannot be optional for an authored `catalog-info.yaml` (F1). (The PRD's "infer information from comments in the yaml" was clarified by the requester to mean the inline comments in the PRD's own snippet — not a runtime feature — and is already satisfied.)

Nothing else in the two PRD sections is undeliverable.

---

## 8. Risks and open questions

**Risks**

- **R1 — fetch amplification at the lower TTL.** With `cacheTtlSeconds: 60`, the 60 s provider tick and the 100–150 s per-entity reprocess both land on a cold-ish cache, giving up to ~1 revalidation per URL per minute. For N collections that is ~60·N GitHub API calls per hour against a 5,000/h authenticated budget — comfortable to ~50 collections, tight beyond. Mitigations, all one-liners: raise `bruno.cacheTtlSeconds`, raise `bruno.schedule.frequencySeconds`, or set `catalog.processingInterval`. Without etag support this would have been *tarball downloads*, which is why F12 is load-bearing.
- **R2 — event-loop blocking.** `parseCollection` is synchronous over the whole tree. A 239-request collection is ~220 KB of source; expect tens of milliseconds. Bounded to once per collection per genuine content change, because `NotModifiedError` short-circuits everything else.
- **R3 — cache memory.** Worst case `DEFAULT_MAX` (100) × `definition.maxBytes` (1 MiB) = 100 MiB; realistic ~15 MB. Bounded by construction, unlike caching raw trees (which is why trees are transient within a probe call and never cached).
- **R4 — dashboard payload.** Per F10 nothing projects fields, so Phase 3's table will pull every definition. 50 collections × 120 KB ≈ 6 MB per load. Phase 3 must either pass `fields` on a bespoke fetch or paginate. Flagged here so Phase 3 does not discover it late.
- **R5 — truncated GitHub trees.** `github.ts:171-175` warns when `tree.truncated` and then proceeds, so the user-token path can silently produce a *partial* definition that is then stored on the entity as if complete. This path is unreachable from the probe (BE-P1 removed the user-token surface from the spine), but it is reachable from `bruno.sources` via `readUrlTreeWithCreds`. Left as-is; noted.
- **R6 — stray `.yaml` files in a root-level OpenCollection repo.** §4 accepts one `warn` per stray file per genuine re-parse.
- **R7 — an entity rewritten by an unrelated push.** Not a risk in the chosen design, because the etag only *suppresses* regeneration; when the sha moves we regenerate and the deterministic output usually compares equal, so `resultHash` is unchanged and the engine takes `markSuccessfulWithNoChanges`. This is exactly why the `usebruno.com/source-commit` annotation is rejected (Q4 below) — stamping the sha would convert a no-op into a rewrite.
- **R8 — residual secret exposure.** §3, point 4 of the MUST list. Bodies, scripts and tests are stored in plaintext under the default `standard` mode.

**Open questions for the requester**

- **Q1 — should `bruno.definition.redaction` default to `strict`?** `standard` keeps bodies, scripts and tests, which is what makes the Phase 4 docs tab useful, but those are also the likeliest carriers of hardcoded credentials. Changing the default is one line and no code.
- **Q2 — is 1 MiB the right cap,** and is "omit + annotate + fall back to the existing route" the right behaviour, versus refusing to ingest the entity at all?
- **Q3 — should `spec.definition` carry `requestCount` / `environmentCount` alongside it?** Phase 3's dashboard needs "Number of requests" and "Number of unique environments"; deriving them client-side means parsing a 100 KB YAML per table row. `countRequests` and `collection.environments.length` are free at generation time. Excluded from Phase 2 to avoid shipping unused fields; decide before Phase 3 starts.
- **Q4 — provenance.** We get the source commit sha for free (it is the reader's etag). Stamping `usebruno.com/source-commit` would give Phase 3/4 a real staleness signal — but the sha is the *repo* head, not the collection folder, so every unrelated push would rewrite every Bruno entity in that repo and re-stitch it (R7 inverted). Recommended: do not stamp. Confirm.
- **Q5 — should `usebruno.com/collection-format: bru|yml` be stamped?** Free from the manifest, deterministic, and the exact key already appears at `examples/bruno-collections.yaml:33`. Excluded because nothing in Phase 2 reads it.
- **Q6 — carried over from BE-P1 and still unanswered:** Q3 (fatal vs. warned unparseable `partOf`), Q5 (`spec.type` enum).

---

## 9. Verification

**Gate commands, from the repo root; all must pass.**

```
yarn tsc
yarn lint:bruno <every touched file>
yarn prettier:check
```

`yarn tsc` must report **0 errors** — the binding per-commit gate, and the completeness proof for the §5.E extraction. **No tests are added; `yarn test` is not a gate.**

**Live boot check** — `yarn start`, then confirm all of:

1. **Backend starts clean.** No `No processor recognized the entity …` for `bruno:default/my-bruno-collection`; no unhandled rejection from the provider's first tick.
2. **Definition lands.** `spec.definition` on the entity is a YAML document beginning with the OpenCollection version key and containing `info:`.
3. **No volatile stamp.** `spec.definition` contains zero occurrences of `exportedAt`; the route copy still has exactly one.
4. **Byte-stability across cycles — the key check.** Record `metadata.etag`, wait ~6 minutes (≥ two reprocess cycles at 100–150 s), re-read. `metadata.etag` must be **identical**. A changed etag means the definition is not byte-stable and the entity is being rewritten every cycle (F11).
5. **Revalidation is cheap.** In the same window, `Reading Bruno collection tree via UrlReader:` must appear **once per distinct URL at most**, not once per TTL window.
6. **Redaction holds.** Every `variables[].value` absent with `secret: true` present; auth secrets read `<redacted>`; an `Authorization` header value is `<redacted>` while a `{{token}}` placeholder passes through verbatim; a plain `Accept: application/json` header is untouched.
7. **`strict` mode works.** Scripts, tests and body content gone from `spec.definition`; the `/opencollection.yml` route response **unchanged**.
8. **Cap works, non-lossy.** With `maxBytes: 1024`, `spec.definition` is **absent**, `usebruno.com/definition-omitted == "size"`, `usebruno.com/definition-bytes` plausible, and the entity still returns **200** with title/description/version/relations intact.
9. **Sync works, both entry points.** `POST /api/catalog/refresh` returns 200; a pushed change appears in `spec.definition` within `cacheTtlSeconds` and `metadata.etag` changes.
10. **`.yaml` end-to-end.** A collection whose manifest is `opencollection.yaml` and whose request/environment/folder files are `.yaml` must produce a `spec.definition` containing the requests and environments — not an empty `items: []`. This is the only check that catches a missed site from §4.
11. **No regression on the legacy path.** `/api/bruno/health` 200; `/api/bruno/collections` unchanged; `/docs` still renders; `/opencollection.yml` byte-identical to `main` apart from `exportedAt`; existing `kind: API` entities unchanged.
12. **Failure is degraded, never fatal.** A corrupt request file ⇒ exactly one `warn`, entity **200**, bad request omitted. An unreachable URL ⇒ one `error`, entity still 200, no `spec.definition` written and no previously-good definition blanked.
13. **No token in any log line.** Grep the boot log for `$GITHUB_TOKEN`; zero hits.
