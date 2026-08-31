# BE-P1 — Bruno Entity Kind, Phase 1 — **LOCKED**

**Branch:** `feat/bruno-entity-kind` · **Spec:** `docs/Bruno Backstage Plugin PRD - Entity.md` (sole source of truth)

**Scope:** PRD §"Introducing a new Entity Kind: Bruno", §"Ingesting Bruno Collection", §"Creating Bruno entities, other than catalog-info.yaml".

**Out of scope:** OpenCollection post-ingestion generation/storage, Entity Sync, Bruno Dashboard, Bruno entity page, Bruno Card on API entities, add-collection-via-UI/PR flow.

> Paths below were re-verified against the installed packages by the orchestrator. Note the catalog-backend internals live under `dist/processing/` and `dist/database/operations/stitcher/`.

---

## 0. Non-negotiable platform facts

**F1 — `metadata.name` cannot be optional, and cannot be enriched.**
`EntityEnvelope.schema.json` sets `required: ['apiVersion','kind','metadata']` with `metadata.required: ['name']`. `dist/processing/DefaultCatalogProcessingOrchestrator.cjs.js:44` runs `validateEntityEnvelope(entity)` **before any processor**, and `:52` freezes `context.entityRef = stringifyEntityRef(entity)`; `:166-168` throws `ConflictError('Fatal: The entity kind, namespace, or name changed during processing')` if a processor altered it. A `kind: Bruno` catalog-info.yaml **must** author `metadata.name`. The manifest's name lands in `metadata.title`, not `metadata.name`.

**F2 — `metadata.version` is legal, no special handling.**
`Entity.schema.json` is `additionalProperties:false` at root but `metadata` is `$ref: EntityMeta`, and `EntityMeta.schema.json` is `additionalProperties: true`. `apiVersion` is only `{type:'string',minLength:1}`, so `usebruno.com/v1alpha1` passes untouched.

**F3 — emitting `processingResult.*Error` is FATAL on first ingestion.**
`dist/processing/DefaultCatalogProcessingOrchestrator.cjs.js:86` sets `ok: collectorResults.errors.length === 0`. `dist/processing/DefaultCatalogProcessingEngine.cjs.js:164-194`: when `!result.ok` the engine calls `updateProcessedEntityErrors` and **returns without calling `updateProcessedEntity`**. `dist/database/operations/stitcher/performStitching.cjs.js:57-62` then returns `"abandoned"` when `processedEntity` is null — **the entity never appears in the catalog**. The missing-manifest path **must use `logger.error` only** and must never emit a processing error result or throw.

**F4 — default reprocessing cadence is 100–150 s per entity.**
`dist/service/CatalogBuilder.cjs.js:575-578` uses `createRandomProcessingInterval({minSeconds:100,maxSeconds:150})` when `catalog.processingInterval` is unset; `app-config.yaml` does not set it. Caching is mandatory, not an optimisation.

**F5 — `ajv` resolves `$ref: 'Entity'` transitively.** The WIP schema's `allOf: [{ $ref: 'Entity' }, …]` shape is sound.

**F6 — enum mismatch on `kind`/`apiVersion` is the "not mine" signal.** `entityKindSchemaValidator` returns `false` only when every error is an `enum` error at `/kind` or `/apiVersion`; anything else throws. The WIP's `validator(entity) !== false` idiom is correct.

**F7 — refresh semantics.**
- `DefaultRefreshService` marks the entity + its `location:` ancestors for reprocessing — re-runs **processors**, never providers.
- `plugin-catalog/dist/components/AboutCard/AboutCard.esm.js`: `allowRefresh = entityLocation?.startsWith("url:") || entityLocation?.startsWith("file:")`.
- Provider entities get `refresh_state_references` rows keyed by `source_key`, so they are never orphaned regardless of the location annotation.
- `readLocation` is gated on `isLocationEntity(entity)`, so a `url:` location annotation on a `kind: Bruno` entity is **never dereferenced**.
- `CatalogBuilder.cjs.js:459-467` swaps `BuiltinKindsEntityProcessor` for `ModelProcessor` the moment `env.modelHolder` is set.

---

## 1. The design decision (a) vs (b)

### (a) `catalog-info.yaml` with `kind: Bruno` → CatalogProcessor; enrichment in `preProcessEntity`, relations in `postProcessEntity`

Orchestrator order is preProcess → policy → validate → postProcess → store. Anything written in `preProcessEntity` is subsequently checked by `SchemaValidEntityPolicy`, `NoForeignRootFieldsEntityPolicy`, `FieldFormatEntityPolicy` and by our own `validateEntityKind`. A value written from `postProcessEntity` goes to `updateProcessedEntity` **unvalidated**. Both hooks are equally unable to change name/namespace/kind (F1).

Relations go in `postProcessEntity`, matching `BuiltinKindsEntityProcessor`, so we never emit relations for an entity that later fails validation.

- **Cadence:** ~100–150 s per entity (F4). Mitigated by the shared TTL cache in §3.D.
- **Caching:** instance-level TTL+LRU keyed by *normalised collection URL*. `CatalogProcessorCache` is rejected: it is scoped per-processor **and per-entity** (two Bruno entities on the same repo cannot share a fetch), and values set in a run are visible only in the directly following run. Precedent for an instance-level TTL cache: `BrunoLinkProcessor.ts:15,33`.
- **Failure behaviour — entity lands DEGRADED, never rejected.** Per F3: `try/catch` everything, `logger.error`, `return entity` unchanged. This is exactly the PRD's "share an error in the logs".

### (b) `bruno.collections[]` → EntityProvider stamping a `url:` location annotation

