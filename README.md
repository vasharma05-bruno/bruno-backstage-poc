# Bruno for Backstage — POC

A [Backstage](https://backstage.io) app that integrates
[Bruno](https://www.usebruno.com) API collections into the software catalog as a
first-class entity kind: **`kind: Bruno`**, `apiVersion: usebruno.com/v1alpha1`.

A Bruno collection lives in source control as `.bru` files (or an
`opencollection.yml`). This POC reads that folder, generates an OpenCollection
`1.0.0` document from it, stores the document on a catalog entity the way
`kind: API` stores an OpenAPI document, and renders it in Backstage — with the
collection linked to the API entities it documents.

## The two plugins

| Package | What it does |
| --- | --- |
| [`plugins/bruno-backend`](plugins/bruno-backend/README.md) | Reads collection folders through Backstage's `UrlReaderService`, generates and caches the OpenCollection document, materializes `kind: Bruno` entities from `bruno.collections[]` and from the UI, teaches the catalog the kind, serves the rendered docs page, and owns the write model for UI-created collections. Serves `/api/bruno/*`. |
| [`plugins/bruno`](plugins/bruno/README.md) | The UI: a Bruno Collections dashboard at `/bruno`, the add-collection flow, the entity page for a collection (documentation, environments, related APIs, API docs), and a card on API entity pages listing the collections that document them. |

Both are wired into this app already — `packages/backend/src/index.ts` and
`packages/app/src/App.tsx`.

## Running it

```sh
yarn install
yarn start
```

Frontend on <http://localhost:3000>, backend on <http://localhost:7007>.

Configuration lives in [`app-config.yaml`](app-config.yaml) — the `bruno:` block
for collections and schedules, `integrations.*` for the credentials the backend
reads repositories with, and `catalog.rules` / `catalog.locations` for what the
catalog will accept and where the sample entities come from. The default dev
database is in-memory SQLite, so nothing survives a restart.

## Where to look next

- [`plugins/bruno/README.md`](plugins/bruno/README.md) — frontend extensions, the
  entity accessors, and the add/link/unlink flows.
- [`plugins/bruno-backend/README.md`](plugins/bruno-backend/README.md) — config
  reference, HTTP routes, what goes on the entity, and credential handling.
- [`docs/TECHNICAL-DESIGN.md`](docs/TECHNICAL-DESIGN.md) — the architecture
  study and technical design (BRU-4488): both PoCs synthesized, a
  recommendation per scope area, the setup guide, and the risks register.
  **Start here** for *why* the architecture is what it is.
- [`docs/`](docs/) — the PRD (`Bruno Backstage Plugin PRD - Entity.md`) and the
  per-phase execution plans under `docs/execution/`.
- [`scripts/bruno-catalog/README.md`](scripts/bruno-catalog/README.md) — the
  separate generator that turns Bruno collections into `kind: API` fixtures with
  OpenAPI definitions, used for the sample catalog data.
