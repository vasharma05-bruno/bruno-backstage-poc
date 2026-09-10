# @usebruno/bruno-backend-plugin-poc

Backend plugin for the **Bruno for Backstage** POC. It materializes Bruno
collections as first-class **`kind: Bruno`** catalog entities
(`apiVersion: usebruno.com/v1alpha1`), generates an OpenCollection `1.0.0`
document for each one and stores it inline on the entity, renders that document
as an embeddable HTML page, and owns the write model for collections added from
the Bruno dashboard.

Built for the **new Backstage backend system** (Backstage v1.53).

The shape of the plugin follows from one constraint: **the catalog is a read
model with no write model.** Entities come from a Location (a descriptor that
must already exist somewhere a reader can fetch) or from an EntityProvider —
there is no insert-an-entity API anywhere in Backstage. So everything a UI wants
to know about a collection that *already exists* travels on the entity and is
read through the catalog, and this plugin is left with the things an entity
cannot carry:

- a **rendered document**, which needs an origin whose Content-Security-Policy
  admits the OpenCollection renderer bundle;
- a read of a repository that is **not catalogued yet**, which a browser cannot
  perform because the credentials live here;
- **bringing a collection into existence**, and taking one back out — which is
  why this plugin has a database again, and why the catalog is downstream of it.

## Installation

Wired into `packages/backend/src/index.ts`:

```ts
// The Bruno backend plugin (serves /api/bruno/*)
backend.add(import('@usebruno/bruno-backend-plugin-poc'));

// The catalog module: the kind: Bruno processor + the entity provider
import { brunoCatalogModule } from '@usebruno/bruno-backend-plugin-poc';
backend.add(brunoCatalogModule);
```

> The default export is the plugin; `brunoCatalogModule` is a named export.