Processors are entity-triggered; a config array has nothing to trigger on. Provider-emitted entities are written as *unprocessed* and then flow through the identical processing loop, so the **same** `BrunoKindProcessor` enriches and relates them. The paths converge immediately after emission; only **identity** and **refresh** differ.

The provider stamps `backstage.io/managed-by-location: url:<normalized url>` (and origin) instead of `bruno-provider:…`, satisfying the `AboutCard` gate so native Refresh appears. Safe because (i) `readLocation` is gated on `kind: Location` so the URL is never dereferenced; (ii) orphan detection uses `refresh_state_references`; (iii) `parseLocationRef('url:https://…')` is well-formed. `locationKey` stays `bruno-collection-provider` so provider ownership and conflict detection keep working.

Refresh marks the entity for immediate reprocessing, re-running the processor and (subject to TTL) re-fetching. Provider owns *identity*; processor owns *enrichment*. Phase 2's Sync needs **no** custom route for config-sourced entities — it hooks the same processor path plus `ManifestProbe.evict(url)`.

**Symmetry rule (consequence of F1):** `metadata.name` is *identity* — authored in (a), URL-derived in (b). `metadata.title` is the *manifest name*. `description`/`version` are enriched identically in both.

---

## 2. Fate of every WIP file

| File | Fate |
|---|---|
| `processor/BrunoKindProcessor.ts` | **KEPT, rewritten in place.** Keep: location, class name, `entityKindSchemaValidator` pattern, `validateEntityKind` body, owner relation block, `allOf:[{$ref:'Entity'},…]` shape, the "spec is not `additionalProperties:false`" decision. Change: `BRUNO_API_VERSION`, schema `apiVersion` enum, drop `spec.system` and `spec.lifecycle`, add `spec.partOf`, make `spec.url` required, replace the system relation block with `partOf`, add `preProcessEntity`, add a constructor `{logger, probe}`, rewrite the stale "does not fetch spec.url" doc comment. |
| `processor/BrunoKindProcessor.test.ts` | **DELETED.** No tests for feature work. |
| `types.ts` (`BrunoEntity`) | **KEPT, rewritten.** apiVersion literal, `partOf?: string[]`, `url: string` required, drop `system` and `lifecycle`. |
| `module.ts` | **KEPT, extended.** Processor gains deps; new provider registered. |
| `index.ts` | **KEPT, extended.** |
| `app-config.yaml` `catalog.rules` | **KEPT as-is.** Already correct. |
| `app-config.yaml` `bruno: sources: []` | **KEPT as-is**, `collections:` added beneath. |
| `app-config.yaml` bruno-entity.yaml location | **KEPT as-is.** |
| `examples/bruno-entity.yaml` | **KEPT, rewritten.** |

Everything under the old annotation model (`BrunoEntityProvider`, `BrunoLinkProcessor`, `collectionService`, `router`, `plugin.ts`, the `bruno` frontend plugin) is **untouched except the four `.yaml` sites in §3.A–C**. Nothing is deleted whose replacement lands later.

---

## 3. Ordered edit list

Order matters: A→B→C are the lowest layer and compile standalone; D depends on A/B; E–F on D; G–N on F.

### A. `plugins/bruno-backend/src/scm/treeFilter.ts` — the ONE shared predicate

**Home justification.** The predicate is needed by `scm/readTree.ts` (via `isCollectionFile`) *and* by `service/collectionService.ts`. The existing direction is `collectionService.ts` → `'../scm'` → `readTree.ts` → `treeFilter.ts`. Putting it in the service would close a cycle. It lives in `scm/treeFilter.ts` — the lowest layer.

Add above `isCollectionFile`:

```ts
/** Both accepted spellings of the OpenCollection manifest. `.yml` is what
 *  Bruno writes today; `.yaml` is what the PRD specifies. Precedence between
 *  them is resolved in `findOpenCollectionYml`, not here. */
export const OPEN_COLLECTION_MANIFEST_NAMES = [
  'opencollection.yml',
  'opencollection.yaml'
] as const;

/** True when a repo-relative path IS an OpenCollection manifest (either
 *  spelling), at the tree root or in any subdirectory. Also correct for a bare
 *  filename, which is why the local walker can use it too. */
export function isOpenCollectionManifest(relPath: string): boolean {
  return OPEN_COLLECTION_MANIFEST_NAMES.some(
    (n) => relPath === n || relPath.endsWith(`/${n}`)
  );
}

/** True when a repo-relative path IS a `bruno.json` manifest. */
export function isBrunoJsonManifest(relPath: string): boolean {
  return relPath === 'bruno.json' || relPath.endsWith('/bruno.json');
}
```

Edit `isCollectionFile` — **site 1 of 4**. Add exactly one clause; do **not** broaden the general `.yml` clause:

```ts
export function isCollectionFile(relPath: string): boolean {
  return (
    relPath.endsWith('.bru')
    || relPath.endsWith('bruno.json')
    || relPath.endsWith('.yml')
    || isOpenCollectionManifest(relPath)   // adds ONLY the `.yaml` spelling
    || /(^|\/)readme\.md$/i.test(relPath)
  );
}
```

**Why narrow.** A blanket `.yaml` would admit `catalog-info.yaml`, `.github/**/*.yaml` etc. into the tree. `commonRootPrefix` (`collectionService.ts:882-898`) computes the shortest common leading directory over **all** tree keys and is the fallback root when no manifest is found (`:742`, `:1247`). A stray root-level `.yaml` would shift that prefix and silently mis-root manifest-less collections on the existing `bruno.sources` path. The narrow clause admits exactly `opencollection.yaml` — and when that exists, a manifest *is* found and `commonRootPrefix` is not consulted.

