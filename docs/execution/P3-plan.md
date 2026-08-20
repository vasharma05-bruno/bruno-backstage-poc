# P3 — Card connect UX (PLUGIN frontend) — Execution Plan (LOCKED)

> Scope: **`plugins/bruno` frontend only.** No tests. No backend changes (P2 is done). No docs-column card (P4). No `metadata.links` (P5). Minimal diff; match existing style (MUI v4, `InfoCard`/`Grid`/`Typography`, existing loading/error patterns).
>
> Validated by the orchestrator against the tree: `BrunoClient` calls everything via `this.fetchApi.fetch` (BrunoClient.ts:24) so the identity token is auto-attached; the shared `isBrunoCollection` filter is used by both card (extensions.tsx:27) and tab (:46); the `"My name is{name}"` debug string at BrunoCard.tsx:80 is real; deps `@backstage/catalog-model`, `@backstage/core-plugin-api`, `@backstage/plugin-catalog-react` already present. GET `/connections/:entityRef` returns `githubUrl` (not `sourceUrl`).

## Locked decisions (orchestrator) — do NOT re-litigate
1. **Broaden ONLY the card filter.** Add `isApiEntity = (e) => e.kind.toLowerCase === 'api'` and use it for `brunoCard` (extensions.tsx:27). **Leave the docs-tab filter (`brunoDocsContent`, :46) on the existing `isBrunoCollection` unchanged.** (Overrides the planner's shared-filter Option A — avoids attaching an empty "API Docs" tab to every API entity.) Consequence: runtime-connected (non-annotated) entities get the card now; the full API-Docs tab remains provider-materialized-only this phase (revisit in P4 if we want the tab for connected entities).
2. **Authenticated fetch via existing `fetchApi.fetch`.** All three new client methods use `this.fetchApi.fetch` exactly like `getJson` (BrunoClient.ts:22-32). No new api-ref, no new dependency. `encodeURIComponent(entityRef)` for the GET/DELETE path param (ref contains `/`).
3. **Provider-vs-runtime distinction by annotation.** If `getCollectionId(entity)` is present → provider-materialized: behave exactly as today (use that id, `getCollection(id)`, render connected; **no** `GET /connections` call; **hide Disconnect**). If absent → runtime candidate: on mount `getConnection(entityRef)` → record ⇒ connected (`collectionId = record.collectionId`, `sourceUrl = record.githubUrl`, then `getCollection`), 404 ⇒ not-connected prompt.
4. **Fix the `"My name is{name}"` bug** (BrunoCard.tsx:80 → render just `{name}`).
5. **URL hardening before connect** (client-side): valid URL, host contains `github`, ≥2 path segments (`owner/repo`), and **reject `/blob/` file URLs** with a clear message (backend user-token fallback mishandles `/blob/` + slashed branches — catch at input). Permissive otherwise.
6. **Private-token flow:** attempt public connect (no token) → on failure call `githubAuth.getAccessToken(['repo'])` **non-optional** (opens popup if GitHub not connected) → retry connect with token. On decline (rejection) → error state: **"GitHub access needed for private repos — Connect GitHub."** No machine-readable "needs-token" signal exists from P2, so any post-validation connect failure triggers the token retry — acceptable for POC.

## File changes

### `src/extensions.tsx`
- Add `const isApiEntity = (entity: Entity): boolean => entity.kind.toLocaleLowerCase('en-US') === 'api';`
- `brunoCard` (:27): `filter: isApiEntity`.
- `brunoDocsContent` (:46): **unchanged** (`filter: isBrunoCollection`). Keep `isBrunoCollection` defined.

### `src/api/types.ts` (append after `CollectionDetail`)
```ts
export interface ConnectResult { collectionId: string; name: string; requestCount: number; }
export interface ConnectionRecord {
  entityRef: string; collectionId: string; githubUrl: string; connectedBy: string; updatedAt: string;
}
```

### `src/api/BrunoApi.ts` (add to interface + import DTOs)
```ts
connect(entityRef: string, url: string, token?: string): Promise<ConnectResult>;
getConnection(entityRef: string): Promise<ConnectionRecord | undefined>; // undefined on 404
disconnect(entityRef: string): Promise<void>;
```

### `src/api/BrunoClient.ts` (implement, import DTOs)
- `connect`: `POST {base}/connections`, headers `Content-Type: application/json`, body `JSON.stringify({ entityRef, url, userGithubToken: token })`; throw on `!res.ok`; return json as `ConnectResult`. (Passing `undefined` token omits the key — correct for public.)
- `getConnection`: `GET {base}/connections/${encodeURIComponent(entityRef)}`; `404 → undefined`; throw on other `!res.ok`; return `ConnectionRecord`.
- `disconnect`: `DELETE {base}/connections/${encodeURIComponent(entityRef)}`; ok/204 fine, else throw.
- Reuse `this.baseUrl()` + the existing error-text pattern. `index.ts`/`extension.ts` need no change.

### `src/components/BrunoCard/BrunoCard.tsx` (state-machine rewrite)
- Imports: add `stringifyEntityRef` (`@backstage/catalog-model`), `githubAuthApiRef` (`@backstage/core-plugin-api`), `TextField` + `Button` (`@material-ui/core`). Keep `useApi`, `useEntity`, `OpenInBruno`, `getCollectionId`, `getSourceUrl`, `shorten`, `Progress`, `InfoCard`, `Link`, `Grid`, `Typography`, `Box`.
- `const entityRef = stringifyEntityRef(entity);` `const githubAuth = useApi(githubAuthApiRef);`
- Discriminated state `status: 'loading' | 'notConnected' | 'connecting' | 'connected' | 'error'` with `detail`, `sourceUrl`, `collectionId`, `errorMsg`. Replace the current `detail/error/loading` triple + hard-error branch (BrunoCard.tsx:65-70) entirely.
- Mount effect per locked decision 3.
- **notConnected:** `InfoCard` body with GitHub-URL `TextField` + "Connect" `Button`; inline validation message (locked decision 5); on submit → `connecting` → connect flow (locked decision 6).
- **connecting:** `<Progress />` + "Connecting…".
- **connected:** reuse the existing layout (name/requestCount/source `Link`+`shorten`/`OpenInBruno`), fix line 80, add **Disconnect** `Button` (only when no annotation) → `disconnect(entityRef)` → `notConnected`.
- **error:** existing error `Typography` pattern; for the decline case show the exact copy in locked decision 6.

## Consumers touched
`extensions.tsx`, `api/types.ts`, `api/BrunoApi.ts`, `api/BrunoClient.ts`, `components/BrunoCard/BrunoCard.tsx`. No change to `api/index.ts`, `api/extension.ts`, `OpenInBruno/*`, `lib/*`, `package.json`, or any backend file.

## Executor watch-list
1. `encodeURIComponent(entityRef)` on GET/DELETE — required.
2. Body key is `userGithubToken`; omit when no token.
3. `getAccessToken(['repo'])` must run inside the button `onClick` (user gesture) for the popup.
4. Never render/log the user token.
5. Verify: `yarn workspace @usebruno/bruno-plugin-poc build` (typecheck) + `yarn workspace @usebruno/bruno-plugin-poc lint`. No tests.
