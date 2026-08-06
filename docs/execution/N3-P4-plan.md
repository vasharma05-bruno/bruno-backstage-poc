# N3-P4 — Collection YML export (OpenCollection) — Execution Plan (LOCKED)

> Produce a single **OpenCollection `1.0.0` YAML** string for a linked/cached collection, to (a) feed the P5 docs iframe and (b) offer as a download. Backend-only (`plugins/bruno-backend/src`) plus one frontend client method (`plugins/bruno/src/api`). **Locked decision D-C = converter + adapter:** the plugin holds a `NormalizedCollection`; `@usebruno/converters@0.22.0` exports `brunoToOpenCollection(collection: BrunoCollection): OpenCollection` whose input is Bruno's in-memory `BrunoCollection` (NOT `NormalizedCollection`, NOT raw files). So we write a **`NormalizedCollection → BrunoCollection` adapter**, call `brunoToOpenCollection`, then YAML-dump. **Locked decision D-D = REDACT secrets** before export. New logic isolated in a new module `service/openCollectionExport.ts`; the collectionService stays lean. No schema change, no tests. Gated by repo-level `yarn tsc` (0 errors) + `yarn lint:bruno plugins/bruno-backend/src plugins/bruno/src/api` (NEW code lint-clean — judged against the pre-existing backend style baseline, see Gates).
>
> **Verified against the installed tree (not assumed):**
> - `brunoToOpenCollection` IS a real runtime export of `@usebruno/converters@0.22.0`: `node -e "require('@usebruno/converters').brunoToOpenCollection"` → `function`. `main: dist/cjs/index.js`; there is **NO top-level `types`/`.d.ts`** and **no `exports` map** — so `import { brunoToOpenCollection } from '@usebruno/converters'` compiles as **implicitly `any`** and TypeScript does **NOT** chase the package's internal `.d.ts`.
> - `@usebruno/schema-types` (the declared input type of `brunoToOpenCollection` inside the converter's own `.d.ts`) is a **devDependency of converters only** and is **UNRESOLVABLE** from the plugin (`require.resolve` → `MODULE_NOT_FOUND`). Therefore we must **NOT** `import type { BrunoCollection } from '@usebruno/converters'` (that would chase `@usebruno/schema-types/...` and fail tsc). The converter's `.d.ts` files themselves are harmless because the repo tsconfig extends `@backstage/cli/config/tsconfig.json` with **`skipLibCheck: true`** (`moduleResolution: bundler`, `strict: true`).
> - The exact fields `brunoToOpenCollection` READS off its input (from the canonical source `~/Projects/bruno/packages/bruno-converters/src/opencollection/bruno-to-opencollection.ts`, which is the un-minified twin of the installed 0.22 dist): `collection.name`, `collection.brunoConfig`, `collection.environments`, `collection.items`, `collection.root`. Nothing else. It **defaults `name` to `'Untitled Collection'`** and treats every other top-level field as optional.
> - `js-yaml@4.3.0` **is installed and resolvable** from the plugin (hoisted transitive of converters), and `@types/js-yaml` **is present** in the root `node_modules`. `yaml@2.9.0` (filestore's dep) is also present. Both are transitive, not declared plugin deps.
> - `@opencollection/types@0.12.0` is **already a declared plugin dep** and installed; `OpenCollection` there is `{ info?, opencollection?, config?, items?, request?, docs?, bundled?, extensions? }` and `Extensions = Record<string, unknown>` — so `extensions.bruno.exportedAt` is freely settable.
> - Route policy: `GET /collections/:id` (`router.ts:53-60`) and `GET /collections/:id/docs` (`router.ts:62-75`) are **OPEN** (no `httpAuth.credentials`). The new `.yml` route matches them (open).

## Investigated shapes (quoted, file:line-accurate)

### A. What `brunoToOpenCollection` reads — the true `BrunoCollection` surface we must populate
From `~/Projects/bruno/packages/bruno-converters/src/opencollection/bruno-to-opencollection.ts:95-201` and its helpers. The input is a loose object; the converter only reads:

| Field read | Where (canonical source) | What the adapter must provide |
|---|---|---|
| `collection.name` | `bruno-to-opencollection.ts:104` (`\|\| 'Untitled Collection'`) | `NormalizedCollection.name` |
| `collection.brunoConfig` | `:96` → `toOpenCollectionConfig`, `:98` version, `:172-193` ignore/presets/scripts.flow | **absent in NormalizedCollection** — default `{ version: detail.collection.version }` only (see Gaps) |
| `collection.environments` | `:114` → `toOpenCollectionEnvironments` (`environment.ts:71-101`): reads `env.name`, `env.color`, `env.variables[].{name, secret, value, enabled}` | map from `NormalizedCollection.environments[].{name, variables[].{name,value,enabled}}`; **set `secret:true` on redacted vars** (see D-D) |
| `collection.items` | `:122` → `toOpenCollectionItems` (`items/index.ts:116-120`, dispatch `items/index.ts:85-108`) | map the item tree; **type strings must be `'http-request'`/`'graphql-request'`/`'folder'`** (NOT `'http'`/`'graphql'`) |
| `collection.root` | `:127` `hasRequestDefaults`, `:128-155` request defaults, `:157-162` `root.docs` | `{ docs: NormalizedCollection.readme }` (collection README → collection-level `docs`) |

**Per-request read shape** (`items/http.ts:150-302`, `toOpenCollectionHttpItem`): reads `item.type` (switch at `items/index.ts:86`), `item.name`, `item.seq`, `item.tags`, and `item.request.{method, url, headers, params, body, auth, vars, script, tests, assertions, docs}`, plus `item.settings`, `item.examples`. Headers/params are `BrunoKeyValue[]` (`{name,value,enabled?,...}`). **Auth is NESTED** (`toOpenCollectionAuth`, `common/auth.ts:430-523`): `item.request.auth = { mode, basic:{username,password}, bearer:{token}, digest:{username,password}, apikey:{key,value,placement}, ... , <others>:null }`. Body is Bruno's nested body block read by `toOpenCollectionBody`.

**Per-folder read shape** (`folder.ts:79-145`, `toOpenCollectionFolder`): reads `folder.name`, `folder.seq`, `folder.tags`, `folder.root.{request, docs}`, `folder.items` (recurses). Only `name` + `items` are needed for a minimal faithful render; `folder.root.docs` carries folder-level markdown.

### B. The plugin's `NormalizedCollection` (`plugins/bruno-backend/src/types.ts`)
```
NormalizedCollection (types.ts:106-115):
  id: string
  name: string
  version?: string
  environments: Environment[]         // Environment (types.ts:100-103) = { name, variables: KeyValue[] }
  items: Item[]                       // Item (types.ts:97) = FolderItem | RequestItem
  readme?: string                     // collection-root README markdown

KeyValue (types.ts:18-22)   = { name, value, enabled }          // NO `secret`, NO `color`
Param    (types.ts:25-30)   = { name, value, type:'query'|'path', enabled }
RequestBody (types.ts:33-46)= { mode:'none'|'json'|'text'|'xml'|'formUrlEncoded'|'multipartForm'|'graphql', raw?, form?: KeyValue[] }
RequestAuth (types.ts:49-52)= { mode:'none'|'inherit'|'basic'|'bearer'|'apikey'|'digest', [k]: unknown }   // FLAT — fields spread at top level
RequestScript (types.ts:55-58) = { req?, res? }
Assertion (types.ts:61-69) = { expr, op, value, enabled }
FolderItem (types.ts:72-77)  = { type:'folder', name, docs?, items: Item[] }
RequestItem (types.ts:80-94) = { type:'http'|'graphql', name, seq?, docs?, method, url, headers:KeyValue[], params:Param[], body?, auth?, script?, tests?, assertions? }
CollectionDetail (types.ts:135-137) = CollectionSummary & { collection: NormalizedCollection }
```
How auth is produced (`collectionService.ts:1216-1238`, `mapAuth`): FLAT — `{ mode:'basic', username, password }`, `{ mode:'bearer', token }`, `{ mode:'apikey', key, value, ... }`, `{ mode:'digest', username, password }`; unsupported modes collapse to `{ mode:'none', unsupportedMode }` (no secret fields). Body is produced FLAT (`mapBody`, `:1164-1203`): `{ mode, raw? }` or `{ mode, form? }`.

### C. Concrete adapter mapping `NormalizedCollection → BrunoCollection`

| Bruno target (read by converter) | Source in NormalizedCollection | Adapter action |
|---|---|---|
| `name` | `collection.name` | pass through |
| `brunoConfig.version` | `collection.version` | `version ? { version } : undefined` (only field we populate) |
| `root.docs` | `collection.readme` | `readme ? { docs: readme } : undefined` |
| `environments[].name` | `environment.name` | pass through |
| `environments[].variables[].{name,enabled}` | `KeyValue.{name,enabled}` | pass through (`enabled` → converter reads `disabled = enabled===false`) |
| `environments[].variables[].value` | `KeyValue.value` | **REDACT** (D-D): set `secret:true`, drop value — converter omits value for secret vars (`environment.ts:83-86`) |
| item `type` | `'http'` / `'graphql'` / folder | **map**: `'http'`→`'http-request'`, `'graphql'`→`'graphql-request'`, folder→`'folder'` (converter switches on these exact strings, `items/index.ts:86-96`) |
| request `name`, `seq` | `RequestItem.{name,seq}` | pass through |
| `request.request.{method,url}` | `RequestItem.{method,url}` | pass through |
| `request.request.headers` | `RequestItem.headers` (`KeyValue[]`) | pass through (`{name,value,enabled}`) |
| `request.request.params` | `RequestItem.params` (`Param[]`) | pass through (`{name,value,type,enabled}`) |
| `request.request.body` | `RequestItem.body` (FLAT `{mode,raw?/form?}`) | **rebuild** to Bruno's nested body block (see Body sub-map) |
| `request.request.auth` | `RequestItem.auth` (FLAT `{mode,...}`) | **rebuild** to Bruno's nested auth block (see Auth sub-map) + **REDACT** secret fields |
| `request.request.script` | `RequestItem.script` (`{req?,res?}`) | pass through as `{ req: req??null, res: res??null }` |
| `request.request.tests` | `RequestItem.tests` | pass through |
| `request.request.assertions` | `RequestItem.assertions` (`Assertion[]`) | pass through (converter reads them via `toOpenCollectionAssertions`; shape `{expr,op,value,enabled}` maps to Bruno `{name/lhs,op,value,enabled}` — see Risk R-C) |
| `request.request.docs` | `RequestItem.docs` | pass through |
| folder `name`, `items`, `root.docs` | `FolderItem.{name, items, docs}` | recurse; `docs ? { root: { docs } } : {}` |

**Body sub-map** (FLAT `RequestBody` → Bruno nested block read by `toOpenCollectionBody`):
- `mode:'none'` → `{ mode:'none' }`
- `mode:'json'|'text'|'xml'` → `{ mode, [mode]: raw ?? '' }`
- `mode:'graphql'` → `{ mode:'graphql', graphql: { query: raw ?? '' } }`
- `mode:'formUrlEncoded'` → `{ mode:'formUrlEncoded', formUrlEncoded: form ?? [] }`
- `mode:'multipartForm'` → `{ mode:'multipartForm', multipartForm: (form ?? []).map(f => ({ ...f, type:'text' })) }`

**Auth sub-map** (FLAT `RequestAuth` → Bruno nested block read by `toOpenCollectionAuth`, `common/auth.ts:430`):
- `mode:'none'`/absent → omit `auth` (converter returns `undefined`, `:431`)
- `mode:'inherit'` → `{ mode:'inherit' }`
- `mode:'basic'` → `{ mode:'basic', basic:{ username: <REDACT>, password: <REDACT> } }`
- `mode:'bearer'` → `{ mode:'bearer', bearer:{ token: <REDACT> } }`
- `mode:'digest'` → `{ mode:'digest', digest:{ username: <REDACT>, password: <REDACT> } }`
- `mode:'apikey'` → `{ mode:'apikey', apikey:{ key: auth.key, value: <REDACT>, placement: auth.placement } }` (key name kept; value redacted)

### D. Gaps (BrunoCollection needs / NormalizedCollection lacks) — and honest size assessment
- **No `brunoConfig`** in NormalizedCollection → we synthesize a minimal `{ version }` only. Consequence: exported `config` (proxy/certs/protobuf), `extensions.bruno.{ignore,presets,scripts.flow}` are **absent** from output. Acceptable for a docs/download POC.
- **No collection-root / folder-root request defaults** (headers/auth/vars/scripts at collection or folder level) in NormalizedCollection. `hasRequestDefaults(collection.root)` (`:82-93`) will be false → no `openCollection.request`. Folder `root.request` likewise absent. Only folder `root.docs` and collection `root.docs` are producible. Acceptable.
- **No `settings`, `examples`, `tags` per request** → converter defaults them (settings get default true/5, examples/tags omitted). Fine.
- **Auth modes beyond basic/bearer/apikey/digest** never survive parse (`mapAuth` collapses them to `{mode:'none'}`), so oauth2/awsv4/ntlm/wsse/oauth1 are already gone before export — nothing to map.
- **Assertion shape mismatch** (see R-C): NormalizedCollection uses `{expr,op,value}`; Bruno's `toOpenCollectionAssertions` expects `KeyValue`-ish `{name,value,enabled}`. Low-fidelity; treat assertions as best-effort (map `expr`→`name`, join `op+value`→`value`) or **omit** them (recommended for POC — see R-C).
- **NormalizedCollection fields with no Bruno target:** `collection.id` (internal), `Param.type` beyond query/path — n/a.

**Size verdict: the adapter is MEDIUM, not small.** It is a ~150–220-line pure-function module: a recursive item mapper + body sub-map + auth sub-map + env map + a thin top-level assembler. It is mechanical (no I/O, no async) but not trivial, because Bruno's nested auth/body shapes differ structurally from our flat model. This is the cost the user knowingly accepted by choosing converter+adapter over a direct OpenCollection serializer. It is **not blocked** — every field the converter reads is derivable from `CollectionDetail`. No STOP condition.

## Locked decisions
- **D-C (given) — converter + adapter.** New module `service/openCollectionExport.ts` owns the adapter + serializer. Import the converter as **untyped** via a local ambient module declaration (mirroring `src/types/usebruno-lang.d.ts`), so no `@usebruno/schema-types` resolution is attempted. Adapter returns a plain object typed locally as `BrunoCollectionLike` (our own minimal interface), passed to `brunoToOpenCollection`.
- **D-D (given) — REDACT secrets, single choke point = the ADAPTER.** Redact **while building the BrunoCollection** (not post-hoc on the OpenCollection, not by mutating the cached NormalizedCollection). Rationale: (1) the cache must never be mutated (it is shared, read by other routes); (2) redacting in the adapter means the OpenCollection is born clean — no second pass, no risk of a field slipping through. Redaction target = a `REDACTED = '<redacted>'` constant. **Exact fields redacted:** request auth secret values — `basic.password`, `basic.username`? → **redact `password` only, keep `username`** (username is not a secret and aids docs); `bearer.token`; `digest.password` (keep username); `apikey.value` (keep key name); AND every **environment variable value** (env vars routinely hold tokens/base-urls-with-creds; blanket-redact via `secret:true`). Non-secret structure (urls, header/param names+values, method, body, scripts, docs) is preserved. NOTE: header/param/body VALUES are NOT redacted (a `Authorization` header value could carry a token, but our parse already surfaces those as plain KeyValues in the native viewer + docs HTML today; widening redaction to header values is out of scope for this POC — flagged in Risks R-D).
- **D-YAML — reuse the already-installed `js-yaml`; add it as an explicit dependency.** `js-yaml@4.3.0` + `@types/js-yaml` are already resolvable/installed (transitive). We call `yaml.dump(oc, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false })` — **byte-identical options to Bruno's exporter** (NEXT-STEPS-3 §3.3). Add `"js-yaml": "^4.1.0"` to `dependencies` and `"@types/js-yaml": "^4.0.9"` to `devDependencies` of `plugins/bruno-backend/package.json` so the direct import is not an undeclared-transitive (satisfies `import/no-extraneous-dependencies`; the converter itself depends on `js-yaml@^4.1.1`, so no version conflict). We do **NOT** use the `yaml` package (different API, different output style — would drift from Bruno's canonical output). This is the one added-dep, justified: it is already in the tree at the exact major, and avoids re-implementing a YAML dumper.
- **D-STAMP — real timestamp.** After conversion, set `oc.extensions = { ...(oc.extensions ?? {}), bruno: { ...(oc.extensions?.bruno ?? {}), exportedAt: new Date().toISOString(), exportedUsing: 'bruno-for-backstage' } }`. This is normal backend request-handling code (not a deterministic workflow script), so a live `Date` is correct.
- **D-ROUTE — new open GET, placed adjacent to `/collections/:id/docs`.** `GET /collections/:id/opencollection.yml`, **no `httpAuth.credentials`** (matches the sibling `/collections/:id` and `/docs` read routes — POC read routes are open, `router.ts:53,62`). 404 (JSON `{error}`) when `getCollection(id)` is undefined, mirroring `/collections/:id` (`router.ts:55-57`). Response: `res.type('text/yaml').send(yamlString)` (raw text, not JSON). Route ORDERING: place it **immediately after** the `/collections/:id/docs` handler (i.e. after `router.ts:75`, before `/dashboard`). Express matches most-specific path segments first for distinct literals; `:id/opencollection.yml` is a two-segment path (`:id` + literal `opencollection.yml`) and cannot be shadowed by the one-segment `/collections/:id`, exactly as `/docs` isn't. No `:id` route shadows it.
- **D-DERIVE — derive on demand, no byte cache.** `toOpenCollectionYaml(detail)` is a pure transform over the already-cached `CollectionDetail`; no new cache (per NEXT-STEPS-3 §8.4). The frontend/P5 may add `useAsync` memoization later — out of scope here.

## Backend edits

### `plugins/bruno-backend/src/types/usebruno-converters.d.ts` (NEW — ambient module decl)
Mirror `types/usebruno-lang.d.ts`. Declare the converter as untyped so no `@usebruno/schema-types` resolution occurs:
```ts
/**
 * Ambient module declaration for `@usebruno/converters` (^0.22.0).
 * The published package ships `dist/cjs/index.js` with NO top-level `.d.ts`
 * and its internal `.d.ts` references `@usebruno/schema-types`, a devDependency
 * that is not installed here. We call only `brunoToOpenCollection`; its input is
 * adapted from our NormalizedCollection (see openCollectionExport.ts), so `any`
 * on the boundary is intentional and safe.
 */
declare module '@usebruno/converters' {
  export function brunoToOpenCollection(collection: any): any;
}
```
(Uses `@typescript-eslint/no-explicit-any` — the same warning the existing `usebruno-lang.d.ts` carries at 12/14/16; consistent with baseline, warnings not errors.)

### `plugins/bruno-backend/src/service/openCollectionExport.ts` (NEW — the adapter + serializer)
`import type { CollectionDetail, NormalizedCollection, Item, RequestItem, FolderItem, RequestAuth, RequestBody, KeyValue, Environment } from '../types';` · `import { brunoToOpenCollection } from '@usebruno/converters';` · `import yaml from 'js-yaml';`

Local minimal interface + helpers (all pure, no I/O):
- `const REDACTED = '<redacted>';`
- `interface BrunoCollectionLike { name: string; brunoConfig?: { version?: string }; environments?: unknown[]; items?: unknown[]; root?: { docs?: string }; }`
- `normalizedToBrunoCollection(collection: NormalizedCollection): BrunoCollectionLike` — top-level assembler (name, brunoConfig.version, environments via `mapEnv`, items via `mapItems`, root.docs from `readme`). This is the D-D choke point (all redaction happens in the helpers it calls).
- `mapEnv(env: Environment)` → `{ name, variables: env.variables.map(v => ({ name: v.name, secret: true, disabled: v.enabled === false })) }` (value dropped by `secret:true`).
- `mapItems(items: Item[]): unknown[]` → recurse; per item dispatch on `item.type`.
- `mapRequest(item: RequestItem)` → `{ type: item.type === 'graphql' ? 'graphql-request' : 'http-request', name, seq, request: { method, url, headers, params, body: mapBody(item.body), auth: mapAuth(item.auth), script: { req: item.script?.req ?? null, res: item.script?.res ?? null }, tests: item.tests ?? null, docs: item.docs ?? null } }`. (Assertions **omitted** per R-C.)
- `mapFolder(item: FolderItem)` → `{ type: 'folder', name: item.name, items: mapItems(item.items), ...(item.docs ? { root: { docs: item.docs } } : {}) }`.
- `mapBody(body?: RequestBody)` → nested Bruno body block per the Body sub-map above.
- `mapAuth(auth?: RequestAuth)` → nested Bruno auth block per the Auth sub-map above, with secret values → `REDACTED`. Read flat fields via `auth[k]` (typed `unknown`, coerce with `String(...)` / `?? null`).
- `toOpenCollectionYaml(detail: CollectionDetail): string` — the public entry:
  ```
  const bruno = normalizedToBrunoCollection(detail.collection);
  const oc = brunoToOpenCollection(bruno);
  oc.extensions = { ...(oc.extensions ?? {}), bruno: { ...(oc.extensions?.bruno ?? {}), exportedAt: new Date().toISOString(), exportedUsing: 'bruno-for-backstage' } };
  return yaml.dump(oc, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
  ```
Export `toOpenCollectionYaml` (and optionally `normalizedToBrunoCollection` for future reuse). **Do NOT** import or re-export the collectionService — keep this module dependency-light (types + converter + yaml only).

### `plugins/bruno-backend/src/service/router.ts`
- Add import: `import { toOpenCollectionYaml } from './openCollectionExport';` (top, near the `generateCollectionHtml` import at `:13`).
- New route, placed **immediately after** the `/collections/:id/docs` handler (after `router.ts:75`, before `/dashboard` at `:77`):
  ```ts
  router.get('/collections/:id/opencollection.yml', (req, res) => {
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Unknown collection: ${req.params.id}` });
      return;
    }
    res.type('text/yaml').send(toOpenCollectionYaml(detail));
  });
  ```
- Update the route-list docblock/comment if one enumerates routes (check the header comment near `createRouter`).
- No auth call (matches sibling read routes). No new `createRouter` dep.

### `plugins/bruno-backend/package.json`
- `dependencies`: add `"js-yaml": "^4.1.0"` (alphabetical, between `express-promise-router` and the `@usebruno/*` block — keep JSON valid).
- `devDependencies`: add `"@types/js-yaml": "^4.0.9"`.
- (No install step is run by the executor unless the harness requires it; both are already present in the root `node_modules`. Declaring them satisfies `import/no-extraneous-dependencies` for the new direct import.)

## Frontend edits

### `plugins/bruno/src/api/BrunoApi.ts`
Add to the `BrunoApi` interface (after `getDocsUrl`, keeping the docblock style):
```ts
/** GET /collections/:id/opencollection.yml — raw OpenCollection YAML text. */
getOpenCollectionYaml(id: string): Promise<string>;
```

### `plugins/bruno/src/api/BrunoClient.ts`
Add a method mirroring `getDocsUrl`/`getConnection` error handling, but returning **text** not JSON:
```ts
async getOpenCollectionYaml(id: string): Promise<string> {
  const base = await this.baseUrl();
  const path = `/collections/${encodeURIComponent(id)}/opencollection.yml`;
  const res = await this.fetchApi.fetch(`${base}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Bruno backend request to ${path} failed (${res.status}): ${text}`
    );
  }
  return res.text();
}
```
(No `types.ts` change — return type is a bare `string`.)

## Executor watch-list
1. **Do NOT `import type { BrunoCollection }` from `@usebruno/converters`.** It chases the missing `@usebruno/schema-types` and breaks tsc. Use the local ambient decl + our own `BrunoCollectionLike`. Verify with `yarn tsc` (0 errors, repo-level).
2. **Item type strings are load-bearing:** the converter dispatches on `'http-request'`/`'graphql-request'`/`'folder'` (`items/index.ts:86-96`), NOT our `'http'`/`'graphql'`. A wrong string silently drops the item (`toOpenCollectionItem` returns `null`, filtered out). After building, sanity-check that a mapped http request lands under `oc.items[].info.type === 'http'`.
3. **Auth/body must be NESTED, not flat.** Our `RequestAuth`/`RequestBody` are flat; `toOpenCollectionAuth`/`toOpenCollectionBody` read nested (`auth.basic.password`, `body.json`, etc.). A flat pass-through yields empty auth/body in the output.
4. **Redaction is the single choke point (D-D) and lives in the ADAPTER.** Never mutate `detail.collection` (shared cache). Build a fresh object. Confirm: `secret:true` on every env var (value dropped by converter `environment.ts:83-86`); auth `password`/`token`/`value` → `REDACTED`; usernames/key-names/urls kept.
5. **Never log the YAML or any secret.** No `logger.*` in `openCollectionExport.ts` at all (pure module). The router logs nothing new.
6. **YAML options must be exactly** `{ indent: 2, lineWidth: -1, noRefs: true, sortKeys: false }` (Bruno parity). `import yaml from 'js-yaml'` (default import; `@types/js-yaml` present).
7. **Timestamp:** real `new Date().toISOString()` — this is a live endpoint, not a workflow script.
8. **Route placement + method:** GET, open (no `httpAuth`), after `/docs`, before `/dashboard`. `res.type('text/yaml').send(...)` — raw string, not `res.json`.
9. **Client returns `res.text()`** (not `.json()`); 404 → thrown Error (P5 handles). Mirror existing error-string format.
10. **Lint:** NEW files must be clean modulo the same stylistic baseline the repo already carries. Style rules in force (from the baseline run): `@stylistic/operator-linebreak` (leading `=`), `@stylistic/indent-binary-ops`, `@stylistic/arrow-parens` (parens around single arrow arg). The ambient `.d.ts` `any` triggers the same `no-explicit-any` **warning** as `usebruno-lang.d.ts` (acceptable — warning, matches baseline). `import type` for type-only imports; leading-`|` multi-line unions if any.

## Risks
- **R-A (adapter fidelity / drift from Bruno's canonical output).** The adapter reconstructs Bruno's nested shapes from our lossy flat model. Output will be a **valid, faithful-for-docs** OpenCollection but **not byte-identical** to what Bruno's own exporter produces from the source `.bru` files (missing collection/folder request-defaults, settings, examples, tags, brunoConfig). This is inherent to D-C over a direct raw-file serializer and was accepted. Mitigation: the P5 docs iframe only needs items/envs/docs, all of which are produced. Document the divergence in the module docblock.
- **R-B (converter version drift).** We read the canonical field-read logic from the local Bruno monorepo (`0.1.0` src) as the twin of the installed `0.22.0` dist. Runtime-verified that `brunoToOpenCollection` exists and dispatches on the same type strings. If a future converter bump changes the read shape, the adapter (untyped boundary) won't catch it at compile time. Mitigation: pinned `^0.22.0`; a smoke check that `oc.items.length === requestCount+folderCount` on a known sample.
- **R-C (assertions).** NormalizedCollection `Assertion{expr,op,value,enabled}` does not match Bruno's assertion input shape (`toOpenCollectionAssertions` expects KeyValue-like `{name,value,enabled}`). **Recommendation: OMIT assertions from the adapter output** (docs don't render them meaningfully and a mismapping could corrupt the runtime block). Flagged so the executor doesn't try to force-map them.
- **R-D (header/param/body values not redacted).** D-D redacts auth + env secrets only. A secret embedded in a header value (e.g. a literal `Authorization: Bearer <token>` header parsed as a KeyValue) or a request body would still appear in the exported YAML and the P5 iframe. This matches today's native-viewer/`generateCollectionHtml` exposure (no regression) but is a real surface. Mitigation/decision: out of scope for this POC; note it in the docblock and defer to a follow-up if broader redaction is required (ties to NEXT-STEPS R9 / D-H).
- **R-E (added dep).** `js-yaml` is added as a direct dep. Low risk: already in the tree at `4.3.0` (transitive of converters, which pins `^4.1.1`), `@types/js-yaml` present. No new install churn expected; if the harness runs `yarn install`, it is a no-op resolution.
- **R-F (empty/degenerate collection).** A collection with no items → `brunoToOpenCollection` omits `items` (guarded `if (items.length)`, `:123`). Output is still valid (`opencollection:'1.0.0'`, `info.name`, `bundled:true`, `extensions.bruno`). No crash.

## Gates (authoritative — NOT backstage-cli build)
```
yarn tsc                                                                  # 0 errors, repo-level
yarn lint:bruno plugins/bruno-backend/src plugins/bruno/src/api           # NEW code clean
```
**Baseline note (judge NEW errors only):** the pre-existing backend style baseline already reports **5 errors + 3 warnings** on unchanged files: `collectionService.ts:300` (operator-linebreak), `collectionService.ts:684` (indent-binary-ops), `router.ts:39` (operator-linebreak), `router.ts:131` (arrow-parens), `connectionStore.ts:43` (arrow-parens), and `usebruno-lang.d.ts:12/14/16` (no-explicit-any warnings). NEW code (`openCollectionExport.ts`, `usebruno-converters.d.ts`, the router route, the two client methods) must introduce **zero new errors**; the ambient-decl `any` warning is acceptable (matches the `usebruno-lang.d.ts` precedent). No tests. Minimal changes; one justified dep (`js-yaml` + `@types/js-yaml`).