Update the doc comment to name both spellings.

### B. `plugins/bruno-backend/src/scm/index.ts`

After the `readTreeViaUrlReader` re-export add:

```ts
export {
  isCollectionFile,
  isOpenCollectionManifest,
  isBrunoJsonManifest,
  OPEN_COLLECTION_MANIFEST_NAMES
} from './treeFilter';
```

### C. `plugins/bruno-backend/src/service/collectionService.ts` — remaining three `.yaml` sites

Extend the `'../scm'` import (`:46-51`) with `isOpenCollectionManifest, isBrunoJsonManifest`.

- **Site 2 — `walkLocal`, `:640-652`.** Deliberately separate from `isCollectionFile` (matches directory entries, not relative paths). Replace `entry.name === 'bruno.json'` with `isBrunoJsonManifest(entry.name)` and add `|| isOpenCollectionManifest(entry.name)` alongside the existing `.yml` test. Update the comment.
- **Site 3 — `findOpenCollectionYml`, `:798-808`.** Replace the `key === 'opencollection.yml' || key.endsWith('/opencollection.yml')` test at `:801` with `isOpenCollectionManifest(key)`. **Preserve the shortest-path tie-break verbatim.** When one directory holds both spellings the paths are equal length, so make it deterministic: `key.length < best.length || (key.length === best.length && key < best)` — picks `opencollection.yaml` alphabetically. Document inline.
- **Site 4 — `findAllCollectionRoots`, `:817-832`.** Replace the four-way string test at `:822-827` with `if (isBrunoJsonManifest(key) || isOpenCollectionManifest(key))`. The `roots` Set already dedupes; `detectFormat`'s "opencollection wins over bruno.json" precedence (`:731-733`, `:791-795`) is preserved for both spellings.
- **Cosmetic:** the user-facing string at `:327` and comments at `:731`, `:790-792`, `:813` say `opencollection.yml` — change to `opencollection.yml/.yaml`.

**Known Phase-1 limitation — record, do not fix.** Admitting `opencollection.yaml` makes such a collection *detectable* and *enrichable*, but the OpenCollection **body** parser still reads only `.yml` (`parseEnvironmentsYml:1299`, `buildTreeYml:1371`, `:1409` `folder.yml`, `:1315`/`:1504` `.replace(/\.yml$/,'')`). Phase 1 never parses bodies, so this is inert; revisit when OpenCollection generation lands. No crash risk — those loops `continue` past unrecognised extensions.

### D. NEW `plugins/bruno-backend/src/service/manifestProbe.ts`

The single fetch+detect+extract seam. Reuses the git seam verbatim: `createScmProviderRegistry` (`scm/index.ts:63`) → `providers.byUrl(url)` (`:78`) → `provider.assertConfigured(url)` → `provider.normalizeUrl(url)` → `readTreeViaUrlReader({reader,url,logger})` (`scm/readTree.ts:26`).

```ts
export interface CollectionManifest {
  format: 'bru' | 'yml';
  manifestPath: string;          // repo-relative
  rootPrefix: string;            // posixDirname(manifestPath)
  name?: string;
  version?: string;
  description?: string;
}

export interface ManifestProbe {
  /** Resolves to the manifest metadata, or `undefined` when the tree read
   *  fine but contained NO bruno.json / opencollection.{yml,yaml}.
   *  THROWS only on a read/auth/network failure. Callers must distinguish. */
  probe(url: string): Promise<CollectionManifest | undefined>;
  /** Drops the cache entry for `url`. Unused in Phase 1; the seam Phase 2's
   *  Sync uses to force a re-fetch. */
  evict(url: string): void;
  /** The provider-normalized form of `url`; the cache key and the value the
   *  provider stamps as its location annotation. */
  normalize(url: string): string;
}

export function createManifestProbe(options: {
  config: Config;
  reader: UrlReaderService;
  logger: LoggerService;
  ttlMs?: number;        // default 5 * 60_000
  failureTtlMs?: number; // default 60_000
  max?: number;          // default 200
}): ManifestProbe;
```

Requirements:

1. **No user token, ever.** `probe` calls `readTreeViaUrlReader` with **no** `userToken`. There is no user request behind a processor or a scheduled provider run, so the two-tier fallback at `collectionService.ts:684-718` is deliberately not reused. This removes the entire token-leak surface from the Phase 1 spine. Do not add a `userToken` parameter.
2. **Cache all three outcomes**, keyed by `provider.normalizeUrl(url)`: `{kind:'found',value}`, `{kind:'absent'}`, `{kind:'error',message}` with `fetchedAt`. TTL 5 min for found/absent, 60 s for error so a repaired repo recovers within one reprocess cycle (F4). LRU-capped at 200, using the `lruSet`/`lruTouch` shape from `collectionService.ts:290-306`.
3. **Detection** uses the §A predicates over the `Map<string,string>` from `readTreeViaUrlReader`, mirroring the shortest-path + alphabetical tie-break of §C site 3, preserving `opencollection` precedence over `bruno.json`.
4. **Extraction — parse the raw manifest; do NOT route through `@usebruno/filestore`.**
   - `bruno.json`: `JSON.parse` → `name` (string), `version` (`String(v)` when not null/undefined), `description` if present. Mirrors `collectionService.ts:746-760`.
   - `opencollection.{yml,yaml}`: `yaml.load` from `js-yaml` (direct dependency, `plugins/bruno-backend/package.json:38`; precedent `service/openCollectionExport.ts:34`) → `info.name`, `info.version`, `info.summary`. Verified against `@opencollection/types/dist/common/info.d.ts`: `Info { name?, summary?, version?, authors? }`. **There is no `info.description`; `summary` is the description field.**
   - **Explicitly reject `parseYmlCollection`** (the aliased `@usebruno/filestore` export used at `collectionService.ts:1253`). Verified in `node_modules/@usebruno/filestore/dist/cjs/index.js`: its yml branch defaults `brunoConfig.name` to the literal `"Untitled Collection"`, which `collectionService.ts:1260` accepts as a real name. Enrichment must not write that placeholder into `metadata.title`. `parseCollection` also never surfaces `info.summary`.