The two are separate backend features with no wiring between them, which is why
each builds its own `ManifestProbe` (`src/plugin.ts`, `src/module.ts`). Sharing
one in process would be wrong on a multi-replica deployment anyway; the cost is
one duplicated tree read the first time a scanned collection is then ingested,
and every check after that is a revalidation — see
[Fetching and caching](#fetching-and-caching) for the two tiers.

`catalog.rules` must also allow the `Bruno` kind for the locations that carry
Bruno entities. `catalog.rules` only *permits* a kind, though — it does not
define one; recognition comes from `BrunoKindProcessor.validateEntityKind`.

## Configuration

Everything lives under a single `bruno:` root key in `app-config.yaml`. Keep it
that way: nested under `proxy:` (an easy mistake, since YAML is happy either way)
the `schedule` block silently re-parses as `proxy.schedule` and the provider
falls back to its defaults with zero collections.

```yaml
bruno:
  collections:
    - type: url
      url: https://github.com/acme/apis/tree/main/collections/payments
      # Optional. Default is the last path segment of `url`.
      name: payments
      owner: guests
      partOf:
        - api:default/payments-api
  # Autodiscovery. Optional, and off when absent.
  discovery:
    - organization: acme
      host: github.com
      repositoryPattern: '.*-api'
      excludePathPattern: '(tests|examples)/.*'
      owner: guests
      deferToCatalogInfo: true
  # Let the dashboard add collections, and link them to APIs, in THIS
  # instance rather than in source control. Off when absent.
  allowRuntimeWrites: true
  definition:
    maxBytes: 1048576
  cacheTtlSeconds: 60
  schedule:
    frequencySeconds: 60
    timeoutSeconds: 30
```

Read by [`src/service/brunoConfig.ts`](src/service/brunoConfig.ts) and
[`src/service/schedule.ts`](src/service/schedule.ts); declared in
[`config.d.ts`](config.d.ts).

| Key | Default | Meaning |
| --- | --- | --- |
| `bruno.collections[].type` | — | Only `url` is supported. Any other value is logged and the entry skipped. |
| `bruno.collections[].url` | — | The collection **folder** in source control — a tree or blob URL on a host configured under `integrations`. |
| `bruno.collections[].name` | last path segment of `url` | `metadata.name` override. Not part of the PRD's config shape; a documented superset, for when two collections would otherwise collide or a folder gets renamed. |
| `bruno.collections[].owner` | — | Entity ref for `spec.owner`. Unprefixed values default to a Group. Without it a configured collection has no `ownedBy` relation and reads as unowned. |
| `bruno.collections[].partOf` | `[]` | Entity ref(s) for `spec.partOf`. A bare string is accepted and treated as a one-element list — the PRD writes it singular, the entity contract is plural. |
| `bruno.discovery[].organization` | — | GitHub organization to sweep. A **user login** works too: the sweep falls back to the user endpoint when the organization endpoint 404s. |
| `bruno.discovery[].host` | `github.com` | SCM host. Anything but public `github.com` needs an `integrations.github` entry. |
| `bruno.discovery[].repositoryPattern` | every listed repo | **Anchored** regex over the repository *name*: `payments` matches `payments` and not `payments-legacy`. Compiled when the config is read, so a bad pattern drops that entry alone. |
| `bruno.discovery[].excludePathPattern` | — | **Anchored** regex over a collection's repo-relative path (`''` at the repository root). Excludes collections a sweep finds but nobody publishes — test fixtures, examples. |
| `bruno.discovery[].owner` | — | `spec.owner` for everything this entry finds. Nothing in a repository states who owns a collection, so without it discovered collections read as unowned. |
| `bruno.discovery[].deferToCatalogInfo` | `true` | Leave a collection that already has a `kind: Bruno` `catalog-info.yaml` to that descriptor — see [Autodiscovery](#autodiscovery). |
| `bruno.allowRuntimeWrites` | `false` | Whether the UI's **Add collection** and **Link in this Backstage instance** are available — i.e. whether this backend's own database may declare a catalog entity or a relation. Gates `POST /collections` and `POST /links` (403 when off), and is `@visibility frontend` so the browser hides both. The pull-request half of each flow is unaffected. See [Runtime writes](#runtime-writes). |
| `bruno.cacheTtlSeconds` | 60 | How long a fetched collection stays cached before the probe revalidates it. Also the upper bound on how long a catalog Sync takes to show new content. |
| `bruno.definition.maxBytes` | 1048576 | Hard cap on the YAML stored on an entity. Over the cap the definition is **omitted, never truncated**, and the entity is annotated. |
| `bruno.schedule.frequencySeconds` | 60 | The provider's tick — and therefore the latency of both the dashboard's add and its remove. |
| `bruno.schedule.timeoutSeconds` | 30 | Per-run timeout. |

Reading is **tolerant per entry**: a malformed collection entry is logged and
skipped, never thrown. This runs inside a scheduled provider task, and letting
one bad entry reject the read would leave every *other* configured collection
unpublished on that tick and every tick after it. `bruno.definition` and
`bruno.cacheTtlSeconds` are equally tolerant because they are read during module
init, where a mistyped knob must degrade to the default rather than take the
backend down at boot.

There is deliberately **no redaction knob** — see
[Credential isolation](#credential-isolation) for why.

Collection folders are read through Backstage's `UrlReaderService` using the
host's `integrations.*` credentials, and nothing else. Public `github.com`,
`gitlab.com` and `bitbucket.org` need no configuration at all
(`@backstage/integration` appends a default entry for each); a private repository
on any host needs the matching `integrations` block, because there is no per-user
read path — see [Credential isolation](#credential-isolation). Provider-specific
URL grammar and credential handling live under [`src/scm/`](src/scm/).

## HTTP API

Base path `/api/bruno` (the frontend resolves it via
`discoveryApi.getBaseUrl('bruno')`). Routes are built in
[`src/service/router.ts`](src/service/router.ts); the auth policies are declared
in [`src/plugin.ts`](src/plugin.ts).

| Method & path | Auth | Returns |
| --- | --- | --- |
| `GET /health` | unauthenticated | `{ status: 'ok' }` — a liveness probe with no data. |
| `POST /collections/probe` | `user` | `{ found: true, format, manifestPath, name?, version?, description? }`, or `{ found: false, reason: 'no-manifest' }` (200), or `{ found: false, reason: 'unreadable', message }` (400). |
| `POST /collections` | `user` | Body `{ url, name, title?, owner?, partOf? }`. `201` with `{ name, title?, namespace, entityRef, url, refreshSeconds }`. **403** unless `bruno.allowRuntimeWrites`. `partOf` refs are normalised and must exist in the catalog. A blank `title` is stored as NULL, not as `''` — see below. |
| `GET /collections` | `user` \| `service` | `{ collections, refreshSeconds }`. A **user** principal gets rows with `createdBy` omitted. |
| `DELETE /collections/:name` | `user` | `{ deleted: true, name, refreshSeconds }`, or `404` when no stored row exists. |
| `GET /links` | `service` | `{ links }` — every runtime link in the instance, for `BrunoKindProcessor`. |
| `POST /links` | `user` | Body `{ collectionRef, apiRefs }`. `201` with `{ linked: true, collectionRef, apiRefs, refreshRequested }` — all of the refs or none. **403** unless `bruno.allowRuntimeWrites`. |
| `DELETE /links?collection=&api=` | `user` | `{ unlinked: true, collectionRef, apiRefs, refreshRequested }`, or `404` when no such row exists. |
| `GET /entities/:namespace/:name/docs` | `user-cookie` | `text/html` — the OpenCollection docs page for that entity. `?theme=light\|dark`. |

**The probe's three outcomes are deliberately not three status codes.**
`no-manifest` is a `200` because the read *succeeded* — the answer is simply no,
and the dialog renders it as a field-level message rather than a failure. Only an
unreadable URL is a 4xx, and its `message` is the backend's own diagnostic, which
is the only actionable thing for a missing `integrations` entry or a revoked
token. The probe has to run server-side: `catalogImportApi.analyzeUrl` looks for
a `catalog-info.yaml`, which is precisely the file that does not exist yet at
that point in the flow, and a browser cannot read a private repository at all.

**`POST /collections` excludes services on purpose.** It is a user-initiated
write whose `created_by` is read straight off the principal; the provider only
ever *reads*. Admitting `['service']` would let any plugin holding a plugin token
mint catalog-visible entities with no user attribution.

**`GET /collections` requires `service`** — that was its original point. The
provider calls it with a plugin token, and without `'service'` in the allow-list
every tick is a 403 and no UI-created collection ever reaches the catalog.
`'user'` was added later for the dashboard's pending strip, with `createdBy`
stripped: that omission is what makes the widening safe, since every remaining
field is about to be public on a catalog entity a minute from now.

**The `/links` routes mirror the `/collections` ones, one level down.** A
relation cannot be written into the catalog either — relations are derived
output, recomputed and rewritten on every stitch — so a link has exactly two
durable homes: `spec.partOf` in a file, or a row here. `GET /links` is
`service`-only for the reason `GET /collections` originally was: the processor is
the reader it exists for, and a browser needs no such list — what it needs is
which APIs are linked to the collection *it* is looking at, and that arrives on
the entity as `usebruno.com/runtime-part-of`. `POST` and `DELETE` are `user`-only,
like `POST /collections`, because `created_by` is read off the principal.

Both writes then call `catalog.refreshEntity` for the collection and report
whether it worked as `refreshRequested`. That is what makes a runtime link feel
like a link: without it the processor would not run again for a full processing
interval, so the user would click Link and watch nothing happen. A failed
refresh is reported rather than thrown — the row is written either way, so the
change is slow, not wrong, and the dialog says which.

**`POST /links` takes a LIST of API refs and `DELETE` takes one**, which
matches the screens: the collection-side dialog picks several APIs at once and
they all land in the same `partOf`, so one call is one refresh and one
all-or-nothing outcome, while unlinking is a per-row action on both cards. The
rows go in with a single multi-row `insert`, so a unique violation on any pair
fails the statement rather than leaving half a selection. Every 409 and 404 on
the route *names* the offending refs — with six APIs picked, "one of them is
already linked" is not an answer anyone can act on — which is why the route
pre-checks the table instead of leaving it to the insert, whose unique violation
cannot say which pair caused it.

**The refs travel in the query string on the `DELETE`.** They are entity refs,
which contain `:` and `/`; percent-encoding those into a path segment works but
is the kind of thing a proxy in front of the backend decodes early and then
routes wrong. A body on a `DELETE` is the other option and is worse — widely
dropped in transit.

**The docs route is reached by an iframe `src`**, a browser GET with no
Authorization header, so it cannot use bearer auth. `httpRouter.addAuthPolicy`
allows the Backstage limited-access **user-cookie** on that exact path (matching
is prefix-based and additive, so it covers `/entities/<ns>/<name>/docs*` and
nothing else). The route then reads the catalog **as the requesting user**, so it
can never surface a collection the caller could not read from the catalog itself.
It also sets its own embedding headers *before* any error branch — removing
`X-Frame-Options` and replacing the CSP with one scoped to the document — so
every error page is framable too; otherwise the user gets a cryptic "refused to
connect" instead of the message. Errors on this route are HTML documents rather
than JSON for the same reason.

### POC-scope security notes

Called out in the route comments rather than fixed, and repeated here so they are
not discovered by surprise:

- Any authenticated user may ask the backend to read **any URL its integrations
  can reach** (`/collections/probe` and `/collections`). That is an SSRF surface
  and a private-repository existence oracle.
- Any authenticated user may add a collection everyone else then sees, and may
  **delete any** UI-created collection: `created_by` is recorded and *not*
  enforced (IDOR). Beta hardening is a permission plus an ownership check.
- The same applies to runtime links: any authenticated user may link any
  collection to any API entity **they can read** — the routes resolve both
  entities as the requesting user, so visibility is inherited from the catalog —
  and may then remove any runtime link in the instance. `created_by` is recorded
  and not enforced there either.
- The docs CSP allows `https:` broadly rather than pinned hosts, because the
  renderer bundle lazy-loads from several CDNs. Beta hardening is to pin them and
  serve the route from a dedicated origin.

## What goes on the entity

There is no `NormalizedCollection` on the wire. That type
([`src/types.ts`](src/types.ts)) is the **internal** model the `.bru` parser
produces and the OpenCollection exporter consumes — it never leaves the backend.
What a consumer sees is the entity:

| Field | Written by | Notes |
| --- | --- | --- |
| `spec.definition` | `BrunoKindProcessor` | The generated **OpenCollection `1.0.0` YAML** for the whole collection, stored inline exactly as `kind: API` stores an OpenAPI document. Absent when generation failed or the cap was exceeded. |
| `spec.requestCount` | `BrunoKindProcessor` | Executable requests. Reported **even when the definition was omitted for size**, so the dashboard's counts do not go blank on the largest collections. |
| `spec.environments` | `BrunoKindProcessor` | Environment **names**, as a string array — the catalog indexes one search row per item, so a facet query can count unique environments across all collections. A comma-joined string would group as one opaque value. |

All three are derived and are overwritten unconditionally whenever generation
succeeds — nobody hand-writes an OpenCollection document into a
`catalog-info.yaml`, and letting a stale authored value win would make Sync a
permanent no-op. When generation *fails*, whatever was there is left alone: a
transient outage or one bad push must not blank a definition that was good a
cycle ago. Note the deliberate asymmetry with `metadata` — an authored
`title`/`description`/`version` **wins** over the fetched value.

None of the three is in `spec.required`, and `definition` carries no `minLength`
(unlike `kind: API`, which requires its `definition`). A degraded Bruno entity —
unreachable repo, missing manifest, over the size cap — must still validate,
because a validation failure makes the processing run `ok: false`, which abandons
stitching and deletes the entity outright.

The pipeline is `readTree` → parse → `brunoToOpenCollection` → YAML, in
[`src/service/definitionBuilder.ts`](src/service/definitionBuilder.ts). It
**never throws**: a collection that cannot be parsed degrades to an entity
without a definition, not to no entity. Over the cap the definition is omitted
rather than truncated — a truncated YAML document is invalid, so a renderer would
fail with a parse error instead of showing the reader why the content is missing;
the reason is stamped as an annotation instead. Generation is deterministic and
carries no timestamp, or the entity would be rewritten and re-stitched on every
100–150 s reprocess cycle.

## Catalog entities

`brunoCatalogModule` ([`src/module.ts`](src/module.ts)) installs two things.

**[`BrunoKindProcessor`](src/processor/BrunoKindProcessor.ts)** teaches the
catalog about `kind: Bruno` and enriches every such entity, whether it came from
an authored `catalog-info.yaml` or from the provider. Enrichment happens in
`preProcessEntity`, so the result is still subject to the entity policies and to
`validateEntityKind`; relations are emitted from `postProcessEntity`, matching
`BuiltinKindsEntityProcessor`, so no relation is emitted for an entity that later
fails validation. It is also what makes Sync work at all — a catalog refresh
re-runs processors and never providers, so generation has to live here for both
entry points to converge on it.

`apiVersion` is `usebruno.com/v1alpha1`, deliberately **not**
`backstage.io/v1alpha1`: that namespace is reserved for kinds Backstage itself
ships, and squatting it means an upstream kind named `Bruno` would silently
collide.

**[`BrunoCollectionEntityProvider`](src/provider/BrunoCollectionEntityProvider.ts)**
materializes one entity per `bruno.collections[]` entry **and** per collection
added from the UI, on the `bruno.schedule` tick. Entities are written unprocessed
and flow through the identical processing loop as authored ones. Only *identity*
differs: `metadata.name` cannot be supplied by a processor — the catalog freezes
the entity ref before any processor runs and throws a `ConflictError` if one
changes it — so it is derived here from the URL's last path segment.

It makes **no SCM request**. `description` and `version` are left to the
processor, which derives both from its own probe; stamping them here as well
meant a duplicate tree read per collection per tick for values that were being
computed regardless. The visible cost is that a newly emitted collection shows
its `metadata.name` until the first processing run, which follows within seconds.

`metadata.title` is the one exception, and it costs no read: a UI-created row can
carry an **authored** title, chosen in the add-collection dialog and stored in
`bruno_ui_collections.title`, so it is the operator's own field in the way
`owner` and `partOf` are. It is stamped when the row has one and omitted when it
does not — which leaves the processor's `keep(authored) ?? manifest.name` to
derive it, exactly as for an authored descriptor with no `title:`. Configured and
discovered collections never have one: config has no `title:` key and a sweep has
nothing to read one from, so for those the manifest is the only answer.

### `spec`

| Field | Source |
| --- | --- |
| `type` | always `bruno-collection` from the provider; required on an authored entity |
| `url` | **required** — the collection folder that gets fetched |
| `owner` | config / descriptor; emits `ownedBy` / `ownerOf`, default kind `Group` |
| `partOf` | config / descriptor; emits `partOf` / `hasPart` pairs, default kind `API` |
| `definition`, `requestCount`, `environments` | derived — see above |

An unparseable `spec.owner` or `spec.partOf` entry is **logged and skipped**, not
thrown: an unguarded throw becomes `ok: false`, and on first ingestion the entity
would never land at all rather than merely losing one relation.

### Annotations

| Annotation | Written by | Meaning |
| --- | --- | --- |
| `usebruno.com/origin` | provider (`config`/`ui`/`discovery`), processor (`file`/`descriptor`), or the descriptor itself | How the collection got into the catalog — see below. |
| `usebruno.com/definition-omitted` | processor | `size` (over `bruno.definition.maxBytes`) or `error` (the collection could not be read/converted). Deleted again once a definition is stored, so an over-cap collection that later shrinks stops claiming to be omitted. |
| `usebruno.com/definition-bytes` | processor | How big the omitted document would have been. |
| `usebruno.com/runtime-part-of` | processor | The API refs linked to this collection **in this instance** rather than in source control — comma-separated, canonical, sorted. Derived from `bruno_runtime_links`; deleted again when the last link goes, and an authored value is discarded rather than honoured. |
| `backstage.io/source-location` | processor / provider | The collection **folder**, `url:<normalized>/`. |
| `backstage.io/managed-by-location`, `…-origin-location` | provider | A real `url:` ref to the collection folder, not a synthetic `bruno-provider:` one — that is what makes the About card's native Refresh button appear, and it is safe because `readLocation` only dereferences `kind: Location` entities. |

`usebruno.com/origin` has five values, and it exists because the frontend used to
guess by asking whether `managed-by-location` ended in `.yaml`. That guess is
right for every case we ship and wrong for two we cannot rule out: a descriptor
served from a URL with no YAML suffix, and a collection added from the Bruno
dashboard, whose folder location is indistinguishable from a
`bruno.collections[]` entry's — the same "no descriptor" answer, but a different
thing to edit.

| Value | Written by | What has to be edited to change the collection |
| --- | --- | --- |
| `config` | the provider, for a `bruno.collections[]` entry | `app-config.yaml`; there is no descriptor file anywhere |
| `ui` | the provider, for a collection added from the dashboard's **Add collection** | the store row; like `config` there is no descriptor file anywhere, so no pull request can be opened against one. The dashboard's Remove action is offered |
| `discovery` | the provider, for a collection swept out of a `bruno.discovery[]` organization | nothing local: it is re-derived from source control every tick. Authoring a `kind: Bruno` `catalog-info.yaml` in the repository takes the collection over, because discovery defers to one |
| `file` | the processor, for a `catalog.locations` entry of `type: file` | the file on the Backstage host's disk; it is not in an SCM and cannot take a pull request |
| `descriptor` | the processor, by default | the hand-authored `catalog-info.yaml` in source control |

An existing value always wins (`deriveOrigin`), and that is what makes the scheme
work with one annotation instead of three: the provider stamps `config`, `ui` and
`discovery` on the unprocessed entity, and the processor only names the two cases
nobody else can. The descriptor the dashboard can generate instead stamps nothing,
because it is an ordinary authored descriptor. It follows that an authored
descriptor can claim an origin it does not have — accepted, since the file is the
operator's own and a wrong value costs nothing worse than misdirected advice in a
dialog.

The value is a pure function of how the entity was created and never changes for
a given entity, so — unlike, say, a source commit sha — stamping it cannot churn
`resultHash` and re-stitch the entity every cycle.

### Name collisions

The provider iterates **config entries first, then UI-created ones, then
discovered ones**, and the claim guard is first-wins, keyed on the
**lower-cased** name (an entity ref is lower-cased when stringified, so
`Payments` and `payments` are one entity). Config wins because
`app-config.yaml` is the operator's file and cannot be edited from the UI,
whereas a UI-created collection can be renamed by whoever made it. Discovery is
swept last, so it always loses: a discovered entry is re-derived every tick, so
dropping it strands nothing and it reappears by itself once whatever shadowed it
is gone. The log line names both sides and gives advice specific to which origin
lost. `POST /collections` pre-rejects the same collision at write time so it is
normally caught with a message rather than silently here.

A **discovered duplicate of an already-catalogued URL** is not a collision at
all: a sweep cannot see the other two sources, so the same collection being
configured *and* discovered is expected. Those are dropped quietly by URL
(before the probe runs, so they cost no tree read) and counted separately in the
provider's summary line.

## Runtime writes

Two of this plugin's flows make its own database, rather than a reviewed file
in a repository, the source of truth for something the catalog shows: adding a
collection from the dashboard, and linking one to an API in this instance. Both
are gated on a single key, `bruno.allowRuntimeWrites`, **off by default**.

That is one key rather than two because it is one decision. An operator who
does not want an entity to exist without a descriptor does not want a relation
to either, and separate keys would only offer a state where a collection can be
created but never linked.

| | `allowRuntimeWrites: false` (default) | `allowRuntimeWrites: true` |
| --- | --- | --- |
| Add a collection | Dashboard offers **Create pull request** only. `POST /collections` → 403. | Both endings. |
| Link an API | Link dialogs offer the pull request only; a collection with no editable descriptor cannot be linked from Backstage at all. `POST /links` → 403. | Both methods. |
| Remove / unlink | Still work. | Still work. |
| Everything else | Unchanged. | Unchanged. |

**The deletes stay open on purpose.** Turning the key off does not retract rows
that already exist — the provider keeps materialising stored collections and
the processor keeps emitting relations from stored links, every cycle — so
`DELETE /collections/:name` and `DELETE /links` have to outlive the permission
that created the row. Refusing them would strand exactly the state the operator
turned the key off to be rid of, with no way out but the database.

The key is `@visibility frontend` (declared in
[`plugins/bruno/config.d.ts`](../bruno/config.d.ts), because config schemas are
collected from the *app's* dependency graph), so the browser hides both flows
rather than rendering buttons that answer 403. The backend check is the
enforcement; the frontend one is the courtesy.

## Adding a collection from the UI

Available only with `bruno.allowRuntimeWrites` on — see
[Runtime writes](#runtime-writes).

The catalog has **no write model**. Entities come from a Location (a descriptor
that must already exist) or from an EntityProvider — there is no
insert-an-entity API. So "Add Bruno Collection" in the dashboard cannot write to
the catalog. It writes here instead, and `BrunoCollectionEntityProvider`
materialises the stored rows into `kind: Bruno` entities on its next scheduled
tick, exactly as it already does for `bruno.collections[]` entries.

**Table `bruno_ui_collections`** (`src/store/uiCollectionStore.ts`), created on
first boot, no formal migrations — but with one add-column-if-missing, for
`title`, which was added after rows existed:

| column       | notes                                                        |
| ------------ | ------------------------------------------------------------ |
| `name`       | `metadata.name` of the Bruno entity. Primary key.            |
| `title`      | Optional `metadata.title`. NULL means "no authored title".   |
| `url`        | The normalized collection folder URL.                        |
| `owner`      | Optional `spec.owner`.                                       |
| `part_of`    | `spec.partOf`, as a JSON array in a `text` column.           |
| `created_by` | Entity ref of the user who added it. Recorded, not enforced. |
| `created_at` | ISO timestamp.                                               |

`title` is nullable and never defaulted to `''`, because the two are different
instructions: NULL means the entity is emitted with no `metadata.title` at all,
which is what leaves `BrunoKindProcessor` deriving the display name from the
collection manifest on every cycle, while `''` would be an authored title that
displays as nothing. The route trims the field and collapses a blank one to
NULL, and caps it at 255 characters — `MAX_LABEL_LENGTH` in `manifestProbe.ts`,
the length a title *fetched* from a manifest is clamped to.

`part_of` is `text` holding JSON rather than a `json` column, because `text` is
the only column type whose read-back value is byte-identical on better-sqlite3
and on postgres — Knex's `table.json()` maps to a native `json` column on
postgres, where the driver parses it on read, forcing a dialect fork that can
only ever be exercised on one side at a time.

The three routes that back this flow are `POST /collections`,
`GET /collections` and `DELETE /collections/:name` — see
[HTTP API](#http-api) for their auth modes and the reasoning behind them.
`POST /collections` runs two duplicate-name checks with one meaning: another UI
collection, and a `bruno.collections[]` entry. Without the second, the create
would succeed and the entity would then never appear, because the provider's
first-wins guard skips the UI entry silently.

**Latency.** A collection added from the UI appears in the catalog — and a
deleted one disappears from it — within `bruno.schedule.frequencySeconds`
(default 60). That is the provider's tick, and it is the number every one of the
three routes returns as `refreshSeconds` so the UI can quote the real value.

**Dev-database caveat.** The default dev config (`app-config.yaml`) is
`better-sqlite3` with `connection: ':memory:'`, so UI-created collections **do
not survive a backend restart**. The catalog is equally ephemeral, so the two
stay consistent and nothing ends up inconsistent — but do not restart the
backend between creating a collection and checking that its entity appeared.

**A failed read of the store is never destructive.** The provider emits a `full`
mutation, which the catalog applies by set difference: anything the provider
emitted before and does not emit now is deleted. If the service-to-service read
of `GET /collections` fails and the process has no successful read cached, the
provider **skips the refresh entirely** rather than emitting the configured
collections alone — a config-only emission would delete every UI-created
collection in the instance. The cost is that configured collections are also not
refreshed on that tick.

**A per-collection skip, however, does remove that collection's entity**, and
for a UI-created one that matters more than it looks: the dashboard's Remove
action is gated on the entity's `usebruno.com/origin`, so a collection with no
entity is a stored row nothing in the product can reach. The provider therefore
does not skip a UI collection whose manifest has gone missing — it emits the
entity without collection metadata, so it stays removable, and logs why. The one
case left is a name that a `bruno.collections[]` entry claimed first: the
configured entry wins by design and cannot be overruled from here, so the
collection stays a stored row with no entity. That row is not stranded — the
dashboard's pending-collections strip shows it as **stalled** once it is past
`frequencySeconds * 2 + 30`, names both possible causes, and offers a Remove
that calls `DELETE /collections/:name` directly.

## Linking at runtime

The same argument as the section above, applied to **relations** instead of
entities. A catalog relation is derived output: the processors recompute it and
the stitcher rewrites it wholesale on every cycle, and
`plugin-catalog-backend`'s router exposes no relation-mutation endpoint. So a
link written straight into the catalog would be reverted within one processing
cycle, and the only durable homes for one are a file (`spec.partOf`) or a row
here.

The Bruno plugin's link dialog leads with a **pull request** against the
collection's `catalog-info.yaml`, because a link in source control is reviewable
and travels with the repository. A runtime link is the second option, and the
only one for a collection whose `partOf` cannot be edited by pull request at
all: a `bruno.collections[]` entry, a discovered collection, a `file:` location,
or a descriptor on a host other than GitHub.

That second option exists only with `bruno.allowRuntimeWrites` on — see
[Runtime writes](#runtime-writes). With it off those five cases have no route
at all from inside Backstage, which is the honest consequence of requiring
every link to live in a reviewed file, and the dialog says so rather than
offering a button that 403s.

**Table `bruno_runtime_links`** (`src/store/runtimeLinkStore.ts`), created on
first boot, no formal migrations:

| column           | notes                                                          |
| ---------------- | -------------------------------------------------------------- |
| `collection_ref` | Canonical ref of the Bruno collection, e.g. `bruno:default/payments`. |
| `api_ref`        | Canonical ref of the API entity, e.g. `api:default/orders`.     |
| `created_by`     | Entity ref of the user who made the link. Recorded, not enforced. |
| `created_at`     | ISO timestamp.                                                  |

The primary key is the **pair**, which is the whole integrity model: a link
either exists or it does not, there is nothing to update, and a second `POST` for
the same pair is a conflict rather than a duplicate row. Both refs are stored
canonical (`stringifyEntityRef` output, lower-cased component by component) by
one shared helper, [`src/service/entityRefs.ts`](src/service/entityRefs.ts) —
`spec.partOf` is written by hand, so `orders`, `api:orders` and
`api:default/orders` all key the same relation, and a link created under one
spelling and looked up under another could not be removed.

**How a row becomes a relation.** `BrunoKindProcessor` reads the whole link
table over HTTP on every processing cycle
([`src/processor/runtimeLinks.ts`](src/processor/runtimeLinks.ts), the same
service-to-service pattern the provider uses for stored collections), stamps
this collection's links on the entity as `usebruno.com/runtime-part-of` in
`preProcessEntity`, and emits `partOf`/`hasPart` from that annotation alongside
the ones `spec.partOf` declares. Re-deriving it every cycle is exactly what
makes the link survive the rewrite. The annotation is sorted, so re-ordering
rows in the table cannot churn `resultHash`; it changes only when a link does,
which is when the entity *should* be rewritten.

**The two kinds of link stay distinguishable**, and that is why the annotation is
not merged into `spec.partOf`. The relation is identical — every card that reads
relations shows both without knowing there are two kinds — but they are removed
in completely different ways, and a UI that could not tell them apart would
offer a pull request that removes a line no file contains. `POST /links` refuses
a link `spec.partOf` already declares for the same reason.

**There is no TTL cache on the link read**, deliberately. The reader is called
once per Bruno entity per cycle and the obvious optimisation is to cache the list
for a few seconds — but `POST /links` marks the collection for *immediate*
reprocessing, and a cache filled a moment before that write would answer the
reprocess with the old list, pushing the change out to the next full processing
interval. What is deduplicated instead is **concurrency**: overlapping calls
share one in-flight request, which collapses a sweep of a whole catalog into a
handful of reads without ever answering from a result that predates the caller.

**A failed read costs relations for one cycle, never more.** The processor keeps
the last set it read successfully in this process and emits that; with nothing
cached — the first cycle after a restart — it emits no runtime links and logs
once per failure streak. Unlike the provider's identical-looking problem this is
recoverable rather than destructive: the next cycle that can read the table
restores everything.

**Latency.** A runtime link appears (and a removed one disappears) within a few
seconds — `refreshEntity` plus one processing run — rather than within
`bruno.schedule.frequencySeconds`, which is the provider's tick and has nothing
to do with this path.

**Dev-database caveat**, as for UI-created collections: the default dev config is
`better-sqlite3` on `:memory:`, so runtime links do not survive a backend
restart. Neither does the catalog, so the two stay consistent.

Deleting a UI-created collection drops its runtime links with it
(`deleteForCollection`). The rows are keyed by entity ref and the entity is about
to stop existing, so leaving them would leave rows nothing can read or remove —
and a collection re-added under the same name would silently inherit the links of
the one it replaced.

## Autodiscovery

`bruno.discovery[]` sweeps organizations for `bruno.json` /
`opencollection.yml`/`.yaml` and emits a `kind: Bruno` entity per manifest
found, so a collection is catalogued by being pushed rather than by being
declared. Implemented in [`src/discovery/`](src/discovery/); it is the third
source of the same provider, and every entity it produces goes through the same
probe, the same guards and the same enrichment as a configured one.

### Why not Backstage's own autodiscovery

`GithubEntityProvider` will find any filename — `catalogPath` accepts a glob —
but what it emits is a `kind: Location` of `type: url` pointing **at the file**,
and the catalog then reads that file with the entity-descriptor parser. A Bruno
manifest has no `apiVersion`/`kind`, so every hit would land as a processing
error instead of an entity. The two seams that could bend that are both wrong
for a plugin to take: `CatalogProcessor.readLocation` keys on the location
*type*, which that provider hardcodes to `url`, and
`catalogModelExtensionPoint.setEntityDataParser` is a single global singleton
that would put this plugin in charge of parsing every descriptor in the catalog.
Emitting the entities directly costs one sweep and owns nothing else.

### What a sweep costs

One repository listing per entry per tick, plus one recursive tree call for each
repository whose `pushed_at` moved since the last sweep. That second clause is
what makes this viable on the 60-second default schedule: in a steady state an
organization of any size costs its listing alone, and only a repository somebody
pushed to is re-read. `pushed_at` covers pushes to *any* branch, so it
over-invalidates and never under-invalidates for the default branch — the
direction that matters. Archived and empty repositories are skipped without a
tree call at all.

Verified against the public `github.com/bruno-collections` org: 37 repositories
swept, 41 collections found, and a second sweep a moment later reused all 37
cached results with zero tree calls. Note the credential's rate limit, though —
that first sweep is 37 calls, and an **anonymous** reader gets 60 an hour, so
discovery of any real organization needs an `integrations.github` token (5000 an
hour). The sweep fails loudly when it runs out rather than emitting a short set.

GitHub's code-search API would replace the per-repo calls with one query, but it
is authenticated-only, indexes the default branch late, misses large
repositories and allows 30 requests a minute. A discovery source that silently
lags behind source control is worse than one that costs a tree call.

### What a sweep finds

Every collection in a repository, which includes ones nobody meant to publish: a
client library's `tests/fixtures/bru` holds a real `bruno.json` and nothing
about it says otherwise. The sweep of `bruno-collections` above found three such
fixture collections. `repositoryPattern` cannot exclude them, because the noise
is inside a repository that does belong in the sweep — that is what
`excludePathPattern` is for, matched (anchored) against a collection's
repo-relative path, `''` for one at the repository root:

```yaml
bruno:
  discovery:
    - organization: acme
      excludePathPattern: '(tests|examples|fixtures)/.*'
```

### Names, refs and owners

A discovered entity is named `<repo>` for a collection at the repository root
and `<repo>-<path-with-dashes>` for one in a subfolder, sanitized. **Not** the
URL's last segment, the way a `bruno.collections[]` entry is named: a folder
called `collection`, `api` or `tests` is the single most likely thing to find in
two different repositories, and a name collision is resolved by skipping the
loser — so the second repository's collection would simply never appear. There
is no `name:` override for a discovered collection, which is why the name has to
be unambiguous by construction. The manifest's own name still lands in
`metadata.title`.

Every discovered collection tracks its repository's **default branch**. There is
deliberately no `branch` knob: the URL grammar cannot express a ref for a
collection at the repository root (an empty subpath reduces to the bare repo
URL), so a pinned branch would be honoured for a subfolder collection and
silently dropped for a root one. Pin a branch with a `bruno.collections[]` entry
and an explicit `/tree/<branch>/` URL instead.

`owner` comes from the discovery entry, because nothing in a repository states
who owns a collection.

### Deferring to an authored descriptor

With `deferToCatalogInfo` (default `true`), a collection whose own directory or
repository root holds a `catalog-info.yaml`/`.yml` declaring `kind: Bruno` is
left to that descriptor. The descriptor is the richer source — it can carry
`spec.partOf`, an owner and a chosen name, none of which a sweep can infer — and
publishing both would put two differently-named entities on one collection,
which the sweep could not even detect, since it cannot see the catalog. Only
those two locations are checked, so a descriptor kept somewhere else means the
collection is both authored and discovered.

The cost of the default is a repository whose descriptor nobody registered with
Backstage: its collection is skipped here and never appears. The skip is logged
at info with the descriptor's path, and `deferToCatalogInfo: false` discovers it
anyway.

### Failure semantics

The provider applies a `full` mutation, which deletes by set difference, so a
partial sweep is indistinguishable from "these collections are gone". Discovery
therefore **throws rather than returning a short list**, and the provider
answers a throw the same way it answers a failed read of the UI store: it
emits the last set this process swept successfully, or — if it has none —
skips the tick entirely and changes nothing.

Inside a sweep the same rule is applied per repository:

| Situation | Behaviour |
| --- | --- |
| repository listing fails | the whole sweep throws |
| tree read fails, repository swept before | keep the collections found last time, warn |
| tree read fails, repository new since the last successful sweep | skip it, warn — it has published nothing, so skipping deletes nothing |
| tree read fails on the entry's **first** sweep in this process | throw: what that repository publishes is unknown |
| collection URL cannot be composed (a default branch with a slash in it) | skip that root, error — a deterministic failure, so it was never emitted before either |
| GitHub truncates the tree listing | warn, naming the repository: collections past the truncation point cannot be discovered, and a `bruno.collections[]` entry is the way to reach them |

### Limits

GitHub only. The `ScmProvider` seam is per-host and the sweep's GitHub calls sit
behind a small injectable client, so GitLab and Bitbucket Cloud are the same
shape of work; nothing about the provider, naming, deferral or failure handling
would change.

## Fetching and caching

[`src/service/manifestProbe.ts`](src/service/manifestProbe.ts) is the single
fetch + detect + extract + generate seam behind `kind: Bruno`. One tree read
produces **both** the manifest metadata and the OpenCollection definition, cached
as one entry, so two entities pointing at the same repository cost one `readTree`
rather than one each per reprocess cycle.

`BrunoKindProcessor` is the only consumer of this probe.
`BrunoCollectionEntityProvider`'s **emission loop reads nothing** — its only SCM
traffic is the discovery sweep, which is a repository listing per configured
organization rather than a read per collection. The loop used to probe every
collection on every tick to stamp the *fetched* `title`/`description`/`version`,
duplicating what the processor derives from the same probe moments later. With a 60 s tick
against a 60 s TTL every tick was a guaranteed cache miss, so that loop alone
accounted for roughly two thirds of steady-state Git traffic and computed nothing
new.

Removing it gave up the no-manifest prune, in two cases that now land as a
degraded entity instead: a `bruno.collections[]` entry pointing at the wrong
folder (the processor logs the same diagnostic), and a discovered collection
whose manifest moved between the sweep and the emit (self-healing — the sweep
only proposes roots it found a manifest in, so the next tick drops it by set
difference).

The cache is not an optimisation. The catalog reprocesses every entity every
100–150 s by default, so an uncached probe would hammer the SCM host. Past the
TTL (`bruno.cacheTtlSeconds`, default 60) there are **two revalidation tiers**,
cheapest first:

1. **A conditional HTTP request** — `ScmProvider.checkTreeIdentity`, implemented
   for GitHub, replaying a stored `If-None-Match` against
   `GET /repos/{owner}/{repo}/commits` scoped to the collection's own subpath.
   Measured 2026-09-02 against `api.github.com`: **authenticated** 304s consume
   no primary rate-limit quota (three in a row left `x-ratelimit-remaining` at
   4834), so an unchanged collection on a host with an `integrations.github`
   credential costs nothing per cycle. Unauthenticated 304s *do* decrement, so
   the zero-quota win requires a configured token. GitLab and Bitbucket Cloud
   have no implementation and skip to tier 2.
2. **The reader's ETag.** Worth stating precisely, because this document
   previously got it wrong: `readTree`'s etag is a *client-side commit-sha
   compare*, not an HTTP 304. The reader spends 1–2 API calls (2 on GitLab)
   resolving the sha and only then throws `NotModifiedError`. It saves the
   tarball download and the parse — and no quota at all. That is precisely why
   tier 1 exists.

Either tier matching is also a stronger byte-stability guarantee than generator
determinism alone. A provider without tier 1, and any failure of one with it,
falls through to tier 2 exactly as before; nothing there can turn a readable
collection into an unreadable one.

`probe(url)` distinguishes three outcomes and callers must too: a snapshot, or
`undefined` for "the tree read fine but held no `bruno.json` /
`opencollection.{yml,yaml}`", or a **throw** for a read/auth/network failure.

`ManifestProbe.evict` exists and is deliberately unwired. The obvious caller
would be a Sync route, but the probe instance backing catalog processing is
constructed inside the *catalog module* while the router lives in the `bruno`
plugin — reaching it would be a shared in-process import across a plugin
boundary, and silently wrong on any multi-replica deployment where the evict
lands in a process that is not the one serving the next processing run. Sync
converges within `bruno.cacheTtlSeconds` instead, which conditional-request
revalidation makes cheap enough to keep short.

## Credential isolation

Collection trees are fetched **server-side** by Backstage's `UrlReaderService`,
with credentials taken from the host's `integrations.*` config and applied inside
the backend. **They never leave the backend.** No route returns a token, and none
of the HTTP responses or generated HTML contain credentials — the only network
egress is Backstage → the SCM host.

**Reads never use a caller's SCM token.** Not `ManifestProbe`, which has no
`userToken` parameter, and not the `src/scm/` adapters, which have no per-user
read path at all. Two reasons it is built this way. No user request exists behind
a catalog processor or a scheduled provider run, so a token there could only be
one borrowed from an unrelated request; and a read whose credential varies by
who is looking would make `spec.definition` — a single shared catalog entity —
depend on which user's tick happened to refresh it. The consequence is worth
being explicit about: a private repository that the host's `integrations.*`
credential cannot see is unreadable by this plugin, even for a user whose own
account can see it.

The user's own SCM token is used in exactly one place in this project, and it is
never a read: the frontend's pull-request flows resolve it through
`scmAuthApi.getCredentials({ additionalScope: { repoWrite: true } })` so that a
`catalog-info.yaml` or `spec.partOf` PR is authored by the actual user. That
token stays in the browser and is never sent to this backend.

The provider likewise logs reader errors as a structured second argument, never
string-interpolated, because the error can echo the request it made and
interpolating it would put the plugin bearer token in the log.

### What the generated document *does* contain

`spec.definition` mirrors Bruno's own "Generate docs" output byte-for-byte in
intent — the same
`transformCollectionToSaveToExportAsFile` → `brunoToOpenCollection` → YAML
pipeline the desktop app and `bruno docs generate` use — so a collection
documented from Backstage matches the one documented from Bruno. **That pipeline
redacts in exactly one place**: `toOpenCollectionEnvironments` omits the value of
an environment variable flagged `secret` and emits `secret: true` instead.

Everything else is exported verbatim, and that is deliberate rather than an
oversight: auth passwords, tokens and client secrets (the converter's auth
mapping performs no redaction whatsoever), header and query values, request
bodies, scripts and tests. An earlier revision of
[`src/service/openCollectionExport.ts`](src/service/openCollectionExport.ts)
redacted secret-looking fields with a hand-rolled name-matching pass; it was
removed because it made Backstage's output silently diverge from Bruno's for the
same collection. That is also why there is no redaction config knob.

Stated plainly: the same YAML is stored on a catalog entity, where the audience
is *anything that can read the catalog* rather than one signed-in user entitled
to one collection. **A credential hardcoded in a `.bru` file reaches the catalog
in plaintext.** Keeping secrets in secret environment variables — or as
`{{placeholders}}` — is what keeps them out of the docs, in Bruno and here alike.

## Parser dependencies

- **`@usebruno/lang`** parses `.bru`. `bruToJsonV2` (aliased to `bruToJson` in
  [`src/service/collectionParser.ts`](src/service/collectionParser.ts)) parses a
  request; `collectionBruToJson` — unsuffixed — parses `collection.bru` /
  `folder.bru`; `bruToEnvJsonV2` parses `environments/*.bru` into
  `{ variables: [{ name, value, enabled, secret }] }`. That `secret` flag has to
  survive parsing, because the converter's handling of it is the entire redaction
  contract described above.
- **`@usebruno/filestore`** parses the OpenCollection (`.yml`) on-disk format, so
  both collection layouts are handled by Bruno's own parsers rather than here.
- **`@usebruno/converters`** supplies `brunoToOpenCollection`, the canonical
  Bruno → OpenCollection `1.0.0` conversion. It consumes Bruno's in-memory
  collection shape, not our flat model, so `openCollectionExport.ts` reshapes
  ours into a minimal `BrunoCollectionLike` before handing it over.

Known divergences from Bruno's native exporter: collection/folder
request-defaults, settings, examples, tags and the full `brunoConfig` are absent
from our source model, and assertions are omitted. The output is
faithful-for-docs, not byte-identical.

## Related documentation

- [`docs/Bruno Backstage Plugin PRD - Entity.md`](../../docs/Bruno%20Backstage%20Plugin%20PRD%20-%20Entity.md)
- [`docs/execution/`](../../docs/execution/) — `BE-P1`, `BE-P2`, `BE-UI` and
  `UI-P6` phase plans, referenced throughout the source comments.
- [`plugins/bruno/README.md`](../bruno/README.md) — the frontend half.
