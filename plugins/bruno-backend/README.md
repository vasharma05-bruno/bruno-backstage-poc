# @usebruno/bruno-backend-plugin-poc

Backend plugin for the **Bruno for Backstage** POC. It loads Bruno collections
(from the local filesystem or a GitHub URL), parses `.bru` files with
[`@usebruno/lang`](https://www.npmjs.com/package/@usebruno/lang) into a clean
`NormalizedCollection` model, serves them over HTTP, generates self-contained
Collection Docs HTML, and materializes each collection as a `kind: API` catalog
entity.

Built for the **new Backstage backend system** (Backstage v1.53).

## Installation

This package is wired into `packages/backend/src/index.ts`:

```ts
// The Bruno backend plugin (serves /api/bruno/*)
backend.add(import('@usebruno/bruno-backend-plugin-poc'));

// The catalog module that materializes API entities from Bruno sources
import { brunoCatalogModule } from '@usebruno/bruno-backend-plugin-poc';
backend.add(brunoCatalogModule);
```

> The default export is the plugin; `brunoCatalogModule` is a named export.

## Configuration

Add a `bruno:` block to `app-config.yaml`:

```yaml
bruno:
  sources:
    - id: echo-demo
      name: Echo Demo
      type: local
      # relative to the Backstage working dir / packages/backend / repo root
      target: ../../sample-collections/echo-demo
    - id: my-private-api
      name: My Private API
      type: url
      # a GitHub tree/blob URL; creds come from integrations.github
      target: https://github.com/acme/apis/tree/main/collections/my-api
  schedule: # optional; controls the catalog provider refresh
    frequencySeconds: 60
    timeoutSeconds: 30
```

- **`type: local`** — `target` resolves against the Backstage working dir, then
  `packages/backend/<target>`, then the repo root. The sample collections live
  at `<repoRoot>/sample-collections/*`.
- **`type: url`** — `target` is fetched with Backstage's `UrlReaderService`
  (`readTree`). GitHub credentials are taken from Backstage's
  `integrations.github` config.

## HTTP API

Base path: `/api/bruno` (the frontend resolves it via
`discoveryApi.getBaseUrl('bruno')`).

| Method & path                | Returns                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /health`                | `{ status: 'ok' }`                                                                          |
| `GET /collections`           | `Array<{ id, name, requestCount, source: 'local'\|'url', sourceUrl? }>`                     |
| `GET /collections/:id`       | `{ id, name, source, sourceUrl?, requestCount, collection: NormalizedCollection }` (404 if unknown) |
| `GET /collections/:id/docs`  | `text/html` — a fully self-contained Collection Docs page (Scenario B)                      |
| `POST /refresh`              | Re-reads and re-parses all sources; returns `{ status: 'ok', collections: <n> }`            |

`/health` and `/collections` (and its sub-paths) are registered as
**unauthenticated** for the POC so the docs can be linked out or embedded
without a Backstage session.

### `NormalizedCollection`

See `src/types.ts`. This is our own model (not `@opencollection/types`) parsed
directly from `.bru`. It preserves: method, url, headers, query/path params,
body (mode + raw/form), auth (mode + fields), docs, pre/post scripts, tests,
assertions, and environments with variables. `requestCount` is the recursive
count of `http`/`graphql` items.

## Catalog entities

The `brunoCatalogModule` installs a `BrunoEntityProvider` that, on a schedule,
emits one entity per source:

- `kind: API`, `spec.type: bruno-collection`, `spec.lifecycle: experimental`,
  `spec.owner: guests`
- `metadata.name` = sanitized source id, plus `title` / `description` derived
  from the collection name and request count
- annotations `usebruno.com/collection-id`, `usebruno.com/collection-path`,
  `usebruno.com/source-url` (url sources only), and
  `backstage.io/managed-by-location` / `managed-by-origin-location` set to a
  `bruno-provider:` location key

The frontend card and Collection Docs tab attach when
`spec.type === 'bruno-collection'`.

## RISK #1 — credential isolation

For `type: url` sources, the collection tree is fetched **server-side** by
Backstage's `UrlReaderService`. The GitHub token is supplied by Backstage's
`integrations.github` config and applied inside the backend; **it never leaves
the backend**. No route returns the token, and none of the HTTP responses (or
generated HTML) contain credentials — the only network egress is
Backstage → GitHub. See the code comment on `readUrlTree` in
`src/service/collectionService.ts`. The Scenario-B HTML additionally masks
secret-looking auth fields (password/token/secret) so generated docs never
surface raw secret values.

## `@usebruno/lang` usage

- `bruToJson(text)` — parses a request `.bru`. Returns a merged object with
  `meta {name,type,seq}`, `http {method,url,body,auth}` (where `http.body` /
  `http.auth` hold the **mode** string), `headers[]`, `params[]`, `body {...}`,
  `auth {...}`, `script {req,res}`, `tests`, `docs`, `assertions[]`.
- `collectionBruToJson(text)` — parses `collection.bru` / `folder.bru`
  (`meta`, `headers`, `auth`, `script`, `tests`, `docs`).
- `bruToEnvJson(text)` — parses `environments/*.bru`. Returns
  `{ variables: [{ name, value, enabled, secret }] }`.