5. **Sanitisation** before returning: `trim()`; collapse `description` to its first non-empty line; clamp `description` to 1000 chars, `title`/`version` to 255; drop values empty after trimming so `??` fallbacks behave. Coerce `version` with `String(...)` — `EntityMeta` is `additionalProperties:true`, so an unquoted YAML number would otherwise persist as a number.
6. `assertConfigured` is called before the first read so a self-hosted host with no `integrations` entry produces the named diagnostic rather than a bare `FetchUrlReader` failure. That throw is caught and cached as `{kind:'error'}`.

**Resolution of the dual-`createCollectionService` trap** (`module.ts:39` and `plugin.ts:42` each build an independent instance with independent caches): the Phase 1 spine does **not** touch `createCollectionService`. `createManifestProbe` is constructed **once** in `module.ts` and shared by the processor and the new provider, so Phase 1 adds no third cache and no third parse path. The pre-existing duplication is a property of the old annotation-model code and is resolved in the phase that deletes it — deleting it now would break `yarn tsc` and the `/api/bruno/*` routes.

### E. `plugins/bruno-backend/src/types.ts`

Replace `BrunoEntity` and add the config type:

```ts
/**
 * An entity of `kind: Bruno` — a Bruno collection in source control.
 *
 * `metadata.name` is REQUIRED by the platform and cannot be enriched: the
 * catalog validates the entity envelope before any processor runs
 * (DefaultCatalogProcessingOrchestrator :44) and rejects any processor that
 * changes the entity ref (:166). The manifest's name lands in
 * `metadata.title`; `version` and `description` are enriched in place.
 */
export interface BrunoEntity extends Entity {
  apiVersion: 'usebruno.com/v1alpha1';
  kind: 'Bruno';
  spec: {
    /** The type of Bruno entity, e.g. `bruno-collection`. */
    type: string;
    /** Entity reference to the owner; defaults to a Group when unprefixed. */
    owner?: string;
    /** Git URL of the collection folder. Required — it is what gets fetched. */
    url: string;
    /** Entity references to API entities this collection is part of.
     *  Emits RELATION_PART_OF / RELATION_HAS_PART pairs. Default kind: API. */
    partOf?: string[];
  };
}

/** One entry of `bruno.collections[]` in app-config. */
export interface BrunoCollectionConfig {
  type: 'url';
  url: string;
  partOf: string[];
  /** Optional entity-name override; see config.d.ts for why it exists. */
  name?: string;
}
```

### F. `plugins/bruno-backend/src/processor/BrunoKindProcessor.ts` — rewrite

1. `BRUNO_API_VERSION` → `'usebruno.com/v1alpha1'`. Rewrite the doc comment: the reason is the PRD-mandated identifier, and per F2 no special handling is needed.
2. `brunoEntityV1alpha1Schema`:
   - `apiVersion: { enum: [BRUNO_API_VERSION] }`.
   - `spec.required: ['type', 'url']` (was `['type']`).
   - Delete `spec.properties.lifecycle` and `spec.properties.system`. `spec` stays without `additionalProperties:false`, so an authored `lifecycle` still validates — it is simply not part of the contract.
   - Add:
     ```
     partOf: {
       type: 'array',
       description: 'Entity references to API entities this collection is part of.',
       items: { type: 'string', minLength: 1 },
       examples: [['api:default/github-rest-api']]
     }
     ```
   - Update `examples` to the new apiVersion, drop `lifecycle`, add `partOf`.
   - Keep `type` as free `{type:'string',minLength:1}` — forward-compatible.
3. Constructor:
   ```ts
   constructor(private readonly options: {
     logger: LoggerService;
     probe: ManifestProbe;
   }) {}
   ```
   `import type { LoggerService } from '@backstage/backend-plugin-api';` and `import type { CollectionManifest, ManifestProbe } from '../service/manifestProbe';`.
4. `getProcessorName()` unchanged. 5. `validateEntityKind` unchanged (F6).
6. **NEW `preProcessEntity`** — enrichment:
   - **First statement, allocation-free** (runs for every entity in the catalog):
     `if (entity.kind !== 'Bruno' || entity.apiVersion !== BRUNO_API_VERSION) return entity;`
   - Read `url` off `(entity as BrunoEntity).spec?.url`. If falsy → `return entity` (the schema rejects it at `validateEntityKind`, the right place for a shape error).
   - ```ts
     let manifest: CollectionManifest | undefined;
     try {
       manifest = await this.options.probe.probe(url);
     } catch (e) {
       this.options.logger.error(
         `Bruno collection ${stringifyEntityRef(entity)}: could not read ${url}: ${(e as Error).message}`
       );
       return entity;               // degraded, NOT rejected (F3)
     }
     if (!manifest) {
       this.options.logger.error(
         `Bruno collection ${stringifyEntityRef(entity)}: no bruno.json or `
         + `opencollection.yml/.yaml found at ${url}; entity ingested without `
         + `collection metadata.`
       );
       return entity;               // PRD: "should share an error in the logs"
     }
     ```
     Do **not** `emit(processingResult.generalError(...))` and do **not** rethrow — F3 proves either deletes the entity on first ingestion.
   - **Precedence — metadata WINS over the fetched value** (inverse of `collectionService.ts:744-760`/`:1249-1265`). Treat empty/whitespace as absent:
     ```ts
     const keep = (v: unknown) =>
       typeof v === 'string' && v.trim() ? v : undefined;
     const meta = entity.metadata as Entity['metadata'] & { version?: unknown };
     const title       = keep(meta.title)       ?? manifest.name;
     const description = keep(meta.description) ?? manifest.description;
     const version     = keep(meta.version)     ?? manifest.version;
     ```
     `metadata.name` is deliberately absent from this list (F1) — add an inline comment citing the orchestrator lines, or a future reader will "fix" it and get `ConflictError`.
   - **Return the same object reference when nothing changed**, so `resultHash` stays stable and the engine takes the `markSuccessfulWithNoChanges` path. Otherwise return a fresh object; never mutate the input:
     ```ts
     if (title === meta.title && description === meta.description
         && version === meta.version) return entity;
     return { ...entity, metadata: { ...entity.metadata, ...(title && {title}),
              ...(description && {description}), ...(version && {version}) } };
     ```
   - Also stamp `backstage.io/source-location: url:<probe.normalize(url)>/` when absent (trailing slash per convention).
