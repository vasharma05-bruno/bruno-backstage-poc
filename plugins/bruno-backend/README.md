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
and every read after that is an ETag revalidation.

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
host's `integrations.*` credentials. Public `github.com`, `gitlab.com` and
`bitbucket.org` need no configuration at all (`@backstage/integration` appends a
default entry for each); private repositories need the matching `integrations`
block. Bitbucket Cloud is the one host with no per-user fallback — its
`UrlReader` ignores a per-call token — so a private Bitbucket repo requires
`integrations.bitbucketCloud`. Provider-specific URL grammar and credential
handling live under [`src/scm/`](src/scm/).

## HTTP API

Base path `/api/bruno` (the frontend resolves it via
`discoveryApi.getBaseUrl('bruno')`). Routes are built in
[`src/service/router.ts`](src/service/router.ts); the auth policies are declared
in [`src/plugin.ts`](src/plugin.ts).

| Method & path | Auth | Returns |
| --- | --- | --- |
| `GET /health` | unauthenticated | `{ status: 'ok' }` — a liveness probe with no data. |
| `POST /collections/probe` | `user` | `{ found: true, format, manifestPath, name?, version?, description? }`, or `{ found: false, reason: 'no-manifest' }` (200), or `{ found: false, reason: 'unreadable', message }` (400). |
| `POST /collections` | `user` | `201` with `{ name, namespace, entityRef, url, refreshSeconds }`. |
| `GET /collections` | `user` \| `service` | `{ collections, refreshSeconds }`. A **user** principal gets rows with `createdBy` omitted. |
| `DELETE /collections/:name` | `user` | `{ deleted: true, name, refreshSeconds }`, or `404` when no stored row exists. |
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
| `usebruno.com/origin` | provider (`config`/`ui`), processor (`file`/`descriptor`), or the descriptor itself | How the collection got into the catalog — see below. |
| `usebruno.com/definition-omitted` | processor | `size` (over `bruno.definition.maxBytes`) or `error` (the collection could not be read/converted). Deleted again once a definition is stored, so an over-cap collection that later shrinks stops claiming to be omitted. |
| `usebruno.com/definition-bytes` | processor | How big the omitted document would have been. |
| `backstage.io/source-location` | processor / provider | The collection **folder**, `url:<normalized>/`. |
| `backstage.io/managed-by-location`, `…-origin-location` | provider | A real `url:` ref to the collection folder, not a synthetic `bruno-provider:` one — that is what makes the About card's native Refresh button appear, and it is safe because `readLocation` only dereferences `kind: Location` entities. |

`usebruno.com/origin` has four values, and it exists because the frontend used to
guess by asking whether `managed-by-location` ended in `.yaml`. That guess is
right for every case we ship and wrong for two we cannot rule out: a descriptor
served from a URL with no YAML suffix, and a collection onboarded through the
Bruno UI, which produces a descriptor indistinguishable from a hand-written one.

| Value | Written by | What has to be edited to change the collection |
| --- | --- | --- |
| `config` | the provider, for a `bruno.collections[]` entry | `app-config.yaml`; there is no descriptor file anywhere |
| `ui` | the Bruno plugin, into the `catalog-info.yaml` it generates | that descriptor — and the dashboard's Remove action is offered |
| `file` | the processor, for a `catalog.locations` entry of `type: file` | the file on the Backstage host's disk; it is not in an SCM and cannot take a pull request |
| `descriptor` | the processor, by default | the hand-authored `catalog-info.yaml` in source control |

An existing value always wins (`deriveOrigin`), and that is what makes the scheme
work with one annotation instead of three: the provider stamps `config` on the
unprocessed entity, the UI writes `ui` into the descriptor it generates, and the
processor only names the two cases nobody else can. It follows that an authored
descriptor can claim an origin it does not have — accepted, since the file is the
operator's own and a wrong value costs nothing worse than misdirected advice in a
dialog.

