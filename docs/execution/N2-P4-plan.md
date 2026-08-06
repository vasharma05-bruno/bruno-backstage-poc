# N2-P4 — Bruno page shell + Collections tab (frontend) — Execution Plan (LOCKED)

> A standalone Bruno page (new frontend system), auto-registered by `brunoPlugin`, at `/bruno` with a two-tab bar (Collections active; Link API = placeholder for N2-P5). Collections tab: 3 stat tiles, client-side search, 2-col card grid, failures strip — from one `GET /dashboard`. No tests, no backend changes, no `packages/app` edits. Minimal diff, MUI v4 + core-components style.
>
> Orchestrator-verified: `PageBlueprint` + `createRouteRef` exported from `@backstage/frontend-plugin-api`; `NavItemBlueprint` does NOT exist in 1.53; PageBlueprint params = `{path, title?, icon?: IconElement, loader?, routeRef?, noHeader?}`; the custom Sidebar (`packages/app/src/modules/nav/Sidebar.tsx:40`) renders `nav.rest({sortBy:'title'})`, so `page:bruno` auto-appears. Icon: **`@material-ui/icons/Http` is present; `Api` is MISSING** — use `Http`.

## Locked decisions
1. **Nav via PageBlueprint only** — set `routeRef` (from `createRouteRef()`) + `title: 'Bruno'` + `icon: <Http fontSize="inherit" />`. No NavItemBlueprint, no `packages/app` edit; the Sidebar auto-discovers it via `nav.rest()`. Add a code comment noting routeRef+title+icon are what make the nav item appear.
2. **Icon = `Http`** (verified present in `@material-ui/icons`).
3. **Page renders content only** (PageLayout supplies the header). Tab bar = in-body MUI `Tabs`/`Tab`; wrap body in core-components `Content`.
4. **Path `/bruno`** (free — Sidebar `take()`s catalog/scaffolder/search/notifications/visualizer/settings; `/bruno` unused).
5. `getDashboard()` reuses the private `getJson<T>` in `BrunoClient` (already attaches the token via `fetchApi.fetch`).
6. **2 columns** via `Grid item xs={12} md={6}` (not `ItemCardGrid`).
7. **OPEN** deep-link via `parseEntityRef(entityRef)` → client-side `Link` to `/catalog/<ns>/<kind>/<name>/bruno-docs` (lowercase ns/kind); when `entityRef` undefined → disabled Button in a Tooltip.
8. Do NOT register the routeRef in `createFrontendPlugin({routes})` (not needed).

## API layer
- `api/types.ts` (append): `DashboardStats`, `DashboardCollection` (`{id,name,requestCount,envCount,activeEnv?,specType?,linked,entityRef?}`), `SourceFailure {id,target,error}`, `Dashboard {stats,collections,failures}` — mirroring backend `types.ts`.
- `api/BrunoApi.ts`: import `Dashboard`; add `getDashboard(): Promise<Dashboard>;`.
- `api/BrunoClient.ts`: import `Dashboard`; `async getDashboard() { return this.getJson<Dashboard>('/dashboard'); }`. No `extension.ts` change.

## New files — `plugins/bruno/src/components/BrunoPage/`
- `BrunoPage.tsx` — content-only root; `useState` tab; MUI `Tabs` (Collections / Link API); body → `CollectionsTab` or `LinkApiPlaceholder`; wrap in `Content`.
- `CollectionsTab.tsx` — `useApi(brunoApiRef)`, load-once cancel-guard effect → `getDashboard()`; state `loading|ready|error` (`Progress` / `WarningPanel` / sections); `useMemo` client-side filter (name/specType/activeEnv, case-insensitive) driven by a `TextField` search box; renders `StatTiles`, `FailuresStrip` (only if failures), search box, `CollectionGrid` (empty-state text when no matches).
- `StatTiles.tsx` — 3 `InfoCard`/tiles (`Grid item xs={12} sm={4}`): Collections / Total Requests / Linked Entities (caption label over `h4` value).
- `CollectionGrid.tsx` — `Grid container spacing={2}`, each `Grid item xs={12} md={6}` → `CollectionCard`, keyed by `id`.
- `CollectionCard.tsx` — `InfoCard` with: styled `B` avatar + name; `linked` Chip (green) when linked; neutral spec-type Chip when `specType`; `{requestCount} requests`, `{envCount} envs`, `activeEnv` (when defined); OPEN action per decision 7.
- `FailuresStrip.tsx` — one `WarningPanel severity="warning"` listing `failures` (target + error), keyed by `id`. Never hide.
- `LinkApiPlaceholder.tsx` — `InfoCard`/`EmptyState` "Link API — coming soon (N2-P5)."
- `index.ts` — `export { BrunoPage } from './BrunoPage';`

## Extensions + registration
- `extensions.tsx`: `import { PageBlueprint, createRouteRef } from '@backstage/frontend-plugin-api';` + `import Http from '@material-ui/icons/Http';`. Define `const brunoPageRouteRef = createRouteRef();` and:
  ```tsx
  export const brunoPage = PageBlueprint.make({
    name: 'bruno',
    params: {
      path: '/bruno',
      title: 'Bruno',
      icon: <Http fontSize="inherit" />,
      routeRef: brunoPageRouteRef,
      loader: () => import('./components/BrunoPage').then((m) => <m.BrunoPage />)
    }
  });
  ```
- `plugin.ts`: import `brunoPage`; add to the `extensions` array; update the doc comment.

## Executor watch-list
1. Page component renders content only — no `<Page>`/`<Header>`.
2. `routeRef` + `title` + `icon` all set on the PageBlueprint (nav depends on all three).
3. Icon import is `Http` (NOT `Api`).
4. Cards handle undefined `activeEnv`/`specType`/`entityRef`.
5. Build: `yarn workspace @usebruno/plugin-bruno build`. No tests.
