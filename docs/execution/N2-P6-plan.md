# N2-P6 — Multi-collection discovery + picker — Execution Plan (LOCKED)

> Backend `POST /connections/discover` (walk repo once → all collection roots) + a SCAN→pick→LINK step in `LinkPanel` (0/1/>1). LINK stays `brunoApi.connect(entityRef, chosenGithubUrl, token?)`. No schema change (chosen sub-path encoded in the stored `github_url`). No tests. Gated by `yarn tsc` + `yarn lint:bruno`.
>
> Verified: `connectFromUrl` handles `/tree/<ref>/<subpath>` end-to-end (`normalizeGithubUrl` preserves it; `parseGithubUrl`/`readUrlTreeViaOctokit` filter by subpath); `findBrunoJson`/`findOpenCollectionYml` return only the SHORTEST root (need a new all-roots walk); `parseCollection` locates a single root internally (slice a sub-FileTree per root and reuse it unchanged); `readUrlTreeViaOctokit` already does `octokit.repos.get → default_branch`; `integrations.github.byUrl(url)?.config` exposes `apiBaseUrl` + `token`.

## Locked decisions
- **D1: POST `/connections/discover`** with `{ url, userGithubToken? }` in the body (token out of query/URL logs; matches `POST /connections`). Auth `allow:['user']`; no `userInfo` (nothing stored).
- **D2: backend returns a fully-qualified `githubUrl`** per candidate → the frontend LINK passes it verbatim to `connect` (no client-side URL assembly).
- **D3: nested counting as-is** — a parent root's slice includes nested children (reflects pointing at that dir). Sample repos don't nest; edge-case only.
- **D4: resolve default branch during discover when the input has no `/tree/<ref>`** — reuse the `octokit.repos.get({owner,repo}).data.default_branch` pattern; build the Octokit with `integrations.github.byUrl(url)?.config.token` (service) or the user token, `baseUrl = config.apiBaseUrl ?? 'https://api.github.com'`. Needed so composed subpath URLs are valid GitHub `/tree/<ref>/<path>`.
- **D5: reuse the private-scan token for the subsequent LINK** (held in a `useRef`, never logged) so there's no second OAuth popup.

## Backend
### `collectionService.ts`
- New module helpers (near `findBrunoJson` / `posixDirname` / `joinPosix`):
  - `findAllCollectionRoots(tree): Array<{ rootPrefix: string; format: 'bru'|'yml' }>` — collect EVERY dir whose key is/ends-with `/bruno.json` or `/opencollection.yml` into a `Map` by `rootPrefix` (yml wins on tie, matching `detectFormat`); sort by `rootPrefix`.
  - `sliceTreeAtRoot(tree, rootPrefix): FileTree` — re-key files under `rootPrefix` to root-relative so the existing `parseCollection` sees one manifest at its root.
  - `composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref): string` → `https://<host>/<owner>/<repo>/tree/<ref>/<fullSubpath>` (join input subpath + root via `joinPosix`); when root is `''` and input had no subpath, reduce to the repo URL.
  - `resolveRef(integrations, url, userToken?): Promise<string>` — `parseGithubUrl(url).ref ?? octokit.repos.get(...).default_branch` (Octokit built with service/user token per D4).
- New method on `CollectionService` (after `connectFromUrl`): `discoverCollections(input:{url,userToken?}): Promise<DiscoverResult>`:
  1. `normalized = normalizeGithubUrl(url)`; `tree = await readUrlTreeWithCreds(reader, integrations, normalized, logger, {userToken})` (one walk).
  2. `ref = await resolveRef(...)`; `roots = findAllCollectionRoots(tree)`.
  3. per root: `sub = sliceTreeAtRoot(tree, rootPrefix)`; `collection = parseCollection({id:'discover',name:'discover',type:'url',target:normalized}, sub, logger)`; `requestCount = countRequests(collection.items)`; `githubUrl = composeCollectionUrl(normalized, rootPrefix, ref)`; `collectionId = collectionIdFromUrl(githubUrl)`; `collectionPath = rootPrefix`; `name = collection.name`.
  4. return `{ collections }`. No caching, no store write.
- Import `DiscoverResult`, `DiscoveredCollection` from `../types`.

### `types.ts` / `index.ts` (backend)
Add + re-export `DiscoveredCollection { collectionPath, name, requestCount, collectionId, githubUrl }` and `DiscoverResult { collections: DiscoveredCollection[] }`.

### `router.ts`
After `POST /connections`: `router.post('/connections/discover', ...)` — `await httpAuth.credentials(req,{allow:['user']})`; `{url,userGithubToken}=req.body??{}`; `if(!url) throw new InputError('`url` is required.')`; `res.json(await collectionService.discoverCollections({url, userToken:userGithubToken}))`. Update route-list docblock.

## Frontend
- `api/types.ts`: mirror `DiscoveredCollection` + `DiscoverResult`.
- `BrunoApi.ts`: `discover(url: string, token?: string): Promise<DiscoverResult>;`
- `BrunoClient.ts`: `discover` mirroring `connect` (POST `/connections/discover`, body `{url, userGithubToken: token}`, same error handling).
- `LinkPanel.tsx`: extend the `State` union (leading-`|` style) with `scanning | needsGithubScan | scanned{collections} | noCollections`, rename the existing `needsGithub`→`needsGithubLink`; add `selectedCollectionId` state + `scanTokenRef`. Flow: **SCAN** button → `onScan` (public `discover`; fail→`needsGithubScan`) / `onScanGithub` (getAccessToken first await → `discover(url, token)`, store token in ref). resolveScan: 0→`noCollections` (clean message, nothing stored); 1→auto-select + `scanned`; >1→`scanned` with a `TextField select`/`MenuItem` picker (value=collectionId, secondary=collectionPath + `${requestCount} requests`), LINK disabled until chosen. **LINK** → `connect(selectedRef, chosen.githubUrl, scanTokenRef.current)`; fail w/o token→`needsGithubLink`. Reset all on `selectedRef` change. Keep MUI `Button` (no navigation → no `LinkButton`). Update the explainer to mention SCAN.

## Executor watch-list
1. Gesture safety unchanged: `getAccessToken(['repo'])` is the FIRST await in `onScanGithub`/the link-github handler.
2. `sliceTreeAtRoot` + existing `parseCollection` (do NOT add a rootPrefix param to parseCollection).
3. D4 ref resolution reuses the Octokit pattern from `readUrlTreeViaOctokit`.
4. Never log the user token.
5. Gates: `yarn tsc` (0 errors) AND `yarn lint:bruno plugins/bruno/src/components/BrunoPage` clean. `import type`, leading-`|` unions. No tests.
