# P7a — OpenCollection YAML support in the backend parser — Execution Plan (LOCKED)

> Scope: **`plugins/bruno-backend/src/service/collectionService.ts` only.** No tests. No frontend changes. No change to the `.bru` path behavior or to the `NormalizedCollection` model. Minimal diff; match existing style. `@usebruno/filestore@^0.11.0` is already a dep (pins `@usebruno/lang@0.38.0` — no conflict).
>
> Validated by the orchestrator: filter anchors `:354` (`walkLocal`), `:383` (`readUrlTree`), `:491` (`readUrlTreeViaOctokit`); `parseCollection:510`; helpers `findBrunoJson:553`, `commonRootPrefix:566`, `parseEnvironments:585`, `buildTree:629`, `buildTreeForDir:637`, `buildFolder:698`, `parseRequestFile:745`, `mapBody:805`, `mapForm:845`, `mapAuth:857`, `mapScript:880`, `mapAssertions:893`, `sortItems:920`, `countRequests:941`, `posixDirname:964`. Smoke-confirmed: `parseRequest(yml)` → `{type:'http-request', request:{method,url,auth:{mode,basic},body:{mode}}}`; `parseCollection(yml)` → `{collectionRoot, brunoConfig:{name}}`.

## Locked decisions
1. **Design (i): parallel `*Yml` functions.** Leave every existing `.bru` function byte-identical; add a self-contained yml subtree selected by a format detector at the top of `parseCollection`. Do NOT generalize/parametrize the shared `.bru` walk.
2. **Format detector routes the whole tree to one path; `opencollection.yml` wins** over `bruno.json` (matches Bruno's `getCollectionFormat`). Stray `.bru` in a yml collection are ignored, and vice-versa.
3. **Reuse** `mapForm`, `mapAssertions`, `mapScript`, `sortItems`, `AUTH_MODES`, `strOrUndefined`, `joinPosix`, `posixDirname`, `baseName`, `commonRootPrefix`. Auth/body lossiness (`oauth2/awsv4/ntlm/wsse/akamai` → `{mode:'none', unsupportedMode}`; `sparql`/`file` body → `{mode:'none'}`; gql variables + `request.vars`/`settings`/`tags`/`examples` dropped) is intentional and mirrors the `.bru` policy.
4. Use the **synchronous** filestore exports only. Import aliased to avoid the local name collision:
   `import { parseRequest, parseCollection as parseYmlCollection, parseFolder as parseYmlFolder, parseEnvironment as parseYmlEnvironment } from '@usebruno/filestore';` — pass `{ format: 'yml' }` explicitly on every call.

## Changes

### 1. Fetch filters — broaden to also keep `.yml` (`.yaml` stays excluded)
- `walkLocal` `:354`: add `|| entry.name.endsWith('.yml')`.
- `readUrlTree` `:383`: add `|| rel.endsWith('.yml')`.
- `readUrlTreeViaOctokit` `:491`: change to `if (!rel.endsWith('.bru') && !rel.endsWith('bruno.json') && !rel.endsWith('.yml')) { continue; }`.

### 2. Format detection (new private helpers near `findBrunoJson:553`)
- `detectFormat(tree): 'bru' | 'yml'` — `'yml'` if any key is `opencollection.yml` or ends `/opencollection.yml`; else `'bru'`.
- `findOpenCollectionYml(tree): string | undefined` — shortest key that is/ends-with `opencollection.yml` (mirror `findBrunoJson`).
- In `parseCollection` (`:510`), FIRST line of the body: `if (detectFormat(tree) === 'yml') return parseCollectionYml(source, tree, logger);` — existing `.bru` body unchanged below.

### 3. New yml functions (private; place after the `.bru` block, mirror the `.bru` counterparts)
- `parseCollectionYml(source, tree, logger): NormalizedCollection` — root via `findOpenCollectionYml`→`posixDirname` (fallback `commonRootPrefix`); name/version from `parseYmlCollection(manifest,{format:'yml'}).brunoConfig` (override `source.name` only when a name is present; `version = String(brunoConfig.version)` if set); `environments = parseEnvironmentsYml(...)`; `items = buildTreeYml(...)`; return `{id:source.id, name, version, environments, items}`.
- `buildTreeYml` / `buildTreeForDirYml` — mirror `buildTree`/`buildTreeForDir` but: keep `.yml` files; skip `opencollection.yml` and `folder.yml` manifests; skip the `environments` dir; call `parseRequestFileYml` / `buildFolderYml`; reuse `sortItems`.
- `buildFolderYml` — manifest `folder.yml` via `parseYmlFolder`; `name = meta.name || fallbackName`, `seq = meta.seq`, `docs = folderRoot.docs || undefined`; try/catch+`logger.warn`; build `{type:'folder', name, docs, items: buildTreeForDirYml(...)}` + attach `seq`.
- `parseEnvironmentsYml` — mirror `parseEnvironments` with `.yml`; `parseYmlEnvironment`; project to `{name, variables:[{name,value,enabled}]}`; sort by name.
- `parseRequestFileYml(contents, key, logger)` — `try { item = parseRequest(contents,{format:'yml'}); } catch { logger.warn; return undefined; }` then `return adaptFilestoreItem(item, key);`

### 4. Shim `adaptFilestoreItem(item, key): Item | undefined`
- type: `'graphql-request'`→`'graphql'`, `'http-request'`→`'http'`, else `return undefined` (skip grpc/websocket/script/app).
- name `item.name || baseName(key).replace(/\.yml$/,'')`; seq `typeof item.seq==='number'?item.seq:undefined`; docs `item.request?.docs||undefined`; method `(item.request?.method ?? 'get').toUpperCase()`; url `item.request?.url ?? ''`.
- headers/params: map `item.request.headers|params` to our `{name,value,enabled(,type)}` (drop uid/description) — same output as `:768-779`.
- body: `adaptBodyYml(item.request?.body)` — switch on `body.mode`: none/undefined→`{mode:'none'}`; json/text/xml→`{mode, raw: strOrUndefined(body[mode])}`; graphql→`{mode:'graphql', raw: body.graphql?.query ?? ''}`; formUrlEncoded/multipartForm→`{mode, form: mapForm(body[mode])}`; sparql/file/other→`{mode:'none'}`.
- auth: `adaptAuthYml(item.request?.auth)` — falsy→`undefined`; none/inherit→`{mode}`; `AUTH_MODES.includes(mode)`→`{mode, ...(auth[mode] ?? {})}`; else→`{mode:'none', unsupportedMode: mode}`.
- script: collapse `item.request?.script` `{req,res}` (undefined if both empty); tests `item.request?.tests || undefined`; assertions: reuse `mapAssertions({ assertions: item.request?.assertions } as RawRequest)`.

### 5. Imports
Add the aliased filestore import near `:10-14`.

## Consumers touched
Only `collectionService.ts`: 3 filter disjuncts, 1 branch in `parseCollection`, and the new private `*Yml`/`adapt*` functions + import. No `types.ts`, router, plugin, or public-export changes; `loadSource` and `connectFromUrl` benefit automatically.

## Executor watch-list
1. Alias the filestore `parseCollection` import (name collision with the local one).
2. Wrap every filestore call in try/catch (it throws on `folder`/unknown types and re-throws parse errors; it also `console.error`s — that stderr noise is acceptable, don't wrap console).
3. Do NOT modify any `.bru` function or `NormalizedCollection`.
4. Verify: `yarn workspace @usebruno/bruno-backend-plugin-poc build`. No tests.
