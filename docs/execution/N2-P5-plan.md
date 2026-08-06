# N2-P5 — Link API tab (frontend) — Execution Plan (LOCKED)

> Replace `LinkApiPlaceholder` with a two-panel Link API tab: left = catalog `kind:API` entities lacking `bruno.dev/collection-path`; right = manual GitHub-URL → `brunoApi.connect` reusing BrunoCard's gesture-safe two-step OAuth. Single URL only (multi-collection picker = N2-P6). No tests, no backend changes. Minimal diff, MUI v4 + core-components.
>
> Verified: `catalogApiRef: ApiRef<CatalogApi>` exported from `@backstage/plugin-catalog-react` (already a dep `^3.2.0`); `getEntities({filter})` → `{items}`; no server-side "annotation-absent" filter (client-side drop required); `BRUNO_COLLECTION_PATH_ANNOTATION` exists (`lib/annotations.ts:8`). Gated by `yarn tsc` + `yarn lint:bruno` (not just package build).

## Locked decisions
1. **Delete `LinkApiPlaceholder.tsx`** after the swap (unreferenced; clean diff).
2. **Owner** shown only when present & meaningful (`spec.owner`/ownedBy relation); **domain omitted** (not cheaply available). specType shown when `spec?.type` is a string.
3. **Plain refetch** after a successful link (no optimistic hide). Note eventual-consistency: the linked entity may still appear until the N2-P2 processor injects the annotation on next catalog refresh — acceptable; the `linked` success state gives feedback.
4. **Duplicate BrunoCard's `onConnect`/`onConnectGithub` two-step into `LinkPanel`** (minimal diff; do NOT extract a shared hook / touch BrunoCard).

## New files — `plugins/bruno/src/components/BrunoPage/LinkApi/`
- **`LinkApiTab.tsx`** (container, mirrors `CollectionsTab.tsx`): `useApi(catalogApiRef)`; load-once cancel-guard effect + a `refreshKey` in deps for refetch; `catalogApi.getEntities({ filter: { kind: 'API' } })` → `.items` → drop entities with `metadata.annotations?.[BRUNO_COLLECTION_PATH_ANNOTATION]` → map to `UnlinkedApi { entityRef, name, specType?, owner? }` via `toUnlinkedApi(entity)`. State union `loading|ready|error` (`Progress`/`WarningPanel`); ready → 2-col `Grid` (`xs=12 md=6`): left `ApiList`, right `LinkPanel`; empty (all linked) → `EmptyState` left. Left header "APIs without collections (N)". Selection `selectedRef` in state; `onLinked = () => { setSelectedRef(undefined); setRefreshKey(k=>k+1); }`.
- **`ApiList.tsx`** (presentational): props `{ apis, selectedRef?, onSelect }`; MUI `List`/`ListItem button selected onClick`; primary = name, secondary = specType/owner Chips (omit when absent). Export `UnlinkedApi` + `toUnlinkedApi` here (co-located). `specType` = `typeof entity.spec?.type === 'string' ? entity.spec.type : undefined`; `owner` via `getEntityRelations(entity, RELATION_OWNED_BY)[0]?.name` or `spec.owner`, shown only when truthy.
- **`LinkPanel.tsx`** (owns connect): props `{ selectedRef?, selectedName?, onLinked }`; `useApi(brunoApiRef)` + `useApi(githubAuthApiRef)`; local `url`/`urlError`/`inFlight` + `validateUrl` copied from BrunoCard; state union `idle|connecting|needsGithub|linked|error`. **`onConnect`** (public, gesture step 1): guard inFlight, validate, `connecting`, `await brunoApi.connect(selectedRef, url)` → `linked` + `onLinked()`; catch → `needsGithub`. **`onConnectGithub`** (gesture step 2, fired from the "Connect GitHub" button onClick): `getAccessToken(['repo'])` as the FIRST await → then `connect(selectedRef, url, token)` → `linked` + `onLinked()`. Reset local state on `selectedRef` change (`useEffect([selectedRef])`). No selection → instruction text. LINK disabled when `!selectedRef` or connecting. Wrap in `InfoCard title={\`Link a Bruno collection to ${selectedName ?? '…'}\`}`. Static "What linking does" explainer (store → processor injects annotation on refresh → surfaces attach, no PR).
- **`index.ts`**: `export { LinkApiTab } from './LinkApiTab';`

## Modified
- `BrunoPage.tsx`: import `LinkApiTab` from `./LinkApi` (replace the placeholder import at :6); render `<LinkApiTab />` at :28.
- **Delete** `LinkApiPlaceholder.tsx`.

## Gate conformance (executor MUST run `yarn tsc` + `yarn lint:bruno`)
- Narrow `spec?.type` with `typeof === 'string'` (getEntities returns base `Entity`, not `ApiEntityV1alpha1`).
- `import type` for type-only imports (`UnlinkedApi`, `ConnectResult`, `Entity`, `CompoundEntityRef`).
- Multi-line unions with leading `=`/`|` (@stylistic/operator-linebreak).
- Early `if (!selectedRef) return;` guard instead of `!` non-null.
- **Gesture safety (the one behavioral must):** `getAccessToken(['repo'])` is the FIRST `await` in `onConnectGithub`'s click handler — never after another await. Keep the two-handler split.

## Executor watch-list
1. Client-side annotation filter using `BRUNO_COLLECTION_PATH_ANNOTATION` (don't hardcode).
2. Delete `LinkApiPlaceholder.tsx`; confirm no other references.
3. Gates: `yarn tsc` (0 errors) AND `yarn lint:bruno plugins/bruno/src/components/BrunoPage` (clean). No tests.
