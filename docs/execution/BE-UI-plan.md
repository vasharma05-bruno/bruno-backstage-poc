# BE-UI — Bruno UI Flows — **LOCKED**

**Spec:** `docs/Bruno Backstage Plugin PRD - Entity.md` §"UI Flows" → end of document (lines 56–124). **Sole source of truth.** Every other planning doc was deleted deliberately. The current implementation constrains nothing.

**Builds on:** `docs/execution/BE-P1-plan.md` (implemented) — `kind: Bruno` @ `usebruno.com/v1alpha1`, `spec.{type,owner,url,partOf[]}`, ingestion via `BrunoKindProcessor` + `BrunoCollectionEntityProvider`; and `docs/execution/BE-P2-plan.md` (locked) — see §0.

**Out of scope:** OpenCollection YAML generation/storage and Entity Sync backend mechanics — BE-P2. What this plan *assumes* from BE-P2 is pinned in §0 and nowhere else.

**Standing constraints:** no tests; gates are `yarn tsc` (0 errors) + `yarn lint:bruno <paths>` + `yarn prettier:check` + a live boot; feature work in `plugins/bruno` / `plugins/bruno-backend`; `packages/app` touched exactly once (§UI-P1 step 2); never log a user/OAuth token; `import type` for type-only imports; no dead code; one dependency direction.

---

## 0. The BE-P2 contract this plan consumes

Everything below is an **assumption stated as a requirement on BE-P2**. Each has a named graceful-degrade path so every UI phase boots and compiles before BE-P2 lands.

### 0.1 Entity shape additions (REQUIRED — the dashboard tiles have no other source)

BE-P2 must extend the Bruno entity `spec` with exactly:

```ts
spec: {
  type: string; owner?: string; url: string; partOf?: string[];
  /** The generated OpenCollection YAML (BE-P2 §1 Q1). */
  definition?: string;
  /** Total executable requests in the collection. */
  requestCount?: number;
  /** Environment names, e.g. ['local','staging','prod']. */
  environments?: string[];
}
```

> **Reconciled 2026-08-31.** BE-P2 §8 Q3 parked `requestCount`/`environments` as "decide before Phase 3 starts". This plan is that decision: **they are required**, and BE-P2 stamps them. Both are free at generation time (`countRequests` and `collection.environments.length` are already computed by the parser), and both are pure functions of content, so they do not churn `resultHash`.

**Why in `spec` and not annotations.** `buildEntitySearch` (`node_modules/@backstage/plugin-catalog-backend/dist/database/operations/stitcher/buildEntitySearch.cjs.js:18-52`) traverses the whole entity, dot-joining paths, and for a **string array** emits one `search` row per item keyed on the array path (`:32-44`). `DefaultEntitiesCatalog.facets` (`.../dist/service/DefaultEntitiesCatalog.cjs.js:505-538`) is a single `GROUP BY search.key, search.original_value` over that table. So `spec.environments` is directly facetable per-item and `spec.requestCount` per-value. Annotation keys would work too (the path is built by concatenation, so `metadata.annotations.bruno.usebruno.com/environments` is a legal facet key) but a comma-joined annotation string groups as one opaque value and cannot yield a *unique* environment count.

Degrade: facets return `[]`; tiles render `—`.

### 0.2 Backend routes (plugin id `bruno`, i.e. `/api/bruno/*`)

| Route | Used by | Degrade |
|---|---|---|
| `GET /entities/:namespace/:name/docs?theme=light\|dark` → `text/html`, framable, **`user-cookie` auth policy** | UI-P1 docs tab + standalone docs page | iframe shows the tab's error state |
| `GET /entities/:namespace/:name/docs.md` → `text/markdown` | UI-P1 Overview "Documentation" card | card renders `metadata.description`, else hides |
| `GET /entities/:namespace/:name/opencollection.yaml` → `text/yaml` | not used by this plan; listed so BE-P2 keeps the re-key symmetric | — |

**Non-negotiable on the docs route:** it must carry `httpRouter.addAuthPolicy({ path: '/entities/:namespace/:name/docs', allow: 'user-cookie' })` — mirroring `plugins/bruno-backend/src/plugin.ts:89-92` — and apply the same embedding headers as `plugins/bruno-backend/src/service/router.ts:143-167`. The iframe `src` GET carries no `Authorization` header.

**Route-ordering note carried forward from BE-P1 §4:** `router.ts:169` registers the literal `/collections/:id/opencollection.yml`. Any new literal segment must sit *before* a sibling `:param` route.

**Note on the oversized-definition fallback.** BE-P2 §2 omits `spec.definition` above `bruno.definition.maxBytes` and stamps `usebruno.com/definition-omitted: size`. UI-P1's docs tab must check that annotation and fall back to the route above rather than rendering an empty document.

### 0.3 Sync

UI-P1's Sync button is `catalogApi.refreshEntity(stringifyEntityRef(entity))` → `POST /api/catalog/refresh`. This re-runs **processors, not providers**, so it re-runs `BrunoKindProcessor` (which BE-P2 extends). **No new sync route is needed by the UI.**

> **Corrected 2026-08-31.** An earlier draft of this section required BE-P2 to call `ManifestProbe.evict(url)` on the refresh path. BE-P2 §1 Q3 settles this differently and the locked decision governs: the probe lives in `brunoCatalogModule` (`pluginId: 'catalog'`) while the Bruno router lives in `brunoPlugin` (`pluginId: 'bruno'`), so an HTTP handler cannot reach the probe without a cross-plugin in-process import — which is forbidden, and silently wrong on a multi-replica deployment. Instead BE-P2 lowers the probe TTL to a configurable **60 s** and adds ETag revalidation, so a Sync click converges within `bruno.cacheTtlSeconds`. **UI consequence:** Sync is "fresh within a minute", not instantaneous. The success toast must say so rather than implying the content has already changed.

---

## 1. Platform facts (verified; do not re-derive)

**F1 — one entity route for all kinds.** `node_modules/@backstage/plugin-catalog/dist/alpha/pages.esm.js:138` → `path: "/catalog/:namespace/:kind/:name"`. Per-kind behaviour is entirely the `filter` on card/content/header extensions. **No `packages/app` routing change is needed.**

**F2 — a bare `kind: Bruno` entity already renders.** `catalogOverviewEntityContent` (`.../alpha/entityContents.esm.js:8-27`) has no filter, path `/`, title `Overview`, group `overview`. `catalogAboutEntityCard` (`.../alpha/entityCards.esm.js:8-47`) filters only `{$not:{kind:{$in:['user','group']}}}`. Verified live: About + relations + VIEW SOURCE render today.

**F3 — card/content attach points.**
`EntityCardBlueprint` → `entity-content:catalog/overview` input `cards` (`plugin-catalog-react/dist/alpha/blueprints/EntityCardBlueprint.esm.js:9`).
`EntityContentBlueprint` → `page:catalog/entity` input `contents` (`.../EntityContentBlueprint.esm.js:9`).
`EntityHeaderLayoutBlueprint` → `page:catalog/entity` input `headerLayouts` (`.../EntityHeaderLayoutBlueprint.esm.js:10`).
`EntityIconLinkBlueprint` → **`entity-card:catalog/about` input `iconLinks`** (`.../EntityIconLinkBlueprint.esm.js:12`) — i.e. the About **card**, not the title area.

**F4 — filter forms differ per blueprint.** `EntityCardBlueprint`/`EntityContentBlueprint`: `string | FilterPredicate | ((entity)=>boolean)` (`plugin-catalog-react/dist/alpha.d.ts:105, :157`). `EntityHeaderLayoutBlueprint`, `EntityIconLinkBlueprint`, `EntityContextMenuItemBlueprint`: **`FilterPredicate | fn` only — no string form** (`alpha.d.ts:281, :331, :303`). Only the `FilterPredicate` object form is overridable from app-config. Use `{ kind: 'bruno' }` everywhere for uniformity.

**F5 — a custom header layout replaces the whole header, including the context menu.** `pages.esm.js:157-168` maps `headerLayouts`, sorts filtered-before-unfiltered, and `:200` picks the first whose filter matches; `EntityLayoutBui.esm.js:110-116` renders `HeaderComponent` **instead of** `EntityHeaderBui`, and `EntityHeaderLayoutProps` is only `{tabs, activeTabId}` (`alpha.d.ts:262-276`) — `contextMenuItems` is not passed through. `EntityContextMenu` is **not** exported from `@backstage/plugin-catalog` (see the export list at `plugin-catalog/dist/index.d.ts:872`). Consequence: a Bruno header layout must rebuild the star + overflow menu from public parts. `FavoriteEntity`, `InspectEntityDialog` (`plugin-catalog-react/dist/index.d.ts:644-650`) and `UnregisterEntityDialog` (`:653-660`) **are** public.

**F6 — the default header carries no version and no source url.** `EntityHeaderBui.esm.js:64-101` builds metadata from `spec.lifecycle`, `RELATION_OWNED_BY`, `RELATION_PART_OF` only; `:123-139` renders `Header` with `tags=[kind, spec.type]` and `customActions=[FavoriteEntityButton, EntityContextMenu]`. There is no plugin-facing slot for extra metadata rows.

