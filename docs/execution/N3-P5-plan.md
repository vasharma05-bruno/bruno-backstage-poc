# N3-P5 — OpenCollection docs iframe on the API Docs tab — Execution Plan (LOCKED)

> On the entity **API Docs** tab, fetch the linked collection's OpenCollection YAML (P4's `getOpenCollectionYaml(id)`, already shipped) and render it with the OpenCollection docs bundle inside a themed **`srcdoc` iframe**. **D-E = REPLACE:** the API Docs tab content stops rendering the native two-pane viewer + "Try it out" and renders a new `OcDocsFrame` instead; the confirmed-dead native-viewer/Try-it-out files are deleted. **D-F = hardcode the STAGING CDN:** the iframe loads `https://staging.cdn.opencollection.com/docs.js` + `docs.css` via `<script src>`/`<link href>` (NOT self-hosted, NOT inlined — docs.js is ~4.5MB). **D-G = `sandbox="allow-scripts"`** only (NO `allow-same-origin`). Frontend lives in `plugins/bruno/src`; **ONE app-side touch** is allowed and required — a `backend.csp` addition in `app-config.yaml` to allowlist the CDN (documented thin glue; it bumps the §2 placement principle — noted explicitly below). No new deps, no tests. Gated by repo-level `yarn tsc` (0 errors) + `yarn lint:bruno <changed paths>` (NEW code clean vs the pre-existing baseline) — NOT backstage-cli build.
>
> **Verified against HEAD `b7ef2f3` (not assumed):**
> - The API Docs tab is `brunoDocsContent = EntityContentBlueprint.make(...)` at `extensions.tsx:77-86`, `path:'/bruno-docs'`, `title:'API Docs'`, `filter: isApiEntity`, `loader: () => import('./components/CollectionDocs').then(m => <m.CollectionDocs />)`. Registered in the plugin's `extensions` array at `plugin.ts:35`.
> - `components/CollectionDocs/index.ts` re-exports `CollectionDocs` (`index.ts:1`). `CollectionDocs.tsx` (the native viewer) fetches `brunoApi.getCollection(id)` and renders a two-pane layout: `CollectionTree` (local, `CollectionDocs/CollectionTree.tsx`) + `RequestDetail` (`CollectionDocs/RequestDetail.tsx`), the latter embedding `<TryItOut>` (`CollectionDocs/TryItOut.tsx`, tab index 6). Id resolution: annotation `bruno.dev/collection-id` via `getCollectionId(entity)` first, else `brunoApi.getConnection(entityRef).collectionId` (`CollectionDocs.tsx:71-73`).
> - P4 is fully implemented: backend route `GET /collections/:id/opencollection.yml` (`router.ts:79-86`, open, `res.type('text/yaml')`), client `getOpenCollectionYaml(id): Promise<string>` (`BrunoClient.ts:60-71`), interface member (`BrunoApi.ts:25`). P5 CONSUMES this — no backend change.
> - Theme API: installed `@backstage/frontend-plugin-api@0.17.3` exposes `appThemeApiRef` (re-exported through `core-plugin-api`) with `AppThemeApi = { getInstalledThemes(): AppTheme[]; activeThemeId$(): Observable<string|undefined>; getActiveThemeId(): string|undefined; setActiveThemeId(...) }` and `AppTheme.variant: 'light'|'dark'` (`frontend-plugin-api/dist/index.d.ts:587-633`). MUI is `@material-ui/core@4.12.4`; `useTheme()` is exported (`styles/index.d.ts:17`) and `theme.palette.type: 'light'|'dark'` (`createPalette.d.ts:76`). **Decision below: use MUI `useTheme().palette.type`** (see D-THEME).
> - CSP: `app-config.yaml:29-32` already sets `backend.csp: { connect-src: ["'self'", 'http:', 'https:'] }`. Backstage's helmet setup (`backend-defaults/.../readHelmetOptions.cjs.js:44-58`) starts from `helmet.contentSecurityPolicy.getDefaultDirectives()`, **hard-overrides `script-src` to `["'self'","'unsafe-eval'"]`**, deletes `form-action`, then applies each config `csp` key as a **full REPLACE** of that directive (not a merge; `getStringArray`). Effective defaults (helmet 8, verified via `getDefaultDirectives()`): `default-src 'self'`; `style-src 'self' https: 'unsafe-inline'`; `img-src 'self' data:`; `font-src 'self' https: data:`; `connect-src 'self'` (overridden by app-config to `'self' http: https:`); `object-src 'none'`; `script-src 'self' 'unsafe-eval'` (Backstage override). So loading `<script src="https://staging.cdn...">` is **BLOCKED** (script-src lacks the host); `<link rel=stylesheet href="https://...">` is allowed (style-src has `https:`); inline `<style>`/inline `<script>` in the srcdoc are allowed by `'unsafe-inline'`/`'unsafe-eval'`-adjacent rules **only** if their directives permit — inline `<script>` needs `'unsafe-inline'` in `script-src`, which is NOT present. **Therefore both `script-src` (external CDN + inline bootstrap) MUST be widened.**
> - Dev-vs-prod CSP: `yarn start` = `backstage-cli repo start`; the frontend is served by `backstage-cli package start` (webpack-dev-server on :3000) which does **NOT** emit the backend helmet CSP header. The helmet CSP only applies to responses served through the backend rootHttpRouter (production `app-backend`). **So in `yarn start` dev the CDN + inline-script loads work regardless of app-config; the CSP additions are what make it work in a production build.** The executor's live-check under `yarn start` will therefore NOT exercise the CSP — flagged in Risks.

