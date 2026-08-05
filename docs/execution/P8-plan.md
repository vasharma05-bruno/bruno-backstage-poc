# P8 — Collection Overview card (renders collection-root README) — Execution Plan (LOCKED)

> A new right-column `EntityCard` that renders the connected collection's root **README** as markdown. Spans backend (fetch + model + both parse paths) and frontend (new card). No tests. Minimal diff, match existing style.
>
> Validated by the orchestrator: both repos carry a markdown README at the collection root (`collection/readme.md`, private root `readme.md`) and NO `docs` field in `opencollection.yml` → the README file is the source. `MarkdownContent` is exported by `@backstage/core-components`. `NormalizedCollection` is defined in `plugins/bruno-backend/src/types.ts:106` and `plugins/bruno/src/api/types.ts:102` (`{id,name,version?,environments,items}`).

## Locked decisions
1. **Source = collection-root README** (`readme.md` or `README.md`, case-insensitive) at the detected `rootPrefix`. Do NOT use `opencollection.yml`'s `docs` field (absent in the target repos). READMEs in subfolders are ignored.
2. **Card renders `null` when the collection has no README** (don't show an empty overview card). Also null while loading / not-connected / error — same gating as `CollectionTreeCard`.
3. Add `readme?: string` to `NormalizedCollection` in **both** `types.ts` files (additive; frontend consumes it).
4. Relative images in a README (e.g. `<img src="quick-start.png">`) won't resolve in-portal — acceptable; text/markdown renders.

## Backend changes — `plugins/bruno-backend`

### `src/types.ts` (~:106)
Add `readme?: string;` to `NormalizedCollection` (after `items`), with a short doc comment ("Collection-root README markdown, if present.").

### `src/service/collectionService.ts`
1. **Fetch filters (3)** — also keep the collection README. Match the basename case-insensitively:
   - `walkLocal` (~:354): add `|| /^readme\.md$/i.test(entry.name)`.
   - `readUrlTree` (~:383): add `|| /(^|\/)readme\.md$/i.test(rel)`.
   - `readUrlTreeViaOctokit` (~:491): add `&& !/(^|\/)readme\.md$/i.test(rel)` to the skip condition (i.e. don't skip readmes).
   (`.yaml` and other `.md` files stay excluded; only `readme.md` is admitted.)
2. **New helper** (near `findBrunoJson`/`findOpenCollectionYml`):
   ```ts
   function findReadme(tree: FileTree, rootPrefix: string): string | undefined {
     const prefix = rootPrefix ? `${rootPrefix}/` : '';
     for (const [key, value] of tree.files) {
       if (key.toLowerCase() === `${prefix}readme.md`) return value;
     }
     return undefined;
   }
   ```
3. **Populate in BOTH parse paths**, right before the return:
   - `.bru` `parseCollection` (~:541-550): `const readme = findReadme(tree, rootPrefix);` and add `readme` to the returned object.
   - `parseCollectionYml` (P7a): same — `const readme = findReadme(tree, rootPrefix);` add to its return.

## Frontend changes — `plugins/bruno`

### `src/api/types.ts` (~:102)
Add `readme?: string;` to `NormalizedCollection` (mirror the backend).

### NEW `src/components/CollectionOverview/CollectionOverviewCard.tsx`
`export function CollectionOverviewCard(): JSX.Element | null` — mirror `CollectionTreeCard`'s resolve/gating exactly (state `loading|hidden|ready|error`; annotation → `getCollection`; else `getConnection(entityRef)` → `getCollection`; cancelled-guard). Render:
- non-`ready` → `null`.
- `ready` && `detail.collection.readme` → `<InfoCard title="Collection Overview"><MarkdownContent content={detail.collection.readme} dialect="gfm" /></InfoCard>` (import `MarkdownContent`, `InfoCard` from `@backstage/core-components`).
- `ready` && no readme → `null` (no empty card).

### NEW `src/components/CollectionOverview/index.ts`
`export { CollectionOverviewCard } from './CollectionOverviewCard';`

### `src/extensions.tsx`
Add after `brunoCollectionTreeCard`:
```tsx
export const brunoCollectionOverviewCard = EntityCardBlueprint.make({
  name: 'collection-overview',
  params: {
    filter: isApiEntity,
    loader: () =>
      import('./components/CollectionOverview').then((m) => <m.CollectionOverviewCard />)
  }
});
```

### `src/plugin.ts`
Import `brunoCollectionOverviewCard` and add it to the `extensions` array.

## Consumers touched
Backend: `types.ts` (+1 field), `collectionService.ts` (3 filters, 1 helper, 2 populate lines). Frontend: `api/types.ts` (+1 field), new `CollectionOverview/` (2 files), `extensions.tsx` (+1 extension), `plugin.ts` (import + register). No router/provider/`.bru`-logic changes.

## Executor watch-list
1. `readme?` must be added to BOTH `NormalizedCollection` definitions (backend + frontend) or the frontend won't type-check the new field.
2. Card returns `null` (not an empty InfoCard) when no README.
3. Verify: `yarn workspace @usebruno/plugin-bruno-backend build` AND `yarn workspace @usebruno/plugin-bruno build`. No tests.