**F7 — `@backstage/ui` `Header` accepts everything the PRD title area needs.** `node_modules/@backstage/ui/dist/index.d.ts:1716-1738`: `{title?, customActions?, tabs?, activeTabId?, description?, tags?, metadata?, sticky?}` where `HeaderMetadataItem = {label, value: ReactNode}` (`:1687-1690`) and `HeaderNavTabItem` (`:1672`) is structurally identical to `EntityHeaderLayoutProps['tabs']`. `@backstage/ui@0.17.0` is already an app dependency.

**F8 — the API index page is the dashboard template.** `plugin-api-docs/dist/components/ApiExplorerPage/DefaultApiExplorerPage.esm.js:23-42` (`ApiExplorerPageContent`): `EntityListProvider pagination` → `CatalogFilterLayout` → `.Filters` [`EntityKindPicker initialFilter="api" hidden`, `EntityTypePicker`, `UserListPicker`, `EntityOwnerPicker`, `EntityLifecyclePicker`, `EntityTagPicker`] → `.Content` [`CatalogTable columns actions`]. The **new-frontend-system** variant is `NfsApiExplorerPage` (`:94-133`) — it uses `HeaderPage` + `Content` and **no `PageWithHeader`**, because `PageBlueprint` already supplies the page header (`plugin-api-docs/dist/alpha.esm.js:31-54`).

**F9 — `EntityKindPicker` applies its filter unconditionally.** `plugin-catalog-react/dist/components/EntityKindPicker/EntityKindPicker.esm.js:48-52` calls `updateFilters({kind: new EntityKindFilter(selectedKind, label)})` regardless of whether the kind exists; `hidden` only suppresses the `Select` (`:62`). A `?filters[kind]=` query param overrides `initialFilter` (`:36-40`) — acceptable, it is the native deep-link behaviour.

**F10 — `DefaultFilters` cannot hide the kind picker.** `DefaultFiltersProps = {initialKind?, initiallySelectedFilter?, ownerPickerMode?, initiallySelectedNamespaces?}` (`plugin-catalog-react/dist/index.d.ts:~866`). No `hidden` pass-through → inline the picker list. `FilterContainer`, `EntityListContainer`, `CatalogKindHeader` are deprecated; use `CatalogFilterLayout.*`.

**F11 — one facet request serves all three stat tiles.** `DefaultEntitiesCatalog.facets` (`plugin-catalog-backend/dist/service/DefaultEntitiesCatalog.cjs.js:505-538`) is a single grouped query with an optional `filter` sub-join (`:516-529`); `AuthorizedEntitiesCatalog.facets` (`:199-218`) applies `catalogEntityReadPermission`, so counts match what the table can show. `GetEntityFacetsRequest` accepts `{facets, filter}` (`catalog-client/dist/index.d.ts:235-321`). Values >200 chars are stored as `null` and excluded (`buildEntitySearch.cjs.js:57-84`); facet keys are lowercased on both write (`:56`) and read (`DefaultEntitiesCatalog:508`).

**F12 — `catalogImportApi.submitPullRequest` can only CREATE a file at the REPO ROOT, on ONE fixed branch, on GitHub or Azure.** `plugin-catalog-import/dist/api/GitHub.esm.js`:
- `:25-26` — `branchName = getBranchName(configApi)`, `fileName = getCatalogFilename(configApi)`; `helpers.esm.js:8-13` → `catalog.import.pullRequestBranchName ?? 'backstage-integration'` and `catalog.import.entityFilename ?? 'catalog-info.yaml'`. This repo sets both at `app-config.yaml:262-264`.
- `:42-54` — `git.createRef` on that **fixed** branch name → a second concurrent import fails 422 "Reference already exists".
- `:55-69` — `repos.createOrUpdateFileContents({path: fileName, ...})` with **no `sha`** → GitHub 422 if a root `catalog-info.yaml` already exists. **It cannot update an existing file.**
- `CatalogImportClient.esm.js:116-145` — `switch (provider?.type)`: `github`, `azure`, `default: throw new Error('unimplemented!')`.
- `:102-114` — before submitting it calls `catalogApi.validateEntity(doc, 'url:<repositoryUrl>')` per YAML document, which runs the **full** catalog orchestrator (`plugin-catalog-backend/dist/service/createRouter.cjs.js:698-746`, note `:726-745` stamps `ANNOTATION_LOCATION`/`ANNOTATION_ORIGIN_LOCATION` then calls `orchestrator.process`). So the generated Bruno entity is validated by our own `BrunoKindProcessor.validateEntityKind` and *enriched* by `preProcessEntity` (a live probe fetch) before any PR is opened. Requires `catalogEntityValidatePermission`.

**F13 — `catalogImportApi` is auto-registered.** `@backstage/plugin-catalog-import@0.13.15` exposes `./alpha` as `"backstage": "@backstage/FrontendPlugin"` (package.json `exports`), and `app-config.yaml:6` sets `app.packages: all` with the package listed in `packages/app/package.json`. `useApi(catalogImportApiRef)` works with no wiring. Its `analyzeUrl` needs only `/api/catalog/analyze-location` (`CatalogImportClient.esm.js:148-176`) — no extra backend module.

**F14 — refresh gate.** `plugin-catalog/dist/components/AboutCard/AboutCard.esm.js:105-106`: `allowRefresh = ANNOTATION_LOCATION startsWith 'url:' || 'file:'`; `:100-101` `useEntityPermission(catalogEntityRefreshPermission)`. BE-P1's provider stamps `url:` deliberately, so both native Refresh and our Sync button pass.

**F15 — relations rendering.** `EntityRelationCard` (`plugin-catalog-react/dist/alpha.d.ts:472-484`) has **no per-row action slot** and is built on `@backstage/ui` `EntityDataTable`, whose `ColumnConfig.cell` must return `Cell`/`CellText`/`CellProfile` (`@backstage/ui/dist/index.d.ts:2948-2972`). `RelatedEntitiesCard` (`plugin-catalog/dist/components/RelatedEntitiesCard/RelatedEntitiesCard.esm.js:9-47`) is MUI v4 and takes free `TableColumn<T>[]`, but has **no header-action slot**. Neither fits the PRD's "table + per-row action menu + a link-a-collection control". The hook underneath both — `useRelatedEntities(entity,{type,kind})` (`plugin-catalog-react/dist/index.d.ts:1035-1043`) — is public and is what we use. There is no `EntityRelationTable` export.

**F16 — MUI v4 gotchas in this repo.** Use core-components `LinkButton` (`core-components/dist/index.d.ts:176`) for navigation; `Button component={Link}` gives TS2769. `@material-ui/icons` here has **no `Api`** — verified present: `Http`, `Sync`, `Link`, `LinkOff`, `MoreVert`, `Add`, `GetApp`, `OpenInNew`, `Launch`. Multi-line union types need a leading `=`/`|` (`@stylistic/operator-linebreak`).

**F17 — no `NavItemBlueprint` in 1.53.** `@backstage/frontend-plugin-api` exports only `AnalyticsImplementationBlueprint, ApiBlueprint, AppRootElementBlueprint, PageBlueprint, PluginHeaderActionBlueprint, PluginWrapperBlueprint, SubPageBlueprint`. Sidebar placement comes from `PageBlueprint` `title`+`icon`+`routeRef` (`PageBlueprint.esm.js:177-185`) picked up by `nav.rest({sortBy:'title'})` at `packages/app/src/modules/nav/Sidebar.tsx:40`.

**F18 — `PluginHeaderActionBlueprint` is plugin-scoped, not page-scoped.** `frontend-plugin-api/dist/blueprints/PluginHeaderActionBlueprint.esm.js:38` attaches to `api:app/plugin-header-actions`; `PageBlueprint.esm.js:86-87` resolves them by `pluginId`. `noHeader: true` short-circuits the whole header (`plugin-app/dist/extensions/components.esm.js:59-61`), so a header action never renders on our chrome-less docs page. With the dashboard as our only headered page, the scoping is safe.

**F19 — only 9 kind icons are registered.** `plugin-app/dist/packages/app-defaults/src/defaults/icons.esm.js:40-48` — api, component, domain, group, location, system, user, resource, template. `kind:bruno` is consumed only by `plugin-catalog-react/dist/components/InspectEntityDialog/components/EntityKindIcon.esm.js:26` and `AncestryPage.esm.js:95`; elsewhere we choose the icon ourselves. Register via `IconBundleBlueprint` from `@backstage/plugin-app-react` (`dist/index.d.ts:63-79`, `params: { icons: { [key]: IconComponent | IconElement } }`).

---

## 2. Extension inventory (the complete final state of `plugins/bruno/src/extensions.tsx`)