7. `postProcessEntity` — relations only:
   - Keep the kind guard, `getCompoundEntityRef`, and the owner block verbatim (`RELATION_OWNED_BY` self→owner, `RELATION_OWNER_OF` owner→self, `defaultKind:'Group'`, `defaultNamespace: self.namespace`).
   - **Replace** the `spec.system` block with:
     ```ts
     for (const ref of new Set(spec.partOf ?? [])) {
       let target;
       try {
         target = parseEntityRef(ref, {
           defaultKind: 'API',
           defaultNamespace: self.namespace
         });
       } catch (e) {
         // Non-fatal by design: a throw here becomes an InputError, ok:false,
         // and on first ingestion the entity never lands at all — see
         // DefaultCatalogProcessingEngine :164-194 and performStitching :57-62.
         this.options.logger.warn(
           `Bruno collection ${stringifyEntityRef(entity)}: ignoring `
           + `unparseable spec.partOf entry "${ref}": ${(e as Error).message}`
         );
         continue;
       }
       emit(processingResult.relation({ source: self, type: RELATION_PART_OF, target }));
       emit(processingResult.relation({ source: target, type: RELATION_HAS_PART, target: self }));
     }
     ```
     **Both directions are emitted explicitly** — the catalog does not derive the reverse edge. The `Set` dedupes repeated entries.
   - Imports: keep all existing; add `stringifyEntityRef`.
8. Rewrite the class doc comment — the "does not fetch `spec.url`" sentence and the `bruno.sources` cross-reference are now false.

### G. DELETE `plugins/bruno-backend/src/processor/BrunoKindProcessor.test.ts`

Uncommitted; asserts against the old apiVersion and `spec.system` relations. No tests for feature work.

### H. NEW `plugins/bruno-backend/src/provider/BrunoCollectionEntityProvider.ts`

Modelled on `BrunoEntityProvider.ts` (`connect` `:54-62`, `applyMutation({type:'full'})` `:79-85`) with the location annotation deliberately changed.

```ts
export class BrunoCollectionEntityProvider implements EntityProvider {
  constructor(options: {
    config: Config;
    logger: LoggerService;
    probe: ManifestProbe;
    taskRunner: SchedulerServiceTaskRunner;
  });
  getProviderName(): string { return 'bruno-collection-provider'; }
}
```

`run()`:

1. `readBrunoCollections(this.options.config)` (§I). Empty → emit an empty full mutation and return (keeps deletions correct when the last entry is removed).
2. Per entry, in order — `const url = probe.normalize(entry.url);` then `probe.probe(entry.url)`:
   - **throws** (read/auth/network) → `logger.error` and **still emit** the entity un-enriched with a URL-derived name. A transient blip must not delete a previously-published entity via `type:'full'`.
   - **returns `undefined`** (tree read fine, no manifest) → `logger.error("no bruno.json or opencollection.yml/.yaml at <url>; skipping")` and **do not emit**. Safe to treat as authoritative precisely because "unreachable" surfaces as a throw, not `undefined`.
   - returns a manifest → emit, enriched.
