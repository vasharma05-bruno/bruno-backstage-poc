# P4 — Docs-column card (PLUGIN frontend) — Execution Plan (LOCKED)

> Scope: **`plugins/bruno` frontend only.** No tests. No backend changes. No changes to the connect flow (`BrunoCard`, P3) or the full docs tab (`brunoDocsContent`/`CollectionDocs`). Minimal diff; match existing style (functional component, cancelled-guard effect, `InfoCard`, MUI v4).
>
> Validated by the orchestrator: `plugin.ts:3,20` is the sole extension-registration site; `MethodBadge(props:{method:string})` exported (`MethodBadge/index.ts`); `isFolderItem`/`isRequestItem` exported (`api/types.ts:146,151`); `EntityCardBlueprint.make({name,params:{filter,loader}})` pattern at `extensions.tsx:32-39`; blueprint `filter` is synchronous (entity-only) so async connection lookup must happen in the component.

## Locked decisions (orchestrator)
1. **Option A — self-contained compact renderer.** Author a small read-only recursive tree inside the new card; reuse `MethodBadge` + the `isFolderItem`/`isRequestItem` guards. Do **not** edit `CollectionDocs/` or export its selection-coupled `CollectionTree`.
2. **Name `CollectionTreeCard`** exported from new folder `components/CollectionTree/` (avoids clashing with the existing `CollectionTree` inside `CollectionDocs/`).
3. **Gating:** filter `isApiEntity`; the component returns **`null`** for `loading`, `hidden` (no annotation + 404 connection), and `error` — so unrelated/erroring API entities show no card (no empty-slot flash). Only the `ready` state renders an `InfoCard`.
4. **Title "Collection Tree"** (distinct from BrunoCard's "Bruno Collection"). Accept auto-placement — no app-side layout config this phase (R7).

## New files

### `plugins/bruno/src/components/CollectionTree/CollectionTreeCard.tsx`
`export function CollectionTreeCard(): JSX.Element | null`

State machine (mirror `BrunoCard.tsx:51-113` fetch/cancelled-guard, minus connect states):
```ts
type State =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; detail: CollectionDetail }
  | { status: 'error' };
```
Effect (deps `[brunoApi, entityRef, annotationCollectionId]`):
- `entityRef = stringifyEntityRef(entity)`, `annotationCollectionId = getCollectionId(entity)`.
- annotation present → `getCollection(annotationCollectionId)` → `ready` (error → `error`).
- else → `getConnection(entityRef)`: `undefined` → `hidden`; else `getCollection(record.collectionId)` → `ready` (error → `error`).
- cancelled-guard on both paths.

Render:
- `loading` / `hidden` / `error` → `return null`.
- `ready` → `<InfoCard title="Collection Tree"><CompactTree items={detail.collection.items} /></InfoCard>`.

Reused (all confirmed exported): `useEntity` (`@backstage/plugin-catalog-react`), `useApi` (`@backstage/core-plugin-api`), `brunoApiRef` (`api/BrunoApi.ts`), `stringifyEntityRef` (`@backstage/catalog-model`), `getCollectionId` (`lib/annotations.ts`), `InfoCard`/`Progress` (`@backstage/core-components`), types `CollectionDetail`/`Item` (`api/types.ts`).

`CompactTree` (in the same file or a sibling): recurse `Item[]`; `isFolderItem(item)` → a folder row (name + `@material-ui/icons/Folder`) with nested `CompactTree` for `item.items`; `isRequestItem(item)` → `<MethodBadge method={item.method} />` + `item.name`. MUI `List`/`ListItem`/`ListItemText`/`Box`/`Typography`. Read-only (no `onSelect`/selection).

### `plugins/bruno/src/components/CollectionTree/index.ts`
`export { CollectionTreeCard } from './CollectionTreeCard';`

## Extension + registration

### `plugins/bruno/src/extensions.tsx` (after `brunoCard`, before `brunoDocsContent`)
```tsx
export const brunoCollectionTreeCard = EntityCardBlueprint.make({
  name: 'collection-tree',
  params: {
    filter: isApiEntity,
    loader: () =>
      import('./components/CollectionTree').then((m) => <m.CollectionTreeCard />)
  }
});
```
(unique `name: 'collection-tree'`; reuse existing `isApiEntity`.)

### `plugins/bruno/src/plugin.ts`
- Import (`:3`): add `brunoCollectionTreeCard`.
- Array (`:20`): `extensions: [brunoApi, brunoCard, brunoCollectionTreeCard, brunoDocsContent]`.
- (Optional) update the doc comment listing extensions.

## Consumers touched
`extensions.tsx` (+1 extension), `plugin.ts:3,20` (import + register), new `components/CollectionTree/CollectionTreeCard.tsx` + `index.ts`. Nothing else — no backend, no `CollectionDocs`, no `package.json`.

## Executor watch-list
1. Return `null` (not an empty `InfoCard`) for loading/hidden/error — verify no empty card slot appears on an unrelated API entity.
2. Reuse `MethodBadge` + the two type guards; do not duplicate badge/color logic.
3. Verify: `yarn workspace @usebruno/plugin-bruno build` (typecheck). No tests.