| # | Extension const | Blueprint | `name` | `params` | Attaches to | Phase |
|---|---|---|---|---|---|---|
| 1 | `brunoDashboardPage` | `PageBlueprint` | `bruno` | `path:'/bruno'`, `title:'Bruno Collections'`, `icon:<BrunoIcon fontSize="inherit"/>`, `routeRef: brunoDashboardRouteRef`, `loader → BrunoDashboardPage` | `app/routes` | UI-P2 |
| 2 | `brunoAddCollectionAction` | `PluginHeaderActionBlueprint` | `add-collection` | `loader → <AddCollectionAction/>` | `api:app/plugin-header-actions` | UI-P3 |
| 3 | `brunoEntityHeader` | `EntityHeaderLayoutBlueprint` | `header` | `filter:{kind:'bruno'}`, `loader → BrunoEntityHeader` | `page:catalog/entity` input `headerLayouts` | UI-P1 |
| 4 | `brunoDocumentationCard` | `EntityCardBlueprint` | `documentation` | `filter:{kind:'bruno'}`, `type:'content'`, `loader → <CollectionDocsCard/>` | `entity-content:catalog/overview` input `cards` | UI-P1 |
| 5 | `brunoRelatedApisCard` | `EntityCardBlueprint` | `related-apis` | `filter:{kind:'bruno'}`, `type:'content'`, `loader → <RelatedApisCard/>` | ditto | UI-P1 |
| 6 | `brunoEnvironmentsCard` | `EntityCardBlueprint` | `environments` | `filter:{kind:'bruno'}`, `type:'content'`, `loader → <EnvironmentsCard/>` | ditto | UI-P1 |
| 7 | `brunoApiDocsContent` | `EntityContentBlueprint` | `api-docs` | `path:'/api-docs'`, `title:'Bruno API Docs'`, `filter:{kind:'bruno'}`, `icon:<BrunoIcon fontSize="inherit"/>`, **no `group`**, `loader → <BrunoApiDocsContent/>` | `page:catalog/entity` input `contents` | UI-P1 |
| 8 | `brunoDocsPage` | `PageBlueprint` | `docs-page` | `path:'/bruno/docs/:namespace/:name'`, `routeRef: brunoDocsPageRouteRef`, `noHeader:true`, `loader → BrunoDocsPage` | `app/routes` | UI-P1 (re-keyed) |
| 9 | `brunoCollectionsCard` | `EntityCardBlueprint` | `collections` | `filter:{kind:'api'}`, `type:'content'`, `loader → <BrunoCollectionsCard/>` | `entity-content:catalog/overview` input `cards` | UI-P4 |
| 10 | `brunoApi` | `ApiBlueprint` | (unchanged) | unchanged | — | — |

Tabs are exactly two: stock **Overview** (`/`, F2) and **Bruno API Docs** (`/api-docs`, ungrouped so it gets its own top-level tab — the same construction the current `brunoDocsContent` uses at `plugins/bruno/src/extensions.tsx:92-102`, verified live in this repo).

**Deleted extensions:** `brunoCard` (`extensions.tsx:30-37`), `brunoCollectionTreeCard` (`:44-51`), `brunoCollectionOverviewCard` (`:58-67`), `brunoDocsContent` (`:92-102`) — all in UI-P4. `brunoPage` (`:120-130`) is rewritten, not deleted, in UI-P2.

---

## 3. Phases

Each phase is one commit, boots clean, and passes `yarn tsc` at 0 errors. Ordered by dependency: UI-P1 introduces the shared entity-model layer and the Bruno entity page (zero deletions — nothing today targets `kind: Bruno`); UI-P2 swaps the dashboard; UI-P3 adds the create flow; UI-P4 swaps the API-entity surface and performs the frontend teardown; UI-P5 performs the backend teardown.

---

### UI-P1 — Bruno entity page: header, Overview cards, Bruno API Docs tab

**Deletions: none.** The current UI does not touch `kind: Bruno`, so this phase is purely additive and can be verified in isolation.

**Ordered edit list**

**1. `plugins/bruno/package.json`** — add to `dependencies`:
```
"@backstage/plugin-catalog-common": "^1.1.10",
"@backstage/ui": "^0.17.0",
"@octokit/rest": "^19.0.3",
"yaml": "^2.9.0"
```
All four are already resolved in the workspace (`@backstage/plugin-catalog-common@1.1.10`, `@backstage/ui@0.17.0`, `@octokit/rest@19.0.13`, `yaml@2.9.0`) and `@octokit/rest` + `yaml` are already in the app bundle via `@backstage/plugin-catalog-import`'s dependencies, so bundle cost is ~0. `@backstage/catalog-model`, `@backstage/plugin-catalog-react`, `@backstage/integration-react` are already listed.

**2. NEW `packages/app/src/modules/icons/index.ts`** — the ONLY `packages/app` change in this plan.
```ts
import { IconBundleBlueprint } from '@backstage/plugin-app-react';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
```
Cleanest without adding a deep import: re-export `BrunoIcon` from the plugin entrypoint (step 3) and import it from the Bruno plugin package. Register `icons: { 'kind:bruno': BrunoIcon }` (F19), wrap in a `createFrontendModule({ pluginId: 'app', extensions: [iconBundle] })`, and add it to `features` in `packages/app/src/App.tsx:8`.

**3. `plugins/bruno/src/index.ts`** — add `export { BrunoIcon, BrunoLogo } from './components/BrunoLogo';` so step 2 needs no deep import.

**4. NEW `plugins/bruno/src/lib/brunoEntity.ts`** — the entity-model accessor layer. This is the module that **replaces `lib/annotations.ts`** (deleted in UI-P4). Pure functions, no React, no API:
```ts
export interface BrunoEntitySpec {
  type: string; owner?: string; url: string; partOf?: string[];
  definition?: string; requestCount?: number; environments?: string[];
}
export function isBrunoEntity(entity: Entity): boolean;      // kind ci-eq 'bruno'
export function brunoSpec(entity: Entity): BrunoEntitySpec;  // never throws; {} shape
export function sourceUrl(entity: Entity): string | undefined;
export function version(entity: Entity): string | undefined; // metadata.version, String()-coerced
export function partOfRefs(entity: Entity): string[];         // spec.partOf, deduped
export function environments(entity: Entity): string[];
export function requestCount(entity: Entity): number | undefined;
/** The catalog-info.yaml this entity was read from, when there is one. */
export function descriptorLocation(entity: Entity):
  | { kind: 'url'; target: string }
  | { kind: 'none'; reason: 'provider' | 'file' | 'absent' };
```
`descriptorLocation` reads `ANNOTATION_LOCATION` (`backstage.io/managed-by-location`), **not** `backstage.io/source-location`: BE-P1's processor stamps `source-location` to the *collection folder* (`plugins/bruno-backend/src/processor/BrunoKindProcessor.ts:22, :215-216`), so `getEntitySourceLocation` points at the folder, not the descriptor. Returns `{kind:'url'}` only when the location is `url:` **and** its last path segment ends `.yaml`/`.yml`; `file:` → `{kind:'none', reason:'file'}`; a `url:` folder → `{kind:'none', reason:'provider'}` (this is exactly the `bruno.collections[]` case — BE-P1 §3.H.4 stamps `url:<collection folder url>`).

**5. NEW `plugins/bruno/src/lib/unlinkPr.ts`** — composes and submits the Unlink pull request. See §4 for the full design and why `catalogImportApi` cannot be used. Exports:
```ts
export interface UnlinkPlan {
  descriptorUrl: string; repoUrl: string; owner: string; repo: string;
  path: string; branch: string; before: string; after: string;
}
export function removePartOf(yamlText: string, apiRef: string): string; // yaml parseDocument → toString(), comments preserved
export async function planUnlink(opts: {...}): Promise<UnlinkPlan>;     // getContent + removePartOf
export async function submitUnlink(plan: UnlinkPlan, token: string): Promise<{ link: string }>;
```

**6. NEW `plugins/bruno/src/components/BrunoEntity/BrunoEntityHeader.tsx`** — `(props: EntityHeaderLayoutProps) => JSX.Element`.

Renders `@backstage/ui` `Header` (F7) with:
- `title` — `useEntityPresentation(entity).primaryTitle`
- `tags` — `[{label: entity.kind}, {label: spec.type}]` (parity with `EntityHeaderBui.esm.js:127-130`)
- `metadata` — owner + `partOf` rows carried over from `EntityHeaderBui.esm.js:64-101`, **plus** `{label:'Version', value: version(entity) ?? '—'}` and `{label:'Source', value: <Link href={sourceUrl}>{shortenUrl(sourceUrl)}</Link>}` (PRD lines 75-76)
- `tabs` / `activeTabId` — passed straight through from props
- `customActions` — in order:
  1. **Fetch in Bruno** — `LinkButton to={buildBrunoDeepLink(sourceUrl)} target="_blank"`, reusing `plugins/bruno/src/lib/brunoLink.ts:30-33` verbatim (it takes a plain URL string, so `spec.url` drops straight in). Disabled with a tooltip when `spec.url` is absent.
  2. **View collection docs** — `LinkButton to={`${entityLink(entity)}/api-docs`}` where `entityLink = useEntityRefLink()` (`plugin-catalog-react/dist/index.d.ts:472`).
  3. **Sync** — `onClick` → `catalogApi.refreshEntity(stringifyEntityRef(entity))`, gated on `useEntityPermission(catalogEntityRefreshPermission)` and on `ANNOTATION_LOCATION` starting `url:`/`file:` — the same two conditions as `AboutCard.esm.js:100-106` (F14). Shows a spinner while in flight and an `alertApi` toast. **Toast wording matters (§0.3):** the refresh is queued and the collection is re-read within `bruno.cacheTtlSeconds`, so say "Sync requested — new collection content appears within a minute", not "Synced".
  4. `<FavoriteEntity entity={entity}/>` (catalog-react, public).
  5. An overflow `Menu` with **Inspect entity** (`InspectEntityDialog`) and **Unregister entity** (`UnregisterEntityDialog`) — required because a custom header layout drops the native context menu (F5).