## Placement-principle note (§2 bump — explicit)
`NEXT-STEPS-3 §2` says everything in this plan lives in the plugin. The srcdoc iframe hosts a third-party bundle from an external CDN, which the production app's helmet CSP blocks by default. There is **no plugin-side way** to widen the app's CSP — it is app config. So this phase makes **exactly one app-side touch**: extend `backend.csp` in `app-config.yaml` (and mirror it in `app-config.production.yaml` if the executor wants prod parity — see D-CSP). This is documented thin glue analogous to the SignInPage harness (`NEXT-STEPS-3 §10 D-I` precedent). No Bruno feature logic moves into `packages/app`/`packages/backend`; only a CSP allowlist string.

## Investigated: current API Docs tab wiring (quoted)
- **Blueprint:** `plugins/bruno/src/extensions.tsx:77-86`
  ```
  export const brunoDocsContent = EntityContentBlueprint.make({
    name: 'docs',
    params: { path: '/bruno-docs', title: 'API Docs', filter: isApiEntity,
      loader: () => import('./components/CollectionDocs').then((m) => <m.CollectionDocs />) }
  });
  ```
- **Registration:** `plugin.ts:35` (in the `extensions` array of `createFrontendPlugin`). Docblock line `plugin.ts:24` describes it.
- **Content component tree (native viewer, the D-E target):**
  - `components/CollectionDocs/index.ts:1` → `export { CollectionDocs } from './CollectionDocs';`
  - `CollectionDocs.tsx` imports: `./CollectionTree` (`:21`), `./RequestDetail` (`:22`), `./tree` (`firstRequestId`, `flattenRequests`, `:23`); `getCollectionId` (`../../lib/annotations`, `:19`), `subscribeConnectionChange` (`../../lib/connectionEvents`, `:20`), `brunoApiRef` (`:17`).
  - `RequestDetail.tsx` imports `./TryItOut` (`:15`), `../MethodBadge` (`:14`).
  - `TryItOut.tsx` imports `../../lib/template` (`buildVarMap`, `prepareRequest`, `:10`), `../../lib/proxy` (`resolveViaProxy`, `:11`), `../MethodBadge` (`statusColor`, `badgeTextColor`, `:12`).
  - `CollectionDocs/CollectionTree.tsx` (LOCAL to this dir; distinct from `components/CollectionTree/`) imports `../MethodBadge` (`:11`).

## D-E deletion set — traced importers (evidence)

### DELETE (dead once the tab renders `OcDocsFrame`) — no OTHER importer
| File | Sole importer(s) (grep evidence) |
|---|---|
| `components/CollectionDocs/CollectionDocs.tsx` | only `extensions.tsx:84` (via the barrel) — replaced by `OcDocsFrame` |
| `components/CollectionDocs/RequestDetail.tsx` | only `CollectionDocs.tsx:22` |
| `components/CollectionDocs/TryItOut.tsx` | only `RequestDetail.tsx:15` |
| `components/CollectionDocs/CollectionTree.tsx` (local) | only `CollectionDocs.tsx:21` (NOT the `components/CollectionTree/` card) |
| `components/CollectionDocs/tree.ts` | only `CollectionDocs.tsx:23` (`firstRequestId`/`flattenRequests` used nowhere else) |
| `lib/template.ts` | only `TryItOut.tsx:10` (`prepareRequest`/`buildVarMap` grep-clean elsewhere) |
| `lib/proxy.ts` | only `TryItOut.tsx:11` (`resolveViaProxy` grep-clean elsewhere) |