The value is a pure function of how the entity was created and never changes for
a given entity, so — unlike, say, a source commit sha — stamping it cannot churn
`resultHash` and re-stitch the entity every cycle.

### Name collisions

The provider iterates **config entries first**, and the claim guard is
first-wins, keyed on the **lower-cased** name (an entity ref is lower-cased when
stringified, so `Payments` and `payments` are one entity). Config wins because
`app-config.yaml` is the operator's file and cannot be edited from the UI,
whereas a UI-created collection can be renamed by whoever made it. The log line
names both sides and gives advice specific to which origin lost.
`POST /collections` pre-rejects the same collision at write time so it is
normally caught with a message rather than silently here.

## Adding a collection from the UI

The catalog has **no write model**. Entities come from a Location (a descriptor
that must already exist) or from an EntityProvider — there is no
insert-an-entity API. So "Add Bruno Collection" in the dashboard cannot write to
the catalog. It writes here instead, and `BrunoCollectionEntityProvider`
materialises the stored rows into `kind: Bruno` entities on its next scheduled
tick, exactly as it already does for `bruno.collections[]` entries.

**Table `bruno_ui_collections`** (`src/store/uiCollectionStore.ts`), created on
first boot, no formal migrations:

| column       | notes                                                        |
| ------------ | ------------------------------------------------------------ |
| `name`       | `metadata.name` of the Bruno entity. Primary key.            |
| `url`        | The normalized collection folder URL.                        |
| `owner`      | Optional `spec.owner`.                                       |
| `part_of`    | `spec.partOf`, as a JSON array in a `text` column.           |
| `created_by` | Entity ref of the user who added it. Recorded, not enforced. |
| `created_at` | ISO timestamp.                                               |

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

## Fetching and caching

[`src/service/manifestProbe.ts`](src/service/manifestProbe.ts) is the single
fetch + detect + extract + generate seam behind `kind: Bruno`. The processor and
the provider share one instance per feature, so two entities pointing at the same
repository cost one `readTree` rather than one each per reprocess cycle. One tree
read produces **both** the manifest metadata and the OpenCollection definition,
cached as one entry.

The cache is not an optimisation. The catalog reprocesses every entity every
100–150 s by default, so an uncached probe would hammer the SCM host. Past the
TTL (`bruno.cacheTtlSeconds`, default 60) the read is an **ETag revalidation**,
not a re-download: every reader in use resolves the commit sha first and throws
`NotModifiedError` before fetching the tarball, so a stale-but-unchanged entry
costs one metadata API call and skips parsing and generation entirely. A matching
etag is also a stronger byte-stability guarantee than generator determinism
alone.

`probe(url)` distinguishes three outcomes and callers must too: a snapshot, or
`undefined` for "the tree read fine but held no `bruno.json` /
`opencollection.{yml,yaml}`", or a **throw** for a read/auth/network failure.

`ManifestProbe.evict` exists and is deliberately unwired. The obvious caller
would be a Sync route, but the probe instance backing catalog processing is
constructed inside the *catalog module* while the router lives in the `bruno`
plugin — reaching it would be a shared in-process import across a plugin
boundary, and silently wrong on any multi-replica deployment where the evict
lands in a process that is not the one serving the next processing run. Sync
converges within `bruno.cacheTtlSeconds` instead, which ETag revalidation makes
cheap enough to keep short.

## Credential isolation

Collection trees are fetched **server-side** by Backstage's `UrlReaderService`,
with credentials taken from the host's `integrations.*` config and applied inside
the backend. **They never leave the backend.** No route returns a token, and none
of the HTTP responses or generated HTML contain credentials — the only network
egress is Backstage → the SCM host.

`ManifestProbe` deliberately has **no `userToken` parameter**. No user request
exists behind a processor or a scheduled provider run, and not having the
parameter at all is the strongest guarantee that a caller's OAuth token can never
reach a log line there. The provider likewise logs reader errors as a structured
second argument, never string-interpolated, because the error can echo the
request it made and interpolating it would put the plugin bearer token in the
log.

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