**7. NEW `plugins/bruno/src/components/BrunoEntity/CollectionDocsCard.tsx`** — PRD line 87. `BrunoInfoCard title="Documentation"` + `MarkdownContent` fed by `brunoApi.getCollectionDocs(entityRef)` (§0.2). On 404/error falls back to `metadata.description`; renders `null` when both are empty (same "no empty card" discipline as the current `CollectionOverviewCard.tsx:18-25`).

**8. NEW `plugins/bruno/src/components/BrunoEntity/RelatedApisCard.tsx`** — PRD lines 88-89. `useRelatedEntities(entity, {type: RELATION_PART_OF, kind: 'API'})` (F15) → core-components `Table` inside `BrunoInfoCard title="Related APIs"`. Columns: **Name** (`EntityRefLink`), **Type** (`spec.type`), **Owner** (`RELATION_OWNED_BY`), **Actions** (an `Unlink` danger button). `Unlink` opens `UnlinkDialog` (step 9).

**9. NEW `plugins/bruno/src/components/BrunoEntity/UnlinkDialog.tsx`** — the shared unlink UX, reused by UI-P4's Bruno Card. Full behaviour in §4.

**10. NEW `plugins/bruno/src/components/BrunoEntity/EnvironmentsCard.tsx`** — PRD line 90. `BrunoInfoCard title="Environments"` + `Table` over `environments(entity)`. Empty state: *"No environments found in this collection."* Renders `—` with a "waiting for the next collection sync" hint when `spec.environments` is absent entirely (BE-P2 not yet landed).

**11. NEW `plugins/bruno/src/components/BrunoEntity/BrunoApiDocsContent.tsx`** — PRD lines 91-92. Rewrite of `BrunoDocsContent` keyed by entity ref. **Preserves every docs-iframe invariant** from `plugins/bruno/src/lib/docsSession.ts`: mint the limited-access cookie at `GET {bruno base}/.backstage/auth/v1/cookie` with `credentials:'include'` **before** setting `src` (`docsSession.ts:27-43`), keep the re-mint timer (`:93-111`), `sandbox="allow-scripts allow-same-origin"`, and the runtime height measurement (`BrunoDocsContent.tsx:131-149`). Also handles the `usebruno.com/definition-omitted: size` case (§0.2).

**12. `plugins/bruno/src/lib/docsSession.ts`** — re-key: `useDocsSession(entityRef: string | undefined)`, calling `brunoApi.getEntityDocsUrl(entityRef, themeMode)`. Keep the theme dependency (`:78-79`, `:136`).

**13. `plugins/bruno/src/components/BrunoDocsPage/BrunoDocsPage.tsx`** — **consolidate the duplicated cookie logic.** This file re-implements `mintDocsCookie` inline at `:31, :43-58, :207-216, :235-236` instead of using the hook. Delete the duplicate and call `useDocsSession(entityRef)`. Re-key the route to `/bruno/docs/:namespace/:name` via `useRouteRefParams(brunoDocsPageRouteRef)`. Keep both the chrome-less `?view=full` layout and the embedded layout.

**14. `plugins/bruno/src/api/BrunoApi.ts` + `BrunoClient.ts`** — **add** (do not yet remove anything):
```ts
getEntityDocsUrl(entityRef: string, theme: 'light' | 'dark'): Promise<string>;
getCollectionDocs(entityRef: string): Promise<string>;
```
Both resolve `{namespace, name}` via `parseEntityRef` and hit §0.2's routes. `getDocsUrl(id, theme)` stays until UI-P4 (its last consumer dies there).

**15. `plugins/bruno/src/extensions.tsx`** — add extensions 3–7 from §2 and re-key extension 8's `routeRef` to `createRouteRef({ params: ['namespace','name'] })`.

**16. `plugins/bruno/src/plugin.ts`** — extend the `extensions` array; update the doc comment.

**Consumers / call sites touched:** `plugins/bruno/src/extensions.tsx`, `plugin.ts`, `index.ts`, `api/BrunoApi.ts`, `api/BrunoClient.ts`, `lib/docsSession.ts`, `components/BrunoDocsPage/BrunoDocsPage.tsx`, `packages/app/src/App.tsx`, `packages/app/src/modules/icons/index.ts` (new). `BrunoDocsContent` still imports the (now re-keyed) `useDocsSession` — **update its call site in the same commit** or `yarn tsc` fails; it is deleted in UI-P4.