All seven form a closed dependency island rooted at `CollectionDocs.tsx`; deleting `CollectionDocs.tsx` + `OcDocsFrame` swap orphans the other six, and none is imported from outside `components/CollectionDocs/`.

### KEEP (still referenced elsewhere — do NOT delete)
| File | Live importer (evidence) |
|---|---|
| `components/MethodBadge/` (incl. `colors.ts` `statusColor`/`badgeTextColor`) | `components/CollectionTree/CollectionTreeCard.tsx:18` imports `MethodBadge`. (`statusColor`/`badgeTextColor` lose their only consumer when `TryItOut` goes, but they remain harmless barrel exports of a kept dir — unused named exports do NOT fail lint. Leave `MethodBadge/` untouched.) |
| `lib/brunoLink.ts` (`buildBrunoDeepLink`) | `components/OpenInBruno/OpenInBruno.tsx:10-12`; `OpenInBruno` used by `BrunoCard.tsx:16,258`. STAYS. |
| `lib/annotations.ts` (`getCollectionId`) | used by `CollectionTreeCard`, `CollectionOverviewCard`, `BrunoCard`, and the new `OcDocsFrame`. STAYS. |
| `lib/connectionEvents.ts` (`subscribeConnectionChange`/`emitConnectionChange`) | used by `CollectionTreeCard`, `CollectionOverviewCard`, `CollectionPicker`, `BrunoCard`, and the new `OcDocsFrame`. STAYS. |
| `components/CollectionTree/` (the tree CARD `CollectionTreeCard`) | `extensions.tsx:49` (`brunoCollectionTreeCard`), `plugin.ts:33`. Distinct from the deleted local `CollectionDocs/CollectionTree.tsx`. STAYS. |
| `api/types.ts` `RequestItem`/`Environment`/etc. | broadly used. STAYS. |

**No entanglement / no STOP condition.** The island is fully closed; every deletion is grep-confirmed to have no external importer.

