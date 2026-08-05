# @usebruno/plugin-bruno

Bruno for Backstage — **frontend** plugin (POC). Built on the **new Backstage
frontend system** (Backstage v1.53.0) using blueprints from
`@backstage/frontend-plugin-api` and `@backstage/plugin-catalog-react/alpha`.

Pairs with the `bruno` **backend** plugin. See
[`docs/POC-DECISIONS.md`](../../docs/POC-DECISIONS.md) §3 for the shared API
contract and the `NormalizedCollection` type.

## What it provides

| Extension | Blueprint | Attaches to |
|---|---|---|
| `bruno/api:bruno` | `ApiBlueprint` | app APIs — registers `brunoApiRef` (`BrunoClient`) |
| `bruno/entity-card:collection` | `EntityCardBlueprint` (catalog-react/alpha) | entity page, filter `kind:api && spec.type == 'bruno-collection'` |
| `bruno/entity-content:docs` | `EntityContentBlueprint` (catalog-react/alpha) | entity page tab **"API Docs"** at `/bruno-docs`, same filter |

### `brunoApi` (`src/api/`)
`brunoApiRef` + `BrunoClient` implementing `getCollections()`,
`getCollection(id)`, `getDocsUrl(id)`. Deps: `discoveryApiRef` + `fetchApiRef`.
Base URL resolved via `discoveryApi.getBaseUrl('bruno')`.

### `BrunoCard` (`src/components/BrunoCard/`)
Entity card. Reads `bruno.dev/collection-id` and `bruno.dev/source-url`
annotations, fetches the collection detail for name + request count, links to
the source, and renders **Open in Bruno**.

### Open in Bruno (`src/components/OpenInBruno/`)
Split button. Primary action fires the intended `bruno://open?url=...` deep
link (format centralized in `src/lib/brunoLink.ts`). Because today's Bruno
desktop only handles `bruno://app/oauth2/callback` (no open/clone verb — a
documented Beta gap, POC-DECISIONS D3/Q3), the dropdown offers
**"Clone & open in Bruno"** which copies a `git clone <repo>` + open
instruction. A tooltip notes the Beta dependency.

### Collection Docs viewer (`src/components/CollectionDocs/`)
Native React viewer (built from scratch — **not** `@opencollection/docs`, per
D2). Two panes: left = folder/request tree with color-coded method badges;
right = request detail with tabs Headers / Params / Body / Auth / Docs / Tests
/ Try it out.

**Try it out** resolves `{{var}}` templates from the collection's first
environment (`src/lib/template.ts`), then routes the request through the
Backstage **proxy** for CORS safety (`src/lib/proxy.ts`,
`resolveViaProxy(url)`). Unknown hosts fall back to a direct fetch and any
CORS/network error is surfaced in the UI.

## Enabling it in the app

`packages/app/src/App.tsx` uses `createApp` from `@backstage/frontend-defaults`.
Add the default export to `features`:

```ts
import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import brunoPlugin from '@usebruno/plugin-bruno';
import { navModule } from './modules/nav';

export default createApp({
  features: [catalogPlugin, navModule, brunoPlugin],
});
```

## Required app-config

### Backend discovery
The client resolves the backend via `discoveryApi.getBaseUrl('bruno')`; no
extra frontend config needed as long as the `bruno` backend plugin is running.

### Proxy endpoints (for "Try it out")
Add under `proxy.endpoints` in `app-config.yaml` (and mirror hosts in
`PROXY_HOST_MAP` in `src/lib/proxy.ts`):

```yaml
proxy:
  endpoints:
    '/bruno-echo':
      target: 'https://echo.usebruno.com'
      changeOrigin: true
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
```