**Verification**
```
yarn tsc
yarn lint:bruno plugins/bruno/src/lib/brunoEntity.ts plugins/bruno/src/lib/unlinkPr.ts \
  plugins/bruno/src/lib/docsSession.ts plugins/bruno/src/components/BrunoEntity \
  plugins/bruno/src/components/BrunoDocsPage/BrunoDocsPage.tsx \
  plugins/bruno/src/extensions.tsx plugins/bruno/src/plugin.ts plugins/bruno/src/index.ts \
  packages/app/src/modules/icons/index.ts packages/app/src/App.tsx
yarn prettier:check
```
Live boot — `yarn start`, then at `/catalog/default/bruno/my-bruno-collection`:
1. **Exactly two tabs**: `Overview` and `Bruno API Docs`. No third.
2. Header shows title, `Bruno` + `bruno-collection` tags, `Owner`, `Part of`, **`Version`**, **`Source`**, and four controls: Fetch in Bruno, View collection docs, Sync, star + overflow.
3. **Sync** → a `POST /api/catalog/refresh` in the network tab, a success toast, no console error. Proves F14's gate passes for a `url:`-located Bruno entity.
4. Overflow → **Inspect entity** opens the dialog (proves F5's rebuild works).
5. **Fetch in Bruno** opens the fetch URL with the collection URL encoded as the `url` query param.
6. Overview shows the About card (stock) plus Documentation, Related APIs, Environments. **Related APIs lists `github-rest-api`** — proves BE-P1's `partOf` relation reaches the UI.
7. Every other kind is untouched: `/catalog/default/api/github-rest-api` still shows the stock header with the native context menu.
8. Before BE-P2: Documentation falls back to the description, Environments shows the waiting hint, the docs tab shows its error state — and nothing crashes.

---

### UI-P2 — Bruno Collections dashboard

**Ordered edit list**

**1. `plugins/bruno/package.json`** — add `"@backstage/plugin-catalog": "^2.0.7"` (for `CatalogTable`).

**2. NEW `plugins/bruno/src/components/BrunoDashboard/columns.tsx`** — `TableColumn<CatalogTableRow>[]`. `CatalogTableRow = {entity, resolved:{name, entityRef, ...}}` (`plugin-catalog/dist/types/DefaultCatalogPage.d-BuCpeSQx.d.ts:9-19`). Columns:
`CatalogTable.columns.createTitleColumn({hidden:true})`, `createNameColumn({defaultKind:'Bruno'})`, then custom **Version** (`version(row.entity)`), **Source** (`<Link to={sourceUrl}>`), **Requests** (`requestCount(row.entity) ?? '—'`), **Environments** (count), then `createOwnerColumn()`, `createMetadataDescriptionColumn()`, `createTagsColumn()`.

**3. NEW `plugins/bruno/src/components/BrunoDashboard/useBrunoStats.ts`** — **the answer to "where do the three numbers come from".**
```ts
const { facets } = await catalogApi.getEntityFacets({
  filter: { kind: 'bruno' },
  facets: ['kind', 'spec.requestCount', 'spec.environments'],
});
collections   = sum(facets.kind, f => f.count);
totalRequests = sum(facets['spec.requestCount'], f => Number(f.value) * f.count);
environments  = facets['spec.environments'].length;
```
- **Collections** is native (`kind` facet, filtered).
- **Requests** and **unique environments** come from the `spec.requestCount` / `spec.environments` fields §0.1 requires BE-P2 to stamp. F11 is the proof that this is a *single* grouped SQL query whose cost is independent of the number of Bruno entities and of the table's page size, and that it is permission-filtered identically to the table. **Do not** compute these by iterating `useEntityList().entities` — that is page-scoped under `pagination` (F8) and would silently undercount, and it is one N-row client walk per keystroke of any filter.
- Degrade: a missing facet key yields `[]` → the tile renders `—`.
- Caveat to encode as a comment: an environment name longer than 200 chars is dropped from the index (`buildEntitySearch.cjs.js:57-84`) and will not be counted.

**4. NEW `plugins/bruno/src/components/BrunoDashboard/BrunoStatTiles.tsx`** — three `BrunoInfoCard variant="fullHeight"` tiles labelled **Collections**, **Requests**, **Unique environments**. Lift the tile markup from the deleted `BrunoPage/StatTiles.tsx:23-52` (the `useBrandStyles().accentFigure` treatment) and re-point it at `useBrunoStats`.

**5. NEW `plugins/bruno/src/components/BrunoDashboard/BrunoDashboardPage.tsx`** — modelled on `NfsApiExplorerPage` (F8), content-only because `PageBlueprint` supplies the header (F17/F18):
```tsx
<Content>
  <BrunoStatTiles />
  <EntityListProvider pagination>
    <CatalogFilterLayout>
      <CatalogFilterLayout.Filters>
        <EntityKindPicker initialFilter="bruno" hidden />
        <UserListPicker />
        <EntityOwnerPicker />
        <EntityTagPicker />
      </CatalogFilterLayout.Filters>
      <CatalogFilterLayout.Content>
        <CatalogTable columns={brunoColumns} />
      </CatalogFilterLayout.Content>
    </CatalogFilterLayout>
  </EntityListProvider>
</Content>
```
`EntityTypePicker` and `EntityLifecyclePicker` are **dropped**: every Bruno entity has `spec.type: 'bruno-collection'` (a one-option filter is noise) and BE-P1 deliberately removed `spec.lifecycle` from the kind schema (BE-P1 §3.F.2). The picker list is inlined rather than using `DefaultFilters` (F10).

**6. `plugins/bruno/src/components/BrunoDashboard/index.ts`** — barrel.

**7. `plugins/bruno/src/extensions.tsx`** — rewrite `brunoPage` → `brunoDashboardPage`: `title: 'Bruno Collections'` (PRD line 63; this is also the sidebar label, F17), loader → `BrunoDashboardPage`.

**8. `plugins/bruno/src/plugin.ts`** — rename in the array + doc comment.

**DELETED (all superseded by the CatalogTable dashboard, all deleted in this same commit so nothing dangles):**
- `plugins/bruno/src/components/BrunoPage/BrunoPage.tsx` — replaced by `BrunoDashboardPage`.
- `.../BrunoPage/CollectionsTab.tsx`, `CollectionCard.tsx`, `CollectionGrid.tsx` — the bespoke card grid over `GET /dashboard`; replaced by `CatalogTable` over the catalog.
- `.../BrunoPage/StatTiles.tsx` — replaced by `BrunoStatTiles` (its markup is carried over).
- `.../BrunoPage/FailuresStrip.tsx` — its only data source is `Dashboard.failures` from the deleted `/dashboard` route; ingestion failures now surface as catalog processing errors on the entity (`EntityProcessingErrorsPanel`, rendered by `DefaultEntityContentLayout.esm.js:132`).
- `.../BrunoPage/LinkApi/` (`LinkApiTab.tsx`, `ApiList.tsx`, `LinkPanel.tsx`, `index.ts`) — the entire annotation-linking tab; the relation now lives in `spec.partOf`.
- `.../BrunoPage/AddCollectionModal/` — the legacy scan-and-import modal. **Its replacement lands in UI-P3, one commit later.** Between UI-P2 and UI-P3 the dashboard has no add button. This is deliberate: keeping the old modal alive but unreferenced would be dead code, and re-pointing it would mean writing UI-P3's flow inside UI-P2.
- `.../BrunoPage/index.ts`.

**Retained on purpose:** `components/CollectionPicker/**` (still imported by `BrunoCard.tsx:24`), `lib/annotations.ts`, `lib/connectionEvents.ts`, `lib/linkErrors.ts` — all die in UI-P4 with their last consumer.

**Verification**
```
yarn tsc
yarn lint:bruno plugins/bruno/src/components/BrunoDashboard plugins/bruno/src/extensions.tsx plugins/bruno/src/plugin.ts
yarn prettier:check
grep -rn "BrunoPage\|CollectionsTab\|CollectionCard\|LinkApiTab\|AddCollectionModal\|FailuresStrip" plugins/bruno/src   # must return nothing
```
Live boot:
1. Sidebar shows **Bruno Collections** with the Bruno mark.
2. `/bruno` lists exactly the `kind: Bruno` entities; the `github-rest-api` API entity does **not** appear (proves `initialFilter="bruno"` bound).
3. The Kind picker is **not** visible; Owner / Tags / personal filters are.
4. Network: exactly **one** `entity-facets` request on load, not one per row.
5. Tiles read the real collection count; Requests and Unique environments read real numbers once BE-P2 stamps them, `—` before that. The page does not error either way.
6. Clicking a row navigates to `/catalog/default/bruno/<name>` and lands on UI-P1's page.
7. `/bruno/docs/default/my-bruno-collection?view=full` still renders chrome-less.

---

### UI-P3 — Adding a Bruno Collection via the UI

PRD lines 111-123. Two modals, one PR.

**Ordered edit list**

**1. `plugins/bruno-backend/src/service/router.ts`** — NEW route, inserted **before** the existing `/collections/:id` routes to keep literal-before-param ordering:
```
POST /collections/probe   body { url: string }
  → 200 { found: true,  format, manifestPath, name?, version?, description? }
  → 200 { found: false, reason: 'no-manifest' }
  → 400 { found: false, reason: 'unreadable', message }
```
Implementation is three lines over BE-P1's existing seam: `await probe.probe(url)` → `undefined` means `no-manifest`, a throw means `unreadable`. Gated `await httpAuth.credentials(req, { allow: ['user'] })`. **Never** accepts or logs a user token — it reuses the server-side `UrlReaderService` exactly as BE-P1 §3.D.1 mandates.

**2. `plugins/bruno-backend/src/plugin.ts`** — construct the probe once (`createManifestProbe({config, reader, logger, ...})`, mirroring `module.ts:65`) and pass it to `createRouter`. **No new auth policy** — the route falls through the default credentials barrier.

*Scope note:* this is neither OpenCollection generation nor Entity Sync, so it does not collide with BE-P2. It is the minimum backend surface the PRD's "scan the link to find a bruno.json/opencollection.yaml" requires: `catalogImportApi.analyzeUrl` looks for `catalog-info.yaml`, not Bruno manifests (`CatalogImportClient.esm.js:22-84`), and a browser cannot read a private repo.

**3. `plugins/bruno/src/api/BrunoApi.ts` + `BrunoClient.ts`** — add `probeCollection(url): Promise<ProbeResult>`; add `ProbeResult` to `api/types.ts`.

**4. NEW `plugins/bruno/src/components/AddCollection/AddCollectionDialog.tsx`** — modal 1, `maxWidth="md" fullWidth` (PRD: "large size modal"). Fields:
- **Git URL** — `TextField`, validated client-side by the existing `validateScmRepoUrl` (`plugins/bruno/src/lib/scmProviders.ts:75-99`), then debounced `probeCollection`. `found:false` → inline error *"No `bruno.json` or `opencollection.yaml` found at this URL."*; `unreadable` → the backend message classified through `plugins/bruno/src/lib/linkErrors.ts`. Submit stays disabled until `found:true`.
- **Entity name** — prefilled from the probed manifest name, sanitised. **Required**, with an inline note: *the catalog validates `metadata.name` before any processor runs, so it cannot be derived later* (BE-P1 F1).
- **Related APIs** — `CatalogAutocomplete<Entity, true>` with `multiple` (`plugin-catalog-react/dist/index.d.ts:298-306`), options from `catalogApi.getEntities({filter:{kind:'API'}, fields:['kind','metadata.name','metadata.namespace','metadata.title']})`, `getOptionLabel` via `useEntityPresentation`. **Not** `EntityPickerFieldExtension` (an RJSF scaffolder field, not standalone) and **not** `EntityAutocompletePicker` (bound to `EntityListProvider` filter state, not a form value).
- **Owner** — optional `CatalogAutocomplete` over `kind: Group`.
- **Submit**.

**5. NEW `plugins/bruno/src/components/AddCollection/generateCatalogInfo.ts`** — builds the entity and serialises it:
```ts
export function buildBrunoEntity(input): Entity;   // apiVersion 'usebruno.com/v1alpha1', kind 'Bruno',
                                                   // metadata.name, spec.{type:'bruno-collection',url,owner?,partOf}
export function toCatalogInfoYaml(entity: Entity): string;  // `yaml` stringify + a leading comment block
```

**6. NEW `plugins/bruno/src/components/AddCollection/GeneratedYamlDialog.tsx`** — modal 2, opened as modal 1 closes (PRD line 123). Contents:
- The generated `catalog-info.yaml` via `PreviewCatalogInfoComponent` (`plugin-catalog-import/dist/index.d.ts:395-408`, `{repositoryUrl, entities}`).
- **Download** — there is **no** native download control in `plugin-catalog-import`; implement a plain client-side download: `new Blob([yaml], {type:'text/yaml'})` → `URL.createObjectURL` → a synthetic `<a download="catalog-info.yaml">` click → `revokeObjectURL`.
- **Copy** — `CopyTextButton`.
- **Create a pull request** — `catalogImportApi.submitPullRequest({repositoryUrl: repoRootFromCollectionUrl(url), fileContent, title, body})` with title/body seeded from `preparePullRequest?.()` and editable. On success show the returned `link`.

**7. The four `catalogImportApi` limits, surfaced not hidden** (F12). Render them as a persistent `WarningPanel` **above** the PR button, not as a post-hoc error:
- *"The pull request adds `catalog-info.yaml` at the **repository root**, not in the collection folder."* — `GitHub.esm.js:58` uses `path: getCatalogFilename(config)`.
- *"If the repository already has a root `catalog-info.yaml`, the pull request will fail — download the file and add it by hand instead."* — `GitHub.esm.js:55-69` calls `createOrUpdateFileContents` with no `sha`.
- *"Only GitHub and Azure DevOps are supported."* — `CatalogImportClient.esm.js:143`. Detect with `scmIntegrationsApi.byUrl(repoUrl)?.type` and **pre-disable** the PR button for GitLab/Bitbucket, leaving Download enabled.
- *"Every Bruno import uses the branch `backstage-integration`; one open import at a time."* — `helpers.esm.js:11-13`, fixed name.

Also note in the dialog copy that `submitPullRequest` validates the entity against the live catalog first (F12), so a probe failure surfaces here too.

**8. NEW `plugins/bruno/src/components/AddCollection/AddCollectionAction.tsx`** — the `Add Bruno Collection` button, plus deep-link handling: `useSearchParams()`; `?add=1` auto-opens modal 1 and `&partOf=<entityRef>` preselects that API in the multiselect. This is the target UI-P4's "Add a new Bruno Collection" button routes to (PRD lines 108-109).

**9. `plugins/bruno/src/extensions.tsx` + `plugin.ts`** — register `brunoAddCollectionAction` via `PluginHeaderActionBlueprint` (F18: plugin-scoped, and our only other page sets `noHeader`, so it renders on `/bruno` alone).

**Deletions: none.**

**Verification**
```
yarn tsc
yarn lint:bruno plugins/bruno/src/components/AddCollection plugins/bruno/src/api \
  plugins/bruno-backend/src/service/router.ts plugins/bruno-backend/src/plugin.ts
yarn prettier:check
```
Live boot:
1. `/bruno` header shows **Add Bruno Collection** next to the page title.
2. Paste the sample collection URL → the field validates green and the manifest name prefills.
3. Paste a repo with no Bruno manifest → the "No `bruno.json` or `opencollection.yaml` found" error; Submit stays disabled.
4. Select `github-rest-api` in the multiselect, submit → modal 1 closes, modal 2 opens with a `kind: Bruno` YAML carrying `spec.partOf: ['api:default/github-rest-api']`.
5. Download writes `catalog-info.yaml`; the content matches the preview byte-for-byte.
6. The four limits are visible **before** clicking Create pull request.
7. Point at a GitLab URL → the PR button is disabled with the "GitHub and Azure DevOps only" reason; Download still works.
8. `/bruno?add=1&partOf=api:default/github-rest-api` opens modal 1 with that API preselected.
9. Grep the boot log for `$GITHUB_TOKEN` → zero hits.

---

### UI-P4 — Bruno Card on API entity pages, and the frontend teardown

**Ordered edit list**

**1. NEW `plugins/bruno/src/components/BrunoCollectionsCard/BrunoCollectionsCard.tsx`** — PRD lines 94-109.
`useRelatedEntities(entity, { type: RELATION_HAS_PART, kind: 'Bruno' })` → core-components `Table` inside `BrunoInfoCard title="Bruno Collections"` with `action={<LinkCollectionButton/>}` (`BrunoInfoCard` already forwards `action`, `BrunoInfoCard.tsx:44, :74`).

**`RELATION_HAS_PART` is correct and load-bearing:** BE-P1's processor emits **both** directions explicitly (`BrunoKindProcessor.ts:348-361`) — `partOf` Bruno→API and `hasPart` API→Bruno — because the catalog does not derive the reverse edge.

Columns (PRD lines 101-105): **Name** → `EntityRefLink` to the Bruno entity · **Version** → `version(e)` · **Source url** → `<Link>` to `sourceUrl(e)` · **Actions** → `IconButton MoreVert` opening a `Menu`:
- **Fetch in Bruno** → `buildBrunoDeepLink(sourceUrl(e))` in a new tab.
- **View Collection Docs** → `${entityLink(e)}/api-docs`.
- **Unlink** (`className={danger}`) → `UnlinkDialog` from UI-P1, with `apiRef = stringifyEntityRef(apiEntity)` and `collection = brunoEntity`.

**2. NEW `plugins/bruno/src/components/BrunoCollectionsCard/LinkCollectionDialog.tsx`** — PRD lines 107-109. Two options:
- **Link an existing Bruno collection** — `CatalogAutocomplete<Entity>` over `catalogApi.getEntities({filter:{kind:'Bruno'}})`, minus the ones already related. Confirming produces a **PR that ADDS this API ref to `spec.partOf`** — the exact inverse of Unlink, reusing `lib/unlinkPr.ts` with an `addPartOf` sibling of `removePartOf`. Same asynchronous UX and the same `{kind:'none'}` guard (§4).
- **Add a new Bruno Collection** — `LinkButton` to `/bruno?add=1&partOf=<this api ref>` (UI-P3 step 8).

**3. `plugins/bruno/src/lib/unlinkPr.ts`** — add `export function addPartOf(yamlText: string, apiRef: string): string;` and generalise `planUnlink` → `planPartOfEdit({ mode: 'add' | 'remove' })`. Rename the module to `partOfPr.ts` in this commit and update UI-P1's two import sites.

**4. `plugins/bruno/src/extensions.tsx`** — add `brunoCollectionsCard` (extension 9, `filter:{kind:'api'}`, `type:'content'`); **delete** `brunoCard` (`:30-37`), `brunoCollectionTreeCard` (`:44-51`), `brunoCollectionOverviewCard` (`:58-67`), `brunoDocsContent` (`:92-102`) and their now-unused `isApiEntity` predicate (`:20-21`).

**5. `plugins/bruno/src/plugin.ts`** — update the array and the doc comment (which still describes `usebruno.com/collection-id`, `:22-33`).

**DELETED — the annotation architecture, frontend half.** Safe now because every consumer is removed in this same commit:

| Path | Why safe to delete now |
|---|---|
| `components/BrunoCard/` (`BrunoCard.tsx`, `index.ts`) | Replaced by `BrunoCollectionsCard`. Its `userOwnsLink` provenance gate (`:79`) has no meaning in a relation model. |
| `components/BrunoDocsContent/` | Replaced by UI-P1's `BrunoApiDocsContent` on the Bruno entity + the row action "View Collection Docs". |
| `components/CollectionTree/` | The `CompactTree` was the only reader of `NormalizedCollection.items`; the OpenCollection docs iframe supersedes it. |
| `components/CollectionOverview/` | Replaced by UI-P1's `CollectionDocsCard`. |
| `components/CollectionPicker/` (all 3 files) | Last importers (`BrunoCard.tsx:24`, `LinkApi/LinkPanel.tsx:11-13`) both gone — the latter in UI-P2. |
| `lib/annotations.ts` | Last importers were `BrunoDocsContent:11`, `CollectionTreeCard:19`, `CollectionOverviewCard:8`, `BrunoCard:18`, `LinkApi/LinkApiTab:8` (UI-P2). Replaced by `lib/brunoEntity.ts`. |
| `lib/connectionEvents.ts` | Last importers were `useCollectionPicker:5`, `BrunoDocsContent:12`, `CollectionTreeCard:20`, `CollectionOverviewCard:9`, `BrunoCard:19` (+ `CollectionCard:14`, `LinkPanel:16` in UI-P2). Catalog relations refresh through the catalog, not an in-memory bus. |
| `lib/linkErrors.ts` | Last importer was `useCollectionPicker`. **Keep** if UI-P3's probe error classifier still uses it — decide at implementation time; if it does, it stays and this row is void. |

**RETAINED (entity-model-agnostic, all still used):** `theme/brand.ts`, `theme/brandStyles.ts`, `BrunoInfoCard`, `BrunoLogo`/`BrunoIcon`, `MethodBadge`, `lib/scmProviders.ts`, `lib/scmUrl.ts`, `lib/useScmToken.ts`, `lib/brunoLink.ts`, `lib/docsSession.ts`, `OpenInBruno`, `components/BrunoDocsPage`.

**6. `plugins/bruno/src/api/BrunoApi.ts`, `BrunoClient.ts`, `api/types.ts`** — prune to the surviving surface. **Remove:** `connect`, `discover`, `getConnection`, `disconnect`, `sync`, `getCollections`, `getCollection`, `getDashboard`, `importCollections`, `getImportedCollections`, `deleteImportedCollection`, `getDocsUrl`, `getOpenCollectionYaml(id)`; and the types `ConnectResult`, `DiscoverResult`, `DiscoveredCollection`, `ConnectionRecord`, `Dashboard`, `DashboardStats`, `DashboardCollection`, `ImportedCollection`, `SourceFailure`, `CollectionSummary`, `CollectionDetail`, `NormalizedCollection`, `Item`/`FolderItem`/`RequestItem` and their guards. **Keep:** `getEntityDocsUrl`, `getCollectionDocs`, `probeCollection`, and `Environment`/`EnvVariable` if the environments card reads them. `plugins/bruno/src/index.ts:14` `export * from './api/types'` narrows automatically.

**Verification**
```
yarn tsc
yarn lint:bruno plugins/bruno/src
yarn prettier:check
grep -rn "usebruno.com/collection-id\|usebruno.com/source-url\|getConnection\|emitConnectionChange\|isProviderManaged" plugins/bruno/src   # must return nothing
```
Live boot, at `/catalog/default/api/github-rest-api`:
1. Exactly **one** Bruno card, titled **Bruno Collections**, listing `my-bruno-collection` with Version, Source url and a `⋮` menu.
2. The API entity has **no** `Bruno` tab any more (the docs live on the Bruno entity).
3. `⋮` → Fetch in Bruno opens the fetch URL; View Collection Docs lands on `/catalog/default/bruno/my-bruno-collection/api-docs`.
4. `⋮` → **Unlink** opens the dialog with the correct preflight (see §4's checklist).
5. **Link a collection** → the picker excludes already-related collections; "Add a new Bruno Collection" navigates to `/bruno?add=1&partOf=api:default/github-rest-api` with the API preselected.
6. `/api/bruno/health` still 200 and the old routes still respond — nothing backend-side has moved yet.

---

### UI-P5 — Backend teardown of the annotation architecture

Runs last because it removes what UI-P4 stopped calling.

**DELETE**
- `plugins/bruno-backend/src/processor/BrunoLinkProcessor.ts` and its registration at `plugins/bruno-backend/src/module.ts:81` (+ the `discovery`/`auth` deps at `module.ts:39-40` if nothing else uses them).
- `plugins/bruno-backend/src/store/connectionStore.ts`, `store/collectionsStore.ts`, and their construction at `plugin.ts:48-49` and pass-through at `:69-70`.
- `plugins/bruno-backend/src/provider/BrunoEntityProvider.ts` and its registration at `module.ts:53-60`; the `bruno.sources` block in `plugins/bruno-backend/config.d.ts` and at `app-config.yaml:149-156`; `readBrunoSources`; `BrunoSourceConfig` in `types.ts` and its re-export at `index.ts:38`.
- `plugins/bruno-backend/src/service/router.ts` routes: `/collections` (`:68`), `/collections/import` (`:73`), `/collections/imported` (`:102`), `/collections/imported/:id` (`:116`), `/dashboard` (`:203`), `/connections` (`:210`), `/connections/discover` (`:238`), `/connections` GET (`:254`), `/connections/:entityRef` (`:268`), `/connections/:entityRef` DELETE (`:286`), `/refresh` (`:298`).
- `plugins/bruno-backend/src/index.ts` — the corresponding type re-exports (`:41-49` etc.).

**KEEP** — `/health`, `/collections/probe` (UI-P3), the OpenCollection docs routes, and everything BE-P2 owns.

**Boundary note — `collectionService.ts` is NOT this plan's to delete.** BE-P2 extracts the parser into `collectionParser.ts`, which is permanent. What remains of `collectionService.ts` is the substrate of `openCollectionExport.ts` / `generateOcDocsHtml.ts` / the docs route. UI-P5 removes only the connection/import/link surface.

**Verification**
```
yarn tsc
yarn lint:bruno plugins/bruno-backend/src
yarn prettier:check
grep -rn "connectionStore\|collectionsStore\|BrunoLinkProcessor\|BrunoEntityProvider\|bruno.sources" plugins packages app-config.yaml   # only the intended survivors
```
Live boot:
1. Backend starts with no unhandled rejection and no `No processor recognized the entity`.
2. `GET /api/bruno/health` → 200.
3. `POST /api/bruno/collections/probe` → still works.
4. `GET /api/bruno/dashboard` → **404** (proves the route is gone) and nothing in the UI breaks.
5. The catalog still holds the `kind: Bruno` entity with `partOf`/`ownedBy`/`hasPart` relations intact.
6. `/bruno` and both entity pages render exactly as after UI-P4.

---

## 4. The Unlink pull request — composition, submission, and the wait

**The locked constraint:** Unlink edits `spec.partOf` in the collection's `catalog-info.yaml` via a PR. It is **not** a runtime relation delete — catalog relations are derived by processors and rewritten on every stitch (BE-P1 R7); there is no relation-mutation endpoint. It is **not** a side store. Source control stays the single source of truth.

### 4.1 Why not `catalogImportApi.submitPullRequest`

The locked decision scopes `catalogImportApi` to the **add** step only, and F12 proves it cannot serve Unlink even if we wanted it to:
- it writes to `getCatalogFilename(config)` at the **repo root**, not at the descriptor's actual path;
- it calls `createOrUpdateFileContents` with **no `sha`**, so it cannot update an existing file (GitHub 422);
- it uses a single **fixed** branch name, so a second unlink collides.

### 4.2 What we do instead

`plugins/bruno/src/lib/partOfPr.ts`, client-side, using the same credential path Backstage's own importer uses (`scmAuthApi.getCredentials({url, additionalScope:{repoWrite:true}})`, cf. `plugin-catalog-import/dist/api/GitHub.esm.js:15-20`) so the PR is authored by the **actual user** — correct attribution, correct audit trail, no server-side write credential.

1. **Resolve the descriptor** — `descriptorLocation(entity)` (UI-P1 step 4). `{kind:'url'}` → proceed.
2. **Read it** — `octokit.repos.getContent({owner, repo, path, ref: defaultBranch})` → text + `sha`.
3. **Edit it** — `removePartOf(text, apiRef)` using `yaml`'s `parseDocument` / `doc.toString()`, which **preserves comments and formatting**. Removes the matching `spec.partOf` item by normalised entity ref (`parseEntityRef(item, {defaultKind:'API', defaultNamespace: entity ns})` compared against the target), and drops the `partOf` key entirely when the sequence empties. Throws a typed error when the ref is not present (already unlinked upstream).
4. **Branch** — `refs/heads/bruno-unlink-<collectionName>-<8 hex>`, unique per attempt. Created from the repo's default branch (`repos.get().data.default_branch`).
5. **Commit** — `createOrUpdateFileContents({path, sha, branch, content: Base64.encode(after)})` — **with `sha`**, so it is an update.
6. **PR** — `pulls.create({title: 'Unlink <api> from Bruno collection <name>', body, head: branch, base: defaultBranch})` → `html_url`.

Token handling: `getCredentials` is the **first await** of the click handler (the gesture rule documented at `plugins/bruno/src/lib/useScmToken.ts:39-42`), the token is held in a local `const`, passed to one `new Octokit({auth})`, and **never** logged, stored, or put in a URL.

### 4.3 The dialog — between click and merge

`UnlinkDialog` states:

- **preflight** — a short explanation: *"Catalog relations are generated from source control. Unlinking opens a pull request that removes `api:default/github-rest-api` from `spec.partOf` in `catalog-info.yaml`. The relation disappears once that pull request is merged and Backstage re-reads the file."* Plus the descriptor path and repo, so there is no ambiguity about which file changes.
- **blocked / provider** — when `descriptorLocation` returns `{kind:'none', reason:'provider'}`, i.e. a `bruno.collections[]`-sourced entity: **the button is disabled** and the dialog says: *"This collection is defined by `bruno.collections[]` in your Backstage `app-config.yaml`, not by a `catalog-info.yaml`. There is no descriptor file to edit. Remove `api:default/github-rest-api` from that entry's `partOf` list and restart Backstage."* — with the config path and the entry's `url` shown verbatim so the operator can find it. This is the direct consequence of BE-P1 §3.H.4, which stamps `backstage.io/managed-by-location: url:<collection folder>`.
- **blocked / file** — `{kind:'none', reason:'file'}` (e.g. this repo's `examples/bruno-entity.yaml` via `app-config.yaml:279-280`): *"This entity is registered from a local file location. Edit `<target>` directly."*
- **blocked / provider-not-github** — `scmIntegrationsApi.byUrl(descriptorUrl)?.type !== 'github'`: *"Automatic pull requests are supported on GitHub only. Copy the updated file below and apply it yourself."* — with the edited YAML and a Copy button, so the flow still completes manually.
- **preview** — a two-pane before/after of the `spec.partOf` block, so the user sees exactly what the PR changes.
- **submitting** — the button spins and is disabled; the dialog is not dismissable (a half-created branch is confusing).
- **submitted** — a persistent success panel: *"Pull request opened. The `github-rest-api` relation stays visible here until it is merged and Backstage re-reads the collection."* + the PR link + Copy link. The Related APIs / Bruno Collections row then shows an **"Unlink PR open"** chip with the same link.
- **the chip's lifetime is honest.** It is React state for the session only — persisting it would be the side store the locked decision forbids. State that in the code comment: after a reload the chip is gone and the PR lives in the SCM host.

**Add is symmetric.** `addPartOf` appends the ref (idempotent), and `LinkCollectionDialog` reuses all six states with "link" wording. Same blocked cases, same asynchrony.

---

## 5. Alternatives considered and rejected

1. **Keep the default entity header and put version / source url / actions in a right-column card**, with the two link actions as `EntityIconLinkBlueprint` entries. **Cheaper and preserves the native context menu and star for free** (F5's cost disappears). Rejected because `EntityIconLinkBlueprint` renders into the About **card**'s subheader (`entityCards.esm.js:8-33`, `attachTo: entity-card:catalog/about`), not the title area, and the PRD (lines 73-80) says the **title** must carry version, source url and the action buttons. Recorded as the fallback if the rebuilt overflow menu proves fragile.
2. **`EntityHeaderBlueprint`** instead of `EntityHeaderLayoutBlueprint`. Rejected: it is `@deprecated` (`alpha.d.ts:235`) and taking it forces the **whole app** onto the legacy `EntityLayout` path (`pages.esm.js:200-202` selects `EntityLayoutBui` only when `HeaderComponent || !legacyHeader`), changing every other kind's page.
3. **`EntityRelationCard`** for the related-APIs and Bruno-collections tables. Rejected: no per-row action slot and no header-action slot (F15), and its `ColumnConfig.cell` must return a `@backstage/ui` `Cell` component, which is a second design system inside MUI v4 cards.
4. **`RelatedEntitiesCard`** for the Bruno Card. Rejected: correct column type but **no header-action slot** (`RelatedEntitiesCard.esm.js:33-46` renders `EntityTable` with no `action`), and the PRD requires a "link a new collection" control on the card.
5. **Computing the request / environment tiles from `useEntityList().entities`.** Rejected: page-scoped under `pagination` (F8) so it undercounts silently, and it re-walks every row on every filter keystroke. The facet query (F11) is one grouped SQL statement, page-independent and permission-consistent.
6. **Storing the counts as annotations** rather than `spec` fields. Rejected: a comma-joined annotation value groups as one opaque facet row, so *unique* environments cannot be counted. (Facet keys with dots *do* work — `buildEntitySearch.cjs.js:46-48` concatenates — so this is a shape problem, not a mechanism problem.)
7. **`catalogImportApi.submitPullRequest` for Unlink.** Rejected on three independent grounds; see §4.1.
8. **A backend Unlink route using `integrations` service credentials.** Rejected: the PR would be authored by the service account rather than the user (wrong audit trail), and it would require write scopes on a credential this plugin currently only reads with.
9. **Hand-rolled `fetch` against the GitHub REST API** instead of `@octokit/rest`. Rejected: `@octokit/rest@19` is already in the bundle via `plugin-catalog-import`, so the dependency is free, and its typed errors are what the dialog's blocked states key off.
10. **`js-yaml` for the descriptor edit** (as the backend uses at `manifestProbe.ts`). Rejected: it round-trips away comments. `yaml@2`'s `parseDocument`/`toString` preserves them, and an unlink PR that silently strips a team's comments will not get merged.
11. **`EntityPickerFieldExtension` for the API multiselect.** Rejected: it is an RJSF scaffolder field, not a standalone component.
12. **`DefaultFilters` on the dashboard.** Rejected: no `hidden` pass-through for the kind picker (F10), so the Kind dropdown would show and let the user filter away from `bruno`.
13. **A dedicated final teardown phase.** Rejected: the dashboard and the API-entity card each *replace* a surface at the same mount point; leaving both live means a double-rendered card and a route conflict. Teardown therefore happens in the phase that lands the replacement, which is also what keeps every commit's `grep` clean.
14. **Keeping the standalone `/bruno/docs/:collectionId` page as-is.** Rejected: collection-id keying is the annotation model's identity. Re-keyed to `:namespace/:name` instead, which also lets us delete the duplicated cookie logic (`BrunoDocsPage.tsx:31, :43-58, :207-216`) that the brief flags.

---

## 6. Cannot deliver

**6.1 — PRD line 84: "The Bruno Entity page will have 3 tabs."** Resolved as a typo per the locked decision: the section lists exactly two (Overview, Bruno API Docs). Two tabs are delivered.

**6.2 — Unlink cannot be instant.** PRD line 89 says *"the action button to delete the relation"*. Catalog relations are derived output, rewritten on every stitch; `plugin-catalog-backend`'s router exposes no relation-mutation endpoint (BE-P1 R7). Deleting a relation row would be silently reverted within one processing cycle (100–150 s by default, BE-P1 F4). Delivered as the asynchronous PR flow in §4, with the UX designed around the wait.

**6.3 — Unlink cannot be offered for `bruno.collections[]`-sourced entities.** They have no descriptor file (BE-P1 §3.H.4 stamps `url:<collection folder>` as `managed-by-location`). Delivered as a disabled action with a precise, actionable message naming the config key. Same for `file:`-located entities.

**6.4 — The add-collection PR cannot write into the collection subfolder, cannot update an existing root descriptor, cannot run more than one at a time, and cannot target GitLab or Bitbucket.** All four are properties of `catalogImportApi` (F12), which the locked decision accepts. Delivered as four explicit UI warnings plus a pre-disabled button for unsupported hosts, with Download always available as the manual path.

**6.5 — Bruno entity pages lose the native context menu wiring for third-party `EntityContextMenuItemBlueprint` extensions.** A custom `EntityHeaderLayoutBlueprint` receives only `{tabs, activeTabId}` (F5); `contextMenuItems` are collected at `pages.esm.js:151-156` and handed only to `EntityHeaderBui`. Our header rebuilds Inspect + Unregister from public components, but a *third-party* plugin's context-menu item will not appear on `kind: Bruno` pages. There is no public API to receive them. Accepted; recorded as R3.

**6.6 — Sync is not instantaneous.** §0.3. The refresh is queued and the collection is re-read within `bruno.cacheTtlSeconds` (default 60 s). Delivered as honest toast wording rather than a false "Synced" confirmation.

---

## 7. Risks and open questions

**R1 — mixing `@backstage/ui` (BUI) and MUI v4.** The entity header is BUI (`EntityHeaderBui.esm.js:3`); the entity *content* is MUI v4. Our custom header is BUI `Header` with `customActions` containing MUI v4 `LinkButton`s and catalog-react's `FavoriteEntity`. Vertical alignment and focus rings must be eyeballed at boot. Mitigation: if it reads badly, use BUI `Button`/`ButtonIcon` for the three Bruno actions and keep only `FavoriteEntity` as MUI.

**R2 — `EntityHeaderLayoutBlueprint` is `@alpha`.** Its props may change across minors. It is the only public way to satisfy PRD lines 73-80. Blast radius is one file (`BrunoEntityHeader.tsx`) and it is filtered to `kind: bruno`, so a break cannot damage other kinds.

**R3 — third-party context-menu items are dropped on Bruno pages.** See §6.5.

**R4 — the facet key contract is a silent coupling.** If BE-P2 names the field `spec.requests` instead of `spec.requestCount`, the tile shows `—` with no error anywhere. Mitigation: define the two field names as exported constants in `lib/brunoEntity.ts` and have `useBrunoStats` import them, so there is exactly one place to change and one place to grep.

**R5 — a stale `spec.partOf` after an Unlink PR merges.** The relation persists until the catalog re-processes the entity (100–150 s, BE-P1 F4) — or, for a `bruno.collections[]` entity, until the provider next runs (`bruno.schedule.frequencySeconds: 60`, `app-config.yaml:168-170`). The dialog says so explicitly (§4.3).

**R6 — `submitPullRequest`'s pre-validation triggers a live probe fetch.** F12: it calls `catalogApi.validateEntity`, which runs the full orchestrator including `BrunoKindProcessor.preProcessEntity` → `probe.probe(url)`. On a cold cache that is one SCM tree read *and one full collection parse* per PR submission (BE-P2 R2). Bounded and cached, but it means a slow/unreachable repo makes the PR button *appear* to hang. Mitigation: the button shows a spinner with the label "Validating…" before "Opening pull request…".

**R7 — `metadata.version` is not a schema-recognised field.** It survives only because `EntityMeta.schema.json` is `additionalProperties: true` (BE-P1 F2). Nothing native renders it; our header does. If an upstream Backstage version tightens `EntityMeta`, the field is rejected at ingestion and the header shows `—`.

**Q1** — should the sidebar entry read **"Bruno Collections"** (the PRD's page title, and what `PageBlueprint` `title` produces, F17) or the shorter **"Bruno"**? Plan assumes the PRD's wording; splitting them means dropping `title` from the blueprint and losing the auto-discovered nav item.

**Q2** — should the dashboard also expose per-row actions (Fetch in Bruno / Sync) via `CatalogTable`'s `actions` prop? The PRD does not ask for it. Plan says no.

**Q3** — `spec.docs`: should BE-P2 embed the collection documentation on the entity (one fewer fetch, but entity bloat) or serve it at `GET /entities/:ns/:name/docs.md` as §0.2 assumes? Plan assumes the route.

**Q4** — should **Link an existing Bruno collection** (UI-P4 step 2) open a PR against the *collection's* descriptor, as planned, or against the *API's* descriptor? `spec.partOf` lives on the Bruno entity, so the collection's descriptor is the only correct target — but that means linking from an API page edits a file in a different repo. Confirm this is the intended mental model.

**Q5** — the standalone `/bruno/docs/:namespace/:name` page: keep it (plan assumes yes, re-keyed) or delete it and rely on the entity tab plus its "Open in new tab"?

---

## 8. Gate commands, all phases

```
# per phase, from the repo root — all must pass, yarn tsc at 0 errors
yarn tsc
yarn lint:bruno <the phase's changed paths>
yarn prettier:check
```
`yarn tsc` at 0 errors is the binding per-commit gate. No tests are added; `yarn test` is not a gate.

A clean live boot, at every phase, means: `yarn start` produces no unhandled rejection, no `No processor recognized the entity` for `bruno:default/my-bruno-collection`, no React error boundary anywhere in the Bruno surface, `GET /api/bruno/health` → 200, the `kind: Bruno` entity resolves at `/catalog/default/bruno/my-bruno-collection` with its `partOf` / `ownedBy` / `hasPart` relations intact, and `grep` for `$GITHUB_TOKEN` over the boot log returns zero hits.