## Locked decisions
- **D-E (given) — REPLACE the native viewer.** The API Docs tab content becomes `OcDocsFrame`. Delete the seven-file island above. Repoint the `CollectionDocs` barrel (or the blueprint loader) to `OcDocsFrame` (see Frontend edits — barrel-repoint chosen to keep `extensions.tsx` untouched).
- **D-F (given) — hardcode STAGING CDN.** `<link rel="stylesheet" href="https://staging.cdn.opencollection.com/docs.css"/>` + `<script src="https://staging.cdn.opencollection.com/docs.js"></script>` in the srcdoc. No vendoring, no plugin static asset, no backend proxy route.
- **D-G (given) — `sandbox="allow-scripts"`** only. NO `allow-same-origin`. The frame runs third-party JS on an opaque origin and cannot reach Backstage's origin/session/cookies/localStorage. **Risk flagged (R-A):** if `docs.js` needs `localStorage`/same-origin it will throw inside the frame; that surfaces as a broken render, a **live-check item** — do NOT pre-emptively add `allow-same-origin` (defeats the isolation intent). If confirmed broken at live-check, escalate to the user rather than silently loosening.
- **D-THEME — read the effective theme via MUI `useTheme().palette.type`.** Rationale: (1) it resolves the **effective** light/dark even when the user follows the OS default (`appThemeApiRef.getActiveThemeId()` returns `undefined` in that case and would need a `getInstalledThemes()` lookup + `activeThemeId$()` Observable subscription via `useObservable`, and `react-use` is NOT a declared plugin dep — using it trips `import/no-extraneous-dependencies`); (2) MUI's `ThemeProvider` re-renders the subtree on theme toggle, so a component reading `useTheme()` re-renders automatically → the memoized srcdoc rebuilds → the iframe re-renders with the new `theme`. `@material-ui/core` IS a declared plugin dep. Map `palette.type === 'dark' ? 'dark' : 'light'`.
- **D-ASYNC — manual `useEffect`+`useState`, NOT `useAsync`.** The plugin has zero `useAsync`/`react-use` usage; every async surface (`CollectionsTab`, `LinkApiTab`, the old `CollectionDocs`) uses manual `useEffect`+`useState`. `react-use`/`useAsync` is not a declared dep. To keep the diff convention-consistent and lint-clean, `OcDocsFrame` mirrors the OLD `CollectionDocs.tsx` fetch skeleton (loading/error/notConnected states, `subscribeConnectionChange` refresh-on-connect) but fetches `getOpenCollectionYaml(id)` instead of `getCollection(id)`.
- **D-CSP — extend `backend.csp` in `app-config.yaml` (dev) and note prod parity.** Add the two CDN hosts (opencollection + the 301 redirect target usebruno) plus `'unsafe-inline'` to `script-src` (the srcdoc's inline bootstrap `<script>` needs it), and widen `img-src`. `style-src`/`font-src`/`connect-src` already permit `https:`. Because each config key is a full REPLACE, the new `script-src` MUST re-include the Backstage baseline `'self' 'unsafe-eval'`. See CSP edit for the exact block. Mirror into `app-config.production.yaml` only if the executor wants a production build to load the CDN (dev does not need it).
- **D-SAFE-INJECTION (must) — JSON-encode + `</script>` split + title-escape.** `collectionData` is built with `JSON.stringify(yamlString)` (never string concat); the whole srcdoc string then has any `</script>` sequence defensively neutralised via `.replace(/<\/script>/gi, '<\\/script>')` applied to the SERIALISED JSON literal (so a YAML value containing `</script>` cannot break out of the inline `<script>`); the `{{name}}` in `<title>` is HTML-escaped (`&`,`<`,`>`,`"`). Do NOT use template-literal interpolation of raw YAML into HTML.

## Frontend edits

### `plugins/bruno/src/components/CollectionDocs/OcDocsFrame.tsx` (NEW — the iframe host)
Imports (all declared deps): `import { useEffect, useMemo, useState } from 'react';` · `import { makeStyles, useTheme } from '@material-ui/core/styles';` · `import { Content, EmptyState, Progress, ResponseErrorPanel } from '@backstage/core-components';` · `import { useApi } from '@backstage/core-plugin-api';` · `import { useEntity } from '@backstage/plugin-catalog-react';` · `import { stringifyEntityRef } from '@backstage/catalog-model';` · `import { brunoApiRef } from '../../api/BrunoApi';` · `import { getCollectionId } from '../../lib/annotations';` · `import { subscribeConnectionChange } from '../../lib/connectionEvents';`

Structure (mirror the OLD `CollectionDocs.tsx` skeleton — the executor may lift the id-resolution + refresh-nonce + loading/error/notConnected scaffolding almost verbatim, swapping the fetch and the render):

1. **Consts (module scope):**
   - `const CDN = 'https://staging.cdn.opencollection.com';`
   - `const useStyles = makeStyles(() => ({ frame: { width: '100%', height: '80vh', border: 0 } }));` (a bordered full-height frame; `Content` supplies page padding).

2. **HTML escape helper (module scope, pure):**
   ```
   function escapeHtml(s: string): string {
     return s
       .replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;');
   }
   ```

3. **srcdoc builder (module scope, pure):**
   ```
   function buildSrcDoc(yaml: string, title: string, theme: 'light' | 'dark'): string {
     const data = JSON.stringify(yaml).replace(/<\/script>/gi, '<\\/script>');
     return [
       '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>',
       '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
       `<title>${escapeHtml(title)} - API Documentation</title>`,
       '<style>body{margin:0;padding:0}#opencollection-container{width:100vw;height:100vh}</style>',
       `<link rel="stylesheet" href="${CDN}/docs.css"/>`,
       `<script src="${CDN}/docs.js"></script>`,
       '</head><body><div id="opencollection-container"></div>',
       '<script>',
       `const collectionData = ${data};`,
       'new window.OpenCollection({',
       "target: document.getElementById('opencollection-container'),",
       'opencollection: collectionData,',
       `theme: '${theme}' });`,
       '</script></body></html>'
     ].join('');
   }
   ```
   (`JSON.stringify(yaml)` yields a valid, quote/backtick/newline-safe JS string literal; the `</script>` replace runs on the serialised literal so an embedded `</script>` in a YAML value can't terminate the inline block. `theme` is a fixed `'light'|'dark'` union — no injection surface.)

4. **Component `OcDocsFrame()`:**
   - `const classes = useStyles(); const theme = useTheme(); const { entity } = useEntity(); const brunoApi = useApi(brunoApiRef);`
   - `const entityRef = stringifyEntityRef(entity);`
   - `const annotationCollectionId = getCollectionId(entity);`
   - `const themeMode: 'light' | 'dark' = theme.palette.type === 'dark' ? 'dark' : 'light';`
   - State: `const [yaml, setYaml] = useState<string | undefined>();` `error`, `loading` (init `true`), `notConnected`, `refreshNonce` (0) — same shape as OLD CollectionDocs.
   - `useEffect(() => subscribeConnectionChange(entityRef, () => setRefreshNonce((n) => n + 1)), [entityRef]);`
   - Fetch `useEffect` keyed `[brunoApi, entityRef, annotationCollectionId, refreshNonce]` (NOTE: theme is deliberately NOT a fetch dep — a toggle must not re-fetch, only rebuild srcdoc):
     ```
     let cancelled = false;
     setLoading(true); setNotConnected(false);
     const resolveId = annotationCollectionId
       ? Promise.resolve(annotationCollectionId)
       : brunoApi.getConnection(entityRef).then((r) => r?.collectionId);
     resolveId
       .then((collectionId) => {
         if (cancelled) return undefined;
         if (!collectionId) { setNotConnected(true); return undefined; }
         return brunoApi.getOpenCollectionYaml(collectionId).then((y) => {
           if (cancelled) return;
           setYaml(y); setError(undefined);
         });
       })
       .catch((e) => { if (!cancelled) setError(e instanceof Error ? e : new Error(String(e))); })
       .finally(() => { if (!cancelled) setLoading(false); });
     return () => { cancelled = true; };
     ```
   - `const srcDoc = useMemo(() => (yaml ? buildSrcDoc(yaml, entity.metadata.title ?? entity.metadata.name, themeMode) : ''), [yaml, entity.metadata.title, entity.metadata.name, themeMode]);` — **theme change rebuilds srcdoc → iframe re-renders** (D-THEME).
   - Render guards (same order/style as OLD CollectionDocs): `loading → <Content><Progress/></Content>`; `notConnected → <Content><EmptyState missing="content" title="No Bruno collection connected" description="Use the Bruno card on the Overview tab to connect a collection."/></Content>`; `error → <Content><ResponseErrorPanel error={error}/></Content>`; `!yaml → <Content><EmptyState missing="data" title="No collection data" description="The backend returned no collection."/></Content>`.
   - Success:
     ```
     return (
       <Content>
         <iframe
           title="API Documentation"
           className={classes.frame}
           sandbox="allow-scripts"
           srcDoc={srcDoc}
         />
       </Content>
     );
     ```
   (React prop is `srcDoc` (camelCase) and `sandbox="allow-scripts"` exactly — a bare `sandbox` or empty string = maximally locked and would block scripts.)

### `plugins/bruno/src/components/CollectionDocs/index.ts` (repoint the barrel — keeps `extensions.tsx` untouched)
Change the single line:
```
export { CollectionDocs } from './CollectionDocs';
```
→
```
export { OcDocsFrame as CollectionDocs } from './OcDocsFrame';
```
Rationale: `extensions.tsx:84` does `import('./components/CollectionDocs').then((m) => <m.CollectionDocs />)`. Re-exporting `OcDocsFrame` under the name `CollectionDocs` means **zero change to `extensions.tsx` and `plugin.ts`** (minimal diff, no blueprint/registration churn). The tab id/path/title stay `docs`/`/bruno-docs`/`API Docs`.
(Alternative — rename the export to `OcDocsFrame` and edit `extensions.tsx:83-84` + the barrel — is NOT chosen; it enlarges the diff for no behavioural gain.)

### Deletions (D-E island — after the barrel repoint, `git rm` these seven)
- `plugins/bruno/src/components/CollectionDocs/CollectionDocs.tsx`
- `plugins/bruno/src/components/CollectionDocs/RequestDetail.tsx`
- `plugins/bruno/src/components/CollectionDocs/TryItOut.tsx`
- `plugins/bruno/src/components/CollectionDocs/CollectionTree.tsx`  ← the LOCAL one only; NOT `components/CollectionTree/`
- `plugins/bruno/src/components/CollectionDocs/tree.ts`
- `plugins/bruno/src/lib/template.ts`
- `plugins/bruno/src/lib/proxy.ts`

## App edit (the one allowed app-side touch)

### `app-config.yaml` — `backend.csp` (`:29-32`, extend)
Replace the existing 2-line `csp` block with the full set below. Because each key is a full REPLACE of that directive, `script-src` MUST re-list the Backstage baseline (`'self' 'unsafe-eval'`) plus `'unsafe-inline'` (for the srcdoc's inline bootstrap `<script>`) plus BOTH CDN hosts (opencollection AND its 301 redirect target usebruno). `connect-src` already `'self' http: https:` (keep). Add `img-src` (helmet default `'self' data:` lacks https/CDN; docs.js may render remote images/icons). `style-src`/`font-src` helmet defaults already carry `https:` — but since we override style-src's directive via this block we must re-list its baseline too if we touch it; simplest is to NOT set `style-src`/`font-src` here (leave helmet defaults intact) and only set `script-src`, `connect-src`, `img-src`:
```yaml
  csp:
    connect-src: ["'self'", 'http:', 'https:']
    script-src:
      - "'self'"
      - "'unsafe-eval'"
      - "'unsafe-inline'"
      - 'https://staging.cdn.opencollection.com'
      - 'https://staging.cdn.usebruno.com'
    img-src:
      - "'self'"
      - 'data:'
      - 'https://staging.cdn.opencollection.com'
      - 'https://staging.cdn.usebruno.com'
```
Notes: do NOT set `style-src`/`font-src` (helmet defaults `'self' https: 'unsafe-inline'` and `'self' https: data:` already cover the CDN CSS + fonts). `'unsafe-inline'` is required in `script-src` for the srcdoc inline bootstrap; there is no nonce path for srcdoc content here. Both CDN hosts are listed because `staging.cdn.opencollection.com` 301-redirects to `staging.cdn.usebruno.com` and CSP is enforced against the redirect *target* too.
- **Prod parity (optional, executor decision):** `app-config.production.yaml` currently sets no `csp`. If a production `app-backend` build must load the CDN, mirror the same `backend.csp` block there. For the P5 gates + `yarn start` live-check this is NOT required (dev frontend has no helmet CSP — see below).
- **Dev-vs-prod:** under `yarn start` the frontend is webpack-dev-served on :3000 and does NOT get the helmet CSP header, so the iframe CDN + inline script load even WITHOUT this app-config change. The change is what makes a **production** build work. The executor's live-check under `yarn start` therefore validates the render/theme/injection but NOT the CSP allowlisting — call that out.

## Executor watch-list
1. **Safe injection is load-bearing:** `collectionData = JSON.stringify(yamlString)` then `.replace(/<\/script>/gi, '<\\/script>')` on the serialised literal; `<title>` via `escapeHtml`. Never interpolate raw YAML into HTML. Verify with a collection whose docs contain `"`, backticks, and a literal `</script>`.
2. **`sandbox="allow-scripts"` EXACTLY** — not bare `sandbox`, not `sandbox=""` (blocks scripts), NOT `allow-scripts allow-same-origin` (defeats D-G isolation). React prop is `srcDoc` (camelCase), not `srcdoc`.
3. **Do NOT delete still-referenced files:** `MethodBadge/` (used by `CollectionTreeCard`), `lib/brunoLink.ts` (used by `OpenInBruno`→`BrunoCard`), `lib/annotations.ts`, `lib/connectionEvents.ts`, and `components/CollectionTree/` (the tree CARD) all STAY. Only the seven-file island is deleted. The deleted `CollectionDocs/CollectionTree.tsx` is the LOCAL copy — NOT `components/CollectionTree/`.
4. **After deletion, re-grep** `prepareRequest|buildVarMap|resolveViaProxy|firstRequestId|flattenRequests|RequestDetail|TryItOut` across `plugins/bruno/src` → expect zero hits. Confirm the `CollectionDocs` barrel now points at `OcDocsFrame` and `extensions.tsx`/`plugin.ts` are untouched.
5. **CSP host list must include BOTH** `https://staging.cdn.opencollection.com` AND `https://staging.cdn.usebruno.com` (301 redirect target) in `script-src` and `img-src`. `script-src` MUST also re-list `'self' 'unsafe-eval' 'unsafe-inline'` (config keys REPLACE, not merge). Keep `connect-src` as-is.
6. **`import type`** for type-only imports; leading-`|`/`=` on multi-line unions; NO narration comments in new code; minimal diff. `themeMode`/`buildSrcDoc`'s `theme` param typed as the union `'light' | 'dark'`.
7. **Theme dep hygiene:** theme is a `useMemo` dep for `srcDoc`, NOT a dep of the fetch `useEffect` (a toggle rebuilds srcdoc, never re-fetches). Use MUI `useTheme().palette.type` — do NOT add `react-use`/`appThemeApiRef` observable wiring (undeclared-dep lint).
8. **No new dependency** in `plugins/bruno/package.json`. All imports resolve to already-declared deps (`@material-ui/core`, `@backstage/core-components`, `@backstage/core-plugin-api`, `@backstage/plugin-catalog-react`, `@backstage/catalog-model`).

## Risks
- **R-A — sandbox vs docs.js (RESOLVED at live-check).** `sandbox="allow-scripts"` gave the frame an opaque origin; the OpenCollection bundle reads `sessionStorage` on boot → `Uncaught SecurityError: Failed to read the 'sessionStorage' property ... document is sandboxed and lacks the 'allow-same-origin' flag` → blank white page. **Resolution (user-approved):** relaxed to `sandbox="allow-scripts allow-same-origin"`. Tradeoff (accepted for POC): with `srcdoc` the frame runs on the app's origin, so the third-party CDN bundle + rendered collection content can reach the app's session/localStorage — an XSS-into-app-origin surface. **Beta hardening (documented, not done):** serve the host page from a separate origin (bruno-backend) so `allow-same-origin` is safe.
- **R-B — staging CDN instability / external egress.** `staging.cdn.opencollection.com` is a moving, unpinned staging asset (~4.5MB `docs.js`), an external egress that conflicts with the POC's self-contained stance, will 404/500 intermittently, and breaks air-gapped installs. Accepted per D-F (given). Mitigation deferred to a future pin/self-host phase.
- **R-C — CSP dev-vs-prod divergence.** The `yarn start` live-check passes even if the CSP block is wrong (dev frontend has no helmet CSP), then a production `app-backend` build silently blocks the CDN. Mitigation: the executor should eyeball the `app-config.yaml` block against the effective-directives table above, and (if prod matters) mirror into `app-config.production.yaml`. A wrong `script-src` (e.g. forgetting `'unsafe-inline'` or the redirect host) fails only in prod.
- **R-D — dead-code removal completeness.** The seven-file island is grep-confirmed closed at HEAD `b7ef2f3`; if the executor is on a later commit that added a new importer of any island file, the tsc gate will catch a dangling import. Re-run the watch-list #4 grep after deletion.
- **R-E — secrets in rendered docs (ties to P4 D-D / NEXT-STEPS R9).** The YAML already redacts auth + env secrets (P4 D-D); header/param/body values are NOT redacted (P4 R-D). Those render in the iframe exactly as they did in the deleted native viewer — **no regression**, but note the surface persists.
- **R-F — theme-toggle re-mount cost.** Rebuilding `srcDoc` on theme toggle forces the iframe to reload `docs.js` (~4.5MB) from the CDN each toggle (no HTTP cache guarantee on staging). Acceptable for a POC; noted.

## Gates (authoritative — NOT backstage-cli build)
```
yarn tsc                                                              # 0 errors, repo-level
yarn lint:bruno plugins/bruno/src/components/CollectionDocs plugins/bruno/src/lib   # NEW code clean
```
Baseline note (judge NEW errors only): `yarn lint:bruno plugins/bruno/src/components/CollectionDocs plugins/bruno/src/api` reports **0 errors** at HEAD `b7ef2f3` (clean baseline). The new `OcDocsFrame.tsx` + the barrel repoint must introduce **zero** new errors; the seven deletions can only reduce lint surface. `app-config.yaml` is not linted by `lint:bruno`. No tests. No new deps.