3. **Name derivation** (F1 makes this the provider's job): `entry.name ?? sanitizeName(lastPathSegment(url))`. Reuse `sanitizeName` (`collectionService.ts:191-198`), already exported and already imported by `BrunoEntityProvider.ts:14-17` — no new dependency direction. Track emitted names in a `Set`; on collision `logger.error` naming both URLs and the `name:` escape hatch, and skip the later entry.
4. **Entity shape:**
   ```yaml
   apiVersion: usebruno.com/v1alpha1
   kind: Bruno
   metadata:
     name: <derived>
     title: <manifest.name>            # omitted when absent
     description: <manifest.description>
     version: <manifest.version>
     tags: [bruno]
     annotations:
       backstage.io/managed-by-location:        url:<url>
       backstage.io/managed-by-origin-location: url:<url>
       backstage.io/source-location:            url:<url>/
   spec:
     type: bruno-collection
     url: <url>
     partOf: <entry.partOf>            # omitted when empty
   ```
5. **Mutation:** `applyMutation({ type:'full', entities: entities.map(entity => ({ entity, locationKey: 'bruno-collection-provider:' + this.getProviderName() })) })`. Log `emitted N Bruno entity(ies), skipped M` at info.
6. The provider does **not** construct an `ScmProviderRegistry` (unlike `BrunoEntityProvider.ts:43-47`) — normalisation goes through `probe.normalize`, keeping exactly one registry in the Phase 1 spine.

### I. NEW `plugins/bruno-backend/src/service/brunoConfig.ts`

```ts
export function readBrunoCollections(config: Config): BrunoCollectionConfig[]
```

**Home justification (contrast with §A).** Needed by the provider and service-layer concern, so it goes in `service/` and the provider imports it — same single direction as `BrunoEntityProvider.ts:14-17` → `readBrunoSources`. A **new** file rather than `collectionService.ts` so the Phase 1 spine acquires no dependency on the 1660-line module that later phases delete wholesale; `brunoConfig.ts` imports nothing from `collectionService.ts`, so no cycle.

Mirroring `readBrunoSources`:
```ts
const brunoConfig = config.getOptionalConfig('bruno');
if (!brunoConfig) return [];
const entries = brunoConfig.getOptionalConfigArray('collections') ?? [];
```
Per entry: `type` read as `c.getString('type')` and filtered `=== 'url'` (caller logs skips); `url` = `c.getString('url')`; `partOf` — PRD writes a single ref, locked decision is plural, so accept **both** via `c.getOptional('partOf')` and narrow by hand (a `string` becomes `[string]`, a `string[]` passes, anything else `[]`) — `getOptionalStringArray` throws on a bare string and cannot be used alone; `name` = `c.getOptionalString('name')`.

### J. `plugins/bruno-backend/src/module.ts`

- Import `createManifestProbe` and `BrunoCollectionEntityProvider`.
- Inside `init`, after the existing `createCollectionService` call, construct the probe **once**: `const probe = createManifestProbe({ config, reader, logger });`
- Replace `catalog.addProcessor(new BrunoKindProcessor())` with `catalog.addProcessor(new BrunoKindProcessor({ logger, probe }))`.
- Register the provider with its **own** task runner (distinct task id; `readSchedule(config)` reused as-is):
  ```ts
  catalog.addEntityProvider(
    new BrunoCollectionEntityProvider({
      config, logger, probe,
      taskRunner: scheduler.createScheduledTaskRunner(schedule)
    })
  );
  ```
- `moduleId` stays `'bruno-entity-provider'` — renaming orphans the old provider's `refresh_state_references` rows on existing dev databases for no benefit.
- Update the module doc comment to describe all three registrations. No `deps` change needed.

### K. `plugins/bruno-backend/src/index.ts`

- Keep the `BrunoKindProcessor` / `BRUNO_API_VERSION` / `brunoEntityV1alpha1Schema` export block (names stable; only values change).
- Add `export { BrunoCollectionEntityProvider } from './provider/BrunoCollectionEntityProvider';`, `export { createManifestProbe } from './service/manifestProbe';`, `export { readBrunoCollections } from './service/brunoConfig';`.
- Type block: keep `BrunoEntity`; add `BrunoCollectionConfig` and `export type { CollectionManifest, ManifestProbe } from './service/manifestProbe';`.
- Fix the stale comment at `:15`.

### L. `plugins/bruno-backend/config.d.ts`

Insert a `collections` block after `sources`, before `schedule`:

```ts
    /**
     * Bruno collections to materialize as `kind: Bruno` entities, without a
     * catalog-info.yaml. Ingested through the same path as an authored
     * entity: fetch the folder, require a bruno.json or
     * opencollection.yml/.yaml, then enrich name/version/description.
     * @visibility backend
     */
    collections?: Array<{
      /** The source type. Only `url` is supported. @visibility backend */
      type: 'url';
      /**
       * Git URL of the Bruno collection FOLDER (a tree or blob URL on a host
       * configured under `integrations`).
       * @visibility backend
       */
      url: string;
      /**
       * Entity reference(s) to the API entities this collection is part of.
       * A bare string is accepted and treated as a single-element list.
       * @visibility backend
       */
      partOf?: string | string[];
      /**
       * Optional entity-name override. The default name is derived from the
       * last path segment of `url`; set this when two configured collections
       * would otherwise collide, or to pin a name against a URL change.
       * NOT part of the PRD's config shape — a documented superset.
       * @visibility backend
       */
      name?: string;
    }>;
```

`@visibility backend` on every field — none of this reaches the browser.

### M. `app-config.yaml`

Under the existing `bruno:` key, between `sources: []` and `schedule:`:

```yaml
  # PRD §"Creating Bruno entities, other than catalog-info.yaml".
  # Each entry becomes a `kind: Bruno` entity emitted by
  # BrunoCollectionEntityProvider. `metadata.name` is derived from the last
  # path segment of `url`; title/version/description come from the
  # collection's bruno.json or opencollection.yml/.yaml.
  collections: []
    # - type: url
    #   url: https://github.com/bruno-collections/github-rest-api-collection
    #   partOf:
    #     - api:default/github-rest-api
```

`catalog.rules` and the `bruno-entity.yaml` location entry are already correct — **do not touch them**. Keep the existing NOTE comment above `bruno:`; it applies to `collections` identically.

### N. `examples/bruno-entity.yaml`

```yaml
# A declarative `kind: Bruno` entity.
#
# The kind is defined by BrunoKindProcessor in the bruno-backend plugin —
# `catalog.rules` in app-config only *permits* the kind from a location, it
# does not define one.
#
# `metadata.name` is REQUIRED and cannot be enriched: the catalog validates the
# entity envelope before any processor runs. `title`, `description` and
# `version` are optional and are filled in from the collection's bruno.json /
# opencollection.yml|.yaml when omitted here; a value written here WINS over
# the fetched one.
apiVersion: usebruno.com/v1alpha1
kind: Bruno
metadata:
  name: my-bruno-collection
spec:
  type: bruno-collection
  owner: guests
  url: https://github.com/bruno-collections/github-rest-api-collection
  partOf:
    - api:default/github-rest-api
```

Drop `lifecycle`. Point `spec.url` at the **folder**, not a blob URL to `bruno.json` (PRD: "Git url to the collection folder in a repo"). `api:default/github-rest-api` exists in `examples/bruno-collections.yaml`, so the relation resolves in a local boot.

---

## 4. Consumers and call sites

| Call site | Change |
|---|---|
| `module.ts` `new BrunoKindProcessor()` | → `new BrunoKindProcessor({ logger, probe })` — the **only** construction site. |
| `processor/BrunoKindProcessor.test.ts` | Deleted (§G); the only other construction site. |
| `index.ts` | Extended (§K). |
| `service/collectionService.ts:46-51` | Import list extended with the two predicates (§C). |
| `scm/readTree.ts:45` | **No change** — calls `isCollectionFile`, whose behaviour widens transparently. |
| `packages/backend/src/index.ts` | **No change.** `brunoCatalogModule` already registered. |
| `packages/app/**`, `plugins/bruno/**` | **No change** in Phase 1. |

No other reference to `BrunoKindProcessor`, `BRUNO_API_VERSION`, `brunoEntityV1alpha1Schema` or `BrunoEntity` exists in the repo.

**Routes:** Phase 1 adds and changes **zero** HTTP routes. No `httpRouter.addAuthPolicy` change; the existing `/health` (unauthenticated) and `/collections/:id/docs` (`user-cookie`) policies are untouched. The route-ordering rule is not exercised. Note for later phases: `router.ts:169` already registers the literal `/collections/:id/opencollection.yml` — a `.yaml` sibling must sit beside it, not after a `:param` route.

**Cross-plugin boundary:** no new cross-plugin calls. The probe reads git through the injected `UrlReaderService`; it never touches the `bruno` plugin's DB or the catalog's.

---

## 5. Alternatives considered and rejected

1. **Declarative catalog model layers (`provideStaticCatalogModel`).** Setting any model source sets `env.modelHolder`, and `CatalogBuilder.cjs.js:459-467` then skips `BuiltinKindsEntityProcessor` entirely in favour of `ModelProcessor` — an all-or-nothing flip of the whole kind pipeline onto an alpha API, to define one kind.
2. **`postProcessEntity` for enrichment.** Output bypasses `SchemaValidEntityPolicy` / `FieldFormatEntityPolicy` / `validateEntityKind`, all of which run earlier.
3. **`CatalogProcessorCache` for the fetch cache.** Per-entity scoping prevents sharing a fetch between two entities on the same repo; its "visible only in the directly following run" contract is a poor fit for a wall-clock TTL.
4. **Emitting `processingResult.generalError` for a missing manifest.** F3 — proven to prevent the entity from ever appearing.
5. **A processor instead of a provider for `bruno.collections[]`.** Processors are entity-triggered; there is no seed entity for a config array.
6. **A provider emitting `kind: Location` entities.** `readLocation` would try to parse a catalog descriptor at that URL and fail; the folder holds a Bruno manifest, not a catalog-info.yaml.
7. **Keeping `bruno-provider:` as the location annotation.** Fails the `AboutCard` gate, leaving the config path with no refresh affordance and forcing Phase 2 to build a bespoke route.
8. **Broadening `isCollectionFile`'s `.yml` clause to `.yaml`.** Perturbs `commonRootPrefix` for manifest-less collections on the existing `bruno.sources` path.
9. **Routing manifest metadata through `@usebruno/filestore`'s `parseCollection`.** Injects the literal `"Untitled Collection"` and never exposes `info.summary`.
10. **Threading the caller's OAuth token into the probe.** No user request exists behind a processor or scheduled run — and not having the parameter is the strongest guarantee it is never logged.
11. **Making an unparseable `spec.partOf` entry fatal.** F3 — one typo would make the whole entity vanish. Warned instead. Revisitable (Q3).

---

## 6. Cannot deliver

**PRD §"Ingesting Bruno Collection", bullet 5: "Infer information from comments in the yaml".**

Not implementable at any point in the pipeline. The catalog parses an entity descriptor into plain JavaScript objects **before** any processor is invoked: `processSingleEntity` receives `request.entity` already deserialised (`dist/processing/DefaultCatalogProcessingOrchestrator.cjs.js:33-44`), and the default `CatalogProcessorParser` performs YAML document parsing producing `CatalogProcessorResult` values. YAML comments have no representation in the resulting object graph and are discarded at parse time. By the time any hook we can install runs, the comment text no longer exists in the process.

The only theoretical workaround — re-reading the raw descriptor bytes from `location.target` and re-parsing with a comment-preserving YAML reader — is rejected: it duplicates the platform's read including credential handling, is impossible for `bruno.collections[]` entities (no descriptor file exists), and creates a second divergent source of truth.

**No Phase 1 design assumes this requirement.** Surfaced so it is not silently dropped and a decision can be taken (e.g. move the information into real spec fields) before Phase 2.

**Secondary (F1): `metadata.name` cannot be optional for an authored `catalog-info.yaml`.** The PRD marks it optional; the platform requires it and forbids a processor from supplying it. Phase 1 delivers the *intent* — the manifest name is used automatically — by routing it to `metadata.title` for authored entities, and deriving `metadata.name` from the URL for config-created entities, where we construct the entity ourselves and the constraint does not bite.

---

## 7. Risks and open questions

**Risks**

- **R1 — fetch amplification.** F4's cadence means N Bruno entities generate ~N/2 `readTree` calls per minute before caching. The 5-minute TTL cuts this ~3×, but a large catalog makes SCM rate limits a real concern. Mitigation: raise `catalog.processingInterval` (one line).
- **R2 — refresh staleness window.** Native Refresh re-runs the processor, but a cache hit within 5 minutes returns the previous manifest, so the button occasionally looks like a no-op. `ManifestProbe.evict` exists for Phase 2's Sync; Phase 1 does not call it.
- **R3 — "Unregister entity" on a config-sourced entity.** The UI resolves `managed-by-location` to a `Location` entity; for our `url:` annotation none exists, so the flow degrades to a plain delete and the provider re-adds on its next tick. Acceptable for Phase 1.
- **R4 — entity rename on URL change.** `metadata.name` derives from the URL's last segment; moving a collection renames the entity, breaking `partOf` refs that pointed at the old name. The `name:` override is the mitigation.
- **R5 — `opencollection.yaml` bodies still unparsed.** Inert in Phase 1; blocking for OpenCollection generation.
- **R6 — `spec.partOf` targets need not exist.** Backstage records relations to nonexistent entities; the UI shows a dangling link. Matches stock `spec.system` behaviour.
- **R7 — relations are derived and immutable.** No relation-mutation endpoint exists. The PRD's "Unlink" cannot be a relation delete — it must edit `spec.partOf` at the source. Constrains Phase 3's UI.

**Open questions for the requester**

- **Q1** — should `bruno.collections[]` carry an `owner`? The PRD's block has only `type`/`url`/`partOf`, so config-created entities emit no `ownedBy` relation and show "unknown owner". Two-line change if wanted.
- **Q2** — is the `name?:` config override (a documented PRD superset) acceptable, or should a name collision be a hard boot failure?
- **Q3** — should an unparseable `spec.partOf` entry be fatal rather than warned?
- **Q4** — `bruno.json` carries no description field in the Bruno spec, so `metadata.description` usually stays empty unless authored. Should Phase 1 also mine `<root>/collection.bru`'s `docs` block? (`collection.bru` is currently skipped at `collectionService.ts:987-988`.) Excluded from Phase 1 to keep extraction to two well-defined manifests.
- **Q5** — should `spec.type` be constrained to `enum:['bruno-collection']`, or left a free string as planned?

---

## 8. Verification

**Gate commands**, from the repo root; all must pass:

```
yarn tsc
yarn lint:bruno plugins/bruno-backend/src/processor/BrunoKindProcessor.ts \
                plugins/bruno-backend/src/provider/BrunoCollectionEntityProvider.ts \
                plugins/bruno-backend/src/service/manifestProbe.ts \
                plugins/bruno-backend/src/service/brunoConfig.ts \
                plugins/bruno-backend/src/service/collectionService.ts \
                plugins/bruno-backend/src/scm/treeFilter.ts \
                plugins/bruno-backend/src/scm/index.ts \
                plugins/bruno-backend/src/module.ts \
                plugins/bruno-backend/src/index.ts \
                plugins/bruno-backend/src/types.ts
yarn prettier:check
```

`yarn tsc` must report **0 errors** — the binding per-commit gate. No tests are added; `yarn test` is not a gate.

**Live boot check** — `yarn start`, then confirm all of:

1. **Backend starts clean.** No `No processor recognized the entity …` for `bruno:default/my-bruno-collection`, and no unhandled rejection from the provider's first tick.
2. **Probe fires once per URL.** Exactly one `Reading Bruno collection tree via UrlReader: <url>` (`scm/readTree.ts:33`) per distinct URL in the first minute — not one per entity, not one every 100–150 s. Proves the shared TTL cache works.
3. **Authored entity lands enriched.** `GET localhost:7007/api/catalog/entities/by-name/bruno/default/my-bruno-collection` returns `metadata.title`, `description` and `version` from the fetched manifest even though the example sets none, and `metadata.name` is exactly `my-bruno-collection`.
4. **Relations are bidirectional.** The response carries `{type:'partOf', targetRef:'api:default/github-rest-api'}` and `{type:'ownedBy', targetRef:'group:default/guests'}`; and `…/by-name/api/default/github-rest-api` carries the reciprocal `{type:'hasPart', targetRef:'bruno:default/my-bruno-collection'}`.
5. **Override direction is correct.** Temporarily add `description: authored wins` to the example; after the next reprocess the API returns `authored wins`, not the manifest text. Revert.
6. **Missing manifest is non-fatal and logged.** Point `spec.url` at a folder with no manifest. Exactly one `no bruno.json or opencollection.yml/.yaml found at …` at **error** level, and the entity is **still present**. Crucially `…/by-name/bruno/default/my-bruno-collection` must return **200, not 404** — a 404 means an error result leaked into the collector and F3 has bitten. Revert.
7. **Config path works.** Uncomment the `bruno.collections[]` example. Within one tick a second `kind: Bruno` entity appears with `metadata.name` from the URL's last segment, `title` from the manifest, and `managed-by-location` beginning `url:`.
8. **Native refresh appears and works.** That entity's About card shows the Refresh button (proving the `AboutCard` gate passes); clicking it produces a fresh processing pass in the log and does not error.
9. **`.yaml` spelling is honoured end-to-end.** Point a `bruno.collections[]` entry at a folder whose manifest is `opencollection.yaml`. It must be detected and enriched — exercises all four sites at once, and is the only check that catches a missed `treeFilter.ts` edit (site 1 silently filters the file out and detection then reports "not found").
10. **No regression on the old path.** `GET localhost:7007/api/bruno/health` returns 200 and the existing `kind: API` entities are unchanged.
11. **No token in any log line.** Grep the boot log for `$GITHUB_TOKEN`; zero hits.
