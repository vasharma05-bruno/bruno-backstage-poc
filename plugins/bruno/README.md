# @usebruno/bruno-plugin-poc

Bruno for Backstage — **frontend** plugin (POC). Built on the **new Backstage
frontend system** (Backstage v1.53) using blueprints from
`@backstage/frontend-plugin-api` and `@backstage/plugin-catalog-react/alpha`.

Pairs with the `bruno` **backend** plugin
([`plugins/bruno-backend`](../bruno-backend/README.md)), which materializes and
enriches the entities this plugin renders.

A Bruno collection is a **first-class catalog entity** — `kind: Bruno`,
`apiVersion: usebruno.com/v1alpha1`. That is the single fact the whole plugin is
organised around: the catalog is the read model, so listing, filtering, counting
and relation-walking all go through `@backstage/plugin-catalog-react`, and the
plugin's own client (`src/api/`) is left with only the four questions an entity
cannot answer.

## What it provides

Every extension is declared in [`src/extensions.tsx`](src/extensions.tsx) and
registered in [`src/plugin.ts`](src/plugin.ts). Extension ids follow the new
frontend system's `<kind>:<pluginId>/<name>` form, which is what an app overrides
from `app-config.yaml`.

| Extension id | Blueprint | Attaches to |
| --- | --- | --- |
| `api:bruno/bruno` | `ApiBlueprint` | app APIs — registers `brunoApiRef` (`BrunoClient`) |
| `page:bruno/bruno` | `PageBlueprint` | route `/bruno` — the Bruno Collections dashboard |
| `plugin-header-action:bruno/add-collection` | `PluginHeaderActionBlueprint` | the page header — **Add Bruno Collection** |
| `entity-card:bruno/collection` | `EntityCardBlueprint` | **API** entity pages — the Bruno Collections card |
| `entity-header-layout:bruno/header` | `EntityHeaderLayoutBlueprint` | `kind: Bruno` — replaces the entity header |
| `entity-card:bruno/documentation` | `EntityCardBlueprint` | `kind: Bruno` Overview — the collection's docs |
| `entity-card:bruno/related-apis` | `EntityCardBlueprint` | `kind: Bruno` Overview — APIs it is `partOf` |
| `entity-card:bruno/environments` | `EntityCardBlueprint` | `kind: Bruno` Overview — `spec.environments` |
| `entity-content:bruno/api-docs` | `EntityContentBlueprint` | `kind: Bruno` — the **Bruno API Docs** tab |

Two different filter forms are used on purpose. The `kind: Bruno` extensions all
share the `FilterPredicate` **object** form `{ kind: 'bruno' }`, because
`EntityHeaderLayoutBlueprint` accepts no string form at all and only the object
form is overridable from `app-config.yaml` — keeping it uniform keeps the five
overridable as a set. `entity-card:bruno/collection` uses the predicate-function
form (`entity.kind === 'api'`) instead, to avoid coupling to the exact
`FilterPredicate` shape across versions.

Nothing is gated on a `usebruno.com/*` annotation. Catalog processing stamps
annotations and relations a cycle (minutes) after an entity is registered, so an
annotation-gated card renders empty exactly when a user has just wired something
up and gone looking for it. Surfaces resolve their content at render time and
render their own empty state.

The sidebar entry for `/bruno` is not declared anywhere: `PageBlueprint` carrying
`routeRef` + `title` + `icon` is auto-discovered by the app's custom sidebar
(`nav.rest({ sortBy: 'title' })`). `/bruno` is this plugin's only page, which is
also what keeps the plugin-scoped header action to that one page.

## The entity model — [`src/lib/brunoEntity.ts`](src/lib/brunoEntity.ts)

Read-only, pure accessors over a `kind: Bruno` entity. No React, no API, so the
cards, the header and the dashboard all share one reading of the entity. Mirrors
`BrunoEntity['spec']` in `plugins/bruno-backend/src/types.ts` — keep the two in
step.

| Accessor | Reads | Written by |
| --- | --- | --- |
| `sourceUrl` | `spec.url` — the collection folder in source control | authored / provider |
| `partOfRefs` | `spec.partOf` — API entity refs, deduped | authored / provider |
| `runtimePartOfRefs` | `usebruno.com/runtime-part-of` — API refs linked in **this instance** | `BrunoKindProcessor`, from the backend's link table |
| `linkSource` | both of the above, for one API ref: `descriptor` \| `runtime` \| `both` \| `none` | — |
| `version` | `metadata.version` | manifest, via the processor |
| `requestCount` | `spec.requestCount` | `BrunoKindProcessor` |
| `environments` / `hasEnvironments` | `spec.environments` | `BrunoKindProcessor` |
| `definition` | `spec.definition` — the generated OpenCollection YAML | `BrunoKindProcessor` |
| `definitionOmittedReason` / `definitionOmittedBytes` | `usebruno.com/definition-omitted`, `usebruno.com/definition-bytes` | `BrunoKindProcessor` |
| `collectionOrigin` | `usebruno.com/origin` | provider / processor / an authored descriptor |
| `descriptorLocation` | `backstage.io/managed-by-location` | the catalog |

Every accessor is **total** — an unprocessed entity returns `undefined`/`[]`
rather than throwing — because the fields the processor writes appear a cycle
after the entity itself. `hasEnvironments` exists so a card can tell "this
collection defines no environments" (empty array) from "it has not been read yet"
(absent key); the two need different copy.

`linkSource` is what the link and unlink flows branch on, and it compares
**normalised** refs on both sides (via `lib/apiRef.ts`) so `orders`,
`api:orders` and `api:default/orders` in a descriptor all match the ref the
catalog hands the card. It answers `both` when a descriptor grew an entry a
runtime link already covered: the relation then survives removing either half
alone, so the Unlink dialog has to walk the user through both. `POST /links`
refuses to create that state, so reaching it means somebody edited the file
afterwards.

`descriptorLocation` reads `managed-by-location`, **not**
`backstage.io/source-location`: the processor stamps `source-location` to the
collection FOLDER, so `getEntitySourceLocation` points at the `.bru` files rather
than at the YAML that declares the entity. Editing `spec.partOf` means editing
the descriptor, so the descriptor is what has to be named.

### `usebruno.com/origin`, and what it decides

The one thing the UI cannot work out for itself: how the collection got into the
catalog, and therefore **what has to be edited to change it**.

| Origin | Where it came from | How it is changed |
| --- | --- | --- |
| `descriptor` | a `catalog-info.yaml` in source control — hand-authored, or generated by this flow's **Create pull request** | edit that file — by pull request when the host is GitHub |
| `ui` | registered with the backend by this dashboard's **Add collection**, and stored only there | edit the store row — which means removing the collection and adding it again, since there is no descriptor file to open a pull request against. The Remove action is offered |
| `config` | a `bruno.collections[]` entry | edit `app-config.yaml` and restart |
| `file` | a `catalog.locations` entry of `type: file` | edit the file on the Backstage host's disk |
| `unknown` | not stamped yet, or ingested by an older backend | — |

Pull requests are opened against **GitHub only** — `lib/unlinkPr.ts` speaks the
GitHub contents/pulls API and nothing else — and the host app's configured
`scmIntegrationsApi` decides which URLs are GitHub, including self-hosted ones.
That is why capability is resolved from the integrations registry rather than
from this plugin's own `scmProviderFromUrl`, which guesses from the hostname and
is only meant for validating pasted input.

Nothing about a collection is editable *in* Backstage in the sense of a form that
saves. The catalog is derived from source control, relations are recomputed on
every stitch, and no catalog endpoint mutates a `spec`. What varies is only
whether the change can be made *from* Backstage, by opening a pull request
against the file that owns it.

`ui` means **the store owns this collection**, and nothing else. That is why the
descriptor generated by **Create pull request** does *not* stamp it: that path
writes no store row, so the collection it describes is `descriptor`-origin —
which is what `deriveOrigin` defaults to for a `url` location anyway. Stamping
`ui` there would offer a Remove action backed by a `DELETE /collections/:name`
that answers 404.

`collectionOrigin` falls back to the shape of `managed-by-location` when the
annotation is absent — a descriptor is a YAML file, the provider stamps a folder
— which is the rule the UI used before the annotation existed. That fallback
cannot return `ui` at all — a UI-added collection is a store row whose location is
a folder, so it reads as `config`: the same "no descriptor" answer with the wrong
file named, which is exactly the ambiguity the annotation was added to remove.
Hence the Remove action is gated on the stamped value only, and an unstamped
entity gets no button rather than a button that fails.

`descriptorLocation` turns the origin into the file to edit, and only
`descriptor` and `unknown` yield one. `ui` was grouped with them while the
dashboard's only ending was a generated descriptor, and stayed there after it
grew a store: the link and unlink dialogs were handed the collection **folder**
that `BrunoCollectionEntityProvider` stamps for a store row, offered a pull
request against it, and failed on GitHub's directory listing — after the user had
already granted a repo-write token. A UI-added collection has no descriptor.

## `brunoApi` — [`src/api/`](src/api/)

`brunoApiRef` + `BrunoClient`. Deps: `discoveryApiRef` + `fetchApiRef`; the base
URL is `discoveryApi.getBaseUrl('bruno')`.

| Method | Route | Why it is not the catalog |
| --- | --- | --- |
| `probeCollection(url)` | `POST /collections/probe` | asks about a repository that is **not in the catalog yet** — and needs the backend's `integrations.*` credentials, which a browser does not have |
| `createCollection(input)` | `POST /collections` | the catalog has no write model; the backend stores the row a provider later materializes |
| `deleteCollection(name)` | `DELETE /collections/:name` | the same, in reverse |
| `listCollections()` | `GET /collections` | the collections that have been registered but are **not entities yet** — a question the catalog answers "none" to by construction |
| `createRuntimeLinks(input)` | `POST /links` | a **relation** has no write model either: relations are derived output, rewritten on every stitch |
| `deleteRuntimeLink(input)` | `DELETE /links?collection=&api=` | the same, in reverse |
| `getEntityDocsUrl(ns, name, theme)` | builds `/entities/:ns/:name/docs?theme=` | a **rendered** document, which needs an origin whose CSP admits the OpenCollection renderer bundle |

`probeCollection` returns a three-way union, not a nullable. A repository that
read fine but holds no manifest (`no-manifest`) is the user's mistake — wrong
URL, or the collection lives in a subfolder — while one that could not be read at
all (`unreadable`) is the instance's problem: no `integrations` entry for the
host, a revoked token, a private repo. The first needs "point me at the
collection folder"; the second needs the backend's own diagnostic shown verbatim,
because only an operator can act on it. Both are ordinary results; the client
parses the `400` that carries `unreadable` rather than throwing it away as
`HTTP 400`.

`createCollection` and `deleteCollection` are **eventually consistent** and every
caller has to say so on screen. Resolving means the backend stored the row, not
that the entity exists — the gap is `refreshSeconds` on the response, which is
`bruno.schedule.frequencySeconds` read back from the instance rather than a
hardcoded 60. Errors are surfaced as the backend's own sentence: a 409 from
`POST /collections` says *which* name is taken and by what, and collapsing that
to a status code leaves the user in front of a form with no idea which field is
wrong.

The two **link** methods are eventually consistent in the same way, but on a
different clock: the backend marks the collection for immediate reprocessing and
`refreshRequested` on the response says whether that worked — `true` means
seconds, `false` means the next full catalog processing cycle. `createRuntimeLinks`
is plural for the same reason `planLink` takes `apiRefs` — the collection-side
dialog picks several at once, and they land all or none — while
`deleteRuntimeLink` is singular because unlinking is a per-row action.

They only ever touch a *runtime* link: `deleteRuntimeLink` will not remove a
`spec.partOf` entry, and rejects with the backend's own sentence naming the file
to edit instead, because a "success" that left the relation in place would have
the user waiting for a change that is never coming. `linkSource` in
`lib/brunoEntity.ts` is how a caller tells the two apart before offering
either.

`getEntityDocsUrl` is the one method that builds a URL rather than fetching one,
because the result is handed to an iframe `src`, which carries no Authorization
header. [`src/lib/docsSession.ts`](src/lib/docsSession.ts) mints the Backstage
limited-access **cookie** for that request (`/.backstage/auth/v1/cookie` on the
`bruno` plugin, with `credentials: 'include'`) and re-mints it shortly before it
expires, so a long-lived tab never lets the frame's session lapse. The URL is
withheld from the frame until the cookie exists. Everything else goes through
`fetchApi`, which attaches the identity token — and on the create route that
token is not merely conventional: it is what supplies the `created_by` the
backend records.

## The dashboard — [`src/components/BrunoPage/`](src/components/BrunoPage/)

`/bruno`, a direct mirror of Backstage's own `DefaultApiExplorerPage`:
`EntityListProvider` owns fetching and filter state, `CatalogFilterLayout` splits
the pickers from the content, `CatalogTable` renders the rows. Nothing fetches,
filters or paginates by hand — the point of modelling a collection as an entity
is that it gets URL-synced filters, owned/starred, tag facets, search, sorting
and CSV export for free. The kind picker is `hidden` with
`initialFilter="bruno"`, exactly as the API explorer pins itself to `api`. There
is no lifecycle picker: `kind: Bruno` has no `spec.lifecycle`, so it would render
an empty facet list on every load.

Columns are the stock `CatalogTable.columns` factories wherever one fits; only
`metadata.version`, `spec.url` and `spec.partOf` need bespoke cells. Related APIs
are read from **`spec.partOf`, not the relation** — relations are stitched a
cycle after registration, so a relation-backed column reads as "the link did not
take" for minutes on a fresh collection.

**Stat tiles** (`StatTiles.tsx`) — Collections, Requests, Environments — are
derived in-page from the entities `useEntityList` has already loaded, post-filter,
so filtering to one owner moves the numbers with the table. Deliberately not
`catalogApi.getEntityFacets`: a second round trip would drift out of step with the
filters applied here. While the first fetch is in flight the tiles show an em dash,
because three confident zeroes read as "you have no collections".

**Pending collections** (`PendingCollections.tsx`) is a strip above the table
reporting on collections the table *cannot* show — stored by
`POST /collections` but not yet materialized. It subtracts the catalog from
`listCollections()` every 5 s (and on the
`bruno:collection-created` window event from
[`src/lib/collectionEvents.ts`](src/lib/collectionEvents.ts), a nudge that is
never a source of truth), calls `useEntityList().refresh` when a row lands, and
renders nothing at all when there is nothing outstanding. A row is **waiting**
until `landingTimeoutSeconds(refreshSeconds)` — `refreshSeconds * 2 + 30`, from
[`src/lib/landingWindow.ts`](src/lib/landingWindow.ts) — and **stalled** after
it. Stalled
is the case the provider cannot fix: most often a name a `bruno.collections[]`
entry claimed first, where the configured entry wins by design. The strip names
both possible causes and offers a Remove that calls `DELETE /collections/:name`
directly, so such a row is never stranded.

**Remove** is a per-row action gated on `collectionOrigin(entity) === 'ui'` and
nothing else, and it is `hidden` rather than `disabled` — a permanently disabled
icon on every config-origin row is furniture whose reason has nowhere to live in
a table cell. `DeleteCollectionDialog` is straight about the two things a delete
button does not normally mean here: nothing in source control is touched (the
collection folder stays, and so does any `catalog-info.yaml` committed for it),
and the row does not vanish — the provider prunes the entity on its next tick, so
the collection is still listed for up to `bruno.schedule.frequencySeconds`
afterwards. The confirm copy says "about a minute"; the `DELETE` response carries
the real interval, which the confirmation then quotes exactly.

## Adding a collection — [`src/components/AddCollection/`](src/components/AddCollection/)

A flow behind the **Add Bruno Collection** header action, ending in one of two
mutually exclusive ways. Where it ends in modal 2 it is a hand-off, not a wizard:
modal 1 closes as modal 2 opens, so the generated descriptor outlives the form
that produced it.

**Modal 1 — the form** (`AddCollectionDialog.tsx`). The URL field debounces 600 ms
and then asks the backend to probe it; a probe is a `readTree` of a whole
repository on a cache miss, and a pasted URL arrives in one event anyway. A found
manifest seeds two fields from its own name: `metadata.name`, sanitized (`My
Collection (v2)` becomes `my-collection-v2`), and **Display title**, which takes
it verbatim — the whole point of having both. The title is editable and may be
cleared, and clearing it is the opt-out rather than a gap: with no
`metadata.title` on the entity, `BrunoKindProcessor` derives one from the
collection manifest on every processing cycle, so renaming the collection in
`bruno.json` renames it in Backstage too. Fill it in and it wins over the
manifest from then on — on both endings, since an authored title and a stored
one are the same `keep(authored)` side of that rule. A manifest with no name of
its own leaves the field empty rather than falling back to the URL's last path
segment, which is a folder (`Orders%20API`) and not a name. Owner and "part of"
are `CatalogAutocomplete` pickers over a
four-field projection of the catalog, because an unprojected `getEntities` over
every API and Group would pull their specs, relations and OpenAPI definitions
across the wire to render a dropdown of names. The name is validated here rather
than left to the catalog because the catalog freezes an entity's ref before any
processor runs — it is the one field that has to be right at authoring time.

**Modal 1 has no single submit.** The two actions write to two different places,
and which one the user wants is not something the dialog can infer. Both are
gated on the same check — a probed URL with a manifest behind it, and a legal
name — because both produce a `kind: Bruno` entity from the same five fields.

| Action | What it writes | Where the entity comes from |
| --- | --- | --- |
| **Create pull request** (primary) | a `catalog-info.yaml`, via modal 2 | the descriptor, once it is merged **and** registered as a catalog location |
| **Add collection** | a `bruno_ui_collections` row, via `createCollection` | `BrunoCollectionEntityProvider`, within `bruno.schedule.frequencySeconds` |

They are mutually exclusive on purpose. Doing both — which is what submitting
used to do — leaves two sources claiming one entity name: the provider's `full`
mutation and the descriptor's location, resolved by the catalog
first-writer-wins, so the merged descriptor silently does nothing.

**Add collection** is the only one that can fail, and the failure that dominates
is a name someone else has already used. Modal 1 therefore stays open and
disabled while the create is in flight and comes back with the backend's error
attached to the field that produced it, with everything else still filled in.
Success closes the whole flow: the collection is a stored row that is not an
entity yet, and the pending strip — woken by the `bruno:collection-created`
event — is what names it, times it against the provider's real tick, and offers a
Remove if it never lands. A modal repeating that would be a worse copy of a
screen the user is already on.

**Modal 2 — the descriptor** (`GeneratedYamlDialog.tsx`) is no longer optional
garnish. It used to open on an already-registered collection, which made **Close**
a complete, successful ending; now the pull-request path registers nothing, so
the file this dialog produces is the collection's only route into the catalog and
closing without downloading it or opening a pull request discards it. The copy
says that outright rather than letting the user infer it. There is deliberately
**no catalog poll and no entity link**: the entity appears when the merged file is
registered as a location, which is neither this dialog's doing nor on any
schedule it could wait out, so watching for it would spin for the whole landing
window and then report a timeout for something that was never coming. Two exits:
**Download**, which always works because the user puts the file where it belongs,
and **Create pull request**, a convenience with hard limits stated on screen
*before* the button rather than discovered as a failure after it — including the
one users least expect, that merging the file is not the same as registering it.
That last step is a **link**, not an instruction: the copy resolves the catalog's
own "Register an existing component" page through `useRouteRef` (so an app that
remounted it is still linked correctly) and only falls back to naming
`catalog.locations` when the page is not mounted at all.
The YAML itself is built by
[`generateCatalogInfo.ts`](src/components/AddCollection/generateCatalogInfo.ts),
kept pure and separate so that one byte-identical string reaches all three
destinations — the preview, the download and the pull request's `fileContent`.

The flow is also reachable as a deep link: an API entity page navigates to
`/bruno?add=1&partOf=<api ref>`, and `AddCollectionAction` reads those parameters
back and **consumes** them (stripping them from the URL with `replace`) so a
reload or a back-navigation does not silently reopen the dialog.

## On API entity pages — [`src/components/BrunoCard/`](src/components/BrunoCard/)

**Bruno Collections** lists the collections that document this API, read from the
catalog `hasPart` relation to `kind: Bruno` — the mirror `BrunoKindProcessor`
emits for each collection's `partOf`, from either of the two places that can
record one. Per row: *Fetch in Bruno*, *View Collection Docs*, *Unlink*.
**Link collection** attaches an existing collection from this side.

### Two places a link can live

Catalog relations are derived output — recomputed and rewritten on every stitch,
with no relation-mutation endpoint anywhere in `plugin-catalog-backend` — so a
relation written at runtime would be reverted within one processing cycle. A link
therefore has exactly two durable homes, and both link dialogs offer both:

| | Where it lives | Undone by | Latency |
| --- | --- | --- | --- |
| **Pull request** (default) | `spec.partOf` in the collection's `catalog-info.yaml` | another pull request | a review, then a re-read |
| **Runtime link** | a row in the `bruno` backend, re-derived into a relation on every processing cycle | one call, from this card | a few seconds |

The pull request leads because a link in source control is reviewable, survives a
rebuilt database and travels with the repository. The runtime option is the
second choice — and the *only* one when no descriptor can be edited by pull
request at all: a `bruno.collections[]` entry, a collection added from the Bruno
dashboard and a discovered collection have no descriptor, a `file:` location is
not in an SCM, and pull requests are GitHub-only. Those five cases used to
dead-end the dialog with a paragraph about what to edit by hand. It still says that, as the reason the pull-request radio is disabled,
rather than as the end of the flow.

Rows carry a **Runtime link** chip (or *Runtime + descriptor*) where `linkSource`
says so, because that is what decides what Unlink will do — and because a link
that lives only in this instance is worth being able to spot at a glance.

**Pull requests** are implemented once for both directions in
[`src/lib/unlinkPr.ts`](src/lib/unlinkPr.ts). The token comes from
`scmAuthApi.getCredentials({ additionalScope: { repoWrite: true } })`, so the pull
request is authored by the **actual user**: correct attribution, correct audit
trail, no server-side write credential. The file is edited through `yaml`'s
`parseDocument` rather than `js-yaml` because a round-trip through the latter
strips every comment, and a PR that silently deletes a team's comments will not
get merged. `catalogImportApi.submitPullRequest` is not used: it writes to the
repository root rather than the descriptor's real path, it can only create a file
and never update one, and it uses a fixed branch name so a second unlink collides
with the first.

**Runtime links** go through `useRuntimeLink` in the same
[`PartOfPr/`](src/components/PartOfPr/) module — the counterpart of
`usePartOfPr`, and its own hook rather than another branch inside it: the two
share a stage/reset/action shape at the top and nothing below it, since this one
has no credential dance, no plan and no preview. There is nothing to preview
because no file changes, so what the user is agreeing to is stated on the radio
instead. `LinkMethodChoice` holds that radio for both link dialogs, and takes
the `useDescriptorAdvice` result as its own test: the advice is `undefined`
exactly when a pull request is possible, so its presence both disables that
option and explains why, in the same words the unlink dialog and the empty card
use.

The backend marks the collection for immediate reprocessing and reports whether
that worked; [`lib/entityRefresh.ts`](src/lib/entityRefresh.ts) then re-reads the
entity a few times over nine seconds, which is what makes the row appear, since
`useRelatedEntities` derives its list from the relations on the entity object and
nothing moves until the entity itself is fetched again. When the backend could
not schedule the refresh the card says the change is a full catalog cycle away
instead of polling for something that is not coming.

Open pull requests are shown as session-scoped chips; so is a runtime link that
has not surfaced as a relation yet, dropped as soon as it does. Neither is
persisted — a pull request already lives somewhere better, and a runtime link is
seconds from being visible on the entity itself.

## On `kind: Bruno` entity pages — [`src/components/BrunoEntity/`](src/components/BrunoEntity/)

**Header** (`BrunoEntityHeader.tsx`) replaces the stock entity header wholesale,
so the title area can carry Version, Source and the collection's own actions —
none of which the stock header has a slot for. The cost is real and worth
knowing: a custom header layout is handed only `{ tabs, activeTabId }`, so the
star and the overflow menu have to be rebuilt from public parts, and a
third-party `EntityContextMenuItemBlueprint` item will not appear on Bruno pages.
Everything else is deliberate parity with `EntityHeaderBui`.

**Documentation** (`CollectionDocsCard.tsx`) renders the collection's own README,
parsed out of `spec.definition`'s `root.docs`, falling back to
`metadata.description`. No fetch, nothing to fail; it renders nothing at all when
both are empty.

**Related APIs** (`RelatedApisCard.tsx`) reads the `partOf` **relation** — so a
ref that names a non-existent entity is simply absent rather than rendered as a
dead row, and so runtime links are listed alongside descriptor-declared ones —
with the per-row action menu and the same **Runtime link** chip the API-side
card shows. **Link APIs** runs `LinkApiDialog`, the mirror of the API-side flow:
several APIs into one pull request or one runtime write, with the same method
chooser. Because the collection is fixed here, whether a pull request is
possible is known before anything is picked, so that answer sits on the chooser
from the start rather than arriving with a choice.

**Environments** (`EnvironmentsCard.tsx`) reads `spec.environments`, with three
distinct states: key missing (not read yet), empty list (no environments
defined), or names to show.

**Bruno API Docs tab** (`BrunoApiDocsContent.tsx`) frames the backend's
`/entities/:ns/:name/docs`. The document is *not* assembled in the browser: a
`blob:` document would inherit the app's Content-Security-Policy, which does not
allow the OpenCollection renderer's CDN, whereas the backend document has its own
origin and its own CSP. The empty states branch on the **entity's**
`spec.definition` rather than on the response, so a collection with no document
never costs a request and the reason it has none — over
`bruno.definition.maxBytes`, generation failed, or not processed yet — is
explained from data already in React context.

This tab is the only place the document is rendered. A standalone
`/bruno/docs/:namespace/:name` page used to show the same thing full-screen,
reached from an *Open in new tab* action on this tab; both are gone, and the row
action on the collections card now links to this tab instead.

## Open in Bruno — [`src/components/OpenInBruno/`](src/components/OpenInBruno/)

A split button whose behaviour is extracted into `useOpenInBruno` so surfaces
that cannot host one (the row action menu on the collections card) drive exactly
the same deep link and the same fallback. The primary action opens Bruno's hosted
fetch endpoint — `https://fetch.usebruno.com/?url=<repo root>` — in a new tab;
the format lives in one place,
[`src/lib/brunoLink.ts`](src/lib/brunoLink.ts). Only the repo root is sent, not
the deeper `/tree/<ref>/<subpath>` collection path. The dropdown offers **Clone &
open in Bruno**, which copies a `git clone` instruction (and shows it if the
clipboard is unavailable).

## Enabling it in the app

`packages/app/src/App.tsx` uses `createApp` from `@backstage/frontend-defaults`.
Add the default export to `features`:

```ts
import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import brunoPluginPoc from '@usebruno/bruno-plugin-poc';

export default createApp({
  features: [catalogPlugin, brunoPluginPoc /* … */],
});
```

The package also exports `BrunoIcon`, so the app can register it as the
`kind:bruno` catalog icon (`packages/app/src/modules/icons`) without reaching
into the plugin's source tree.

### App APIs it uses, and how it degrades without them

`discoveryApi` and `fetchApi` are required. `scmIntegrationsApi`, `scmAuthApi`
and `catalogImportApi` are resolved through `useApiHolder`, never `useApi`,
because a host app is not obliged to register them and `useApi` throws at
**render** time for a missing one — which would take down a whole card instead of
disabling one action. `catalogImportApi` is the one to be careful about, because the
obvious reading of `packages/app/src/App.tsx` is wrong: its
`createApp({ features: [...] })` list does not mention
`@backstage/plugin-catalog-import`, but registration does not go through that
list. `app.packages: all` turns on the CLI's package detection, which scans
`packages/app/package.json` dependencies for any package whose
`backstage.role` is `frontend-plugin` and whose `exports` carry `./alpha`
(`cli-module-build/dist/lib/bundler/packageDetection.cjs.js:56-62`), and
`createApp` registers what it finds
(`frontend-defaults/dist/discovery.esm.js`). `plugin-catalog-import` matches
and is an app dependency, so **both its API and its `/catalog-import` page are
live here** — which is why modal 2 can link to that page as the
register-the-file step rather than describing a config edit.

`GeneratedYamlDialog` constructs a `CatalogImportClient` itself anyway, as a
fallback rather than as dead weight: `app.packages` may be unset or carry an
`exclude`, and a host app embedding this plugin need not depend on
`plugin-catalog-import` at all. It is the same class the ref resolves to, so the
limits the dialog states apply either way; when the page is genuinely absent
`useRouteRef` returns undefined and the copy falls back to naming
`catalog.locations`.

## Required app-config

No frontend-specific config is needed: the client resolves the backend through
`discoveryApi.getBaseUrl('bruno')`. What matters is on the backend side —
`bruno.collections`, `bruno.schedule`, `bruno.definition` and the
`integrations.*` credentials the probe reads with. See
[`plugins/bruno-backend/README.md`](../bruno-backend/README.md).

Two host-app settings this plugin's flows depend on:

- `catalog.rules` must allow the `Bruno` kind for the locations that carry Bruno
  entities.
- `catalog.import.entityFilename` is read by `CatalogImportClient` when modal 2
  opens a pull request.

And one the app in this repo sets on the plugin's behalf. TechDocs' two entity
surfaces — the `TechDocs` tab (`entity-content:techdocs`) and the `View TechDocs`
icon link in the About card (`entity-icon-link:techdocs/read-docs`) — ship with no
filter, so they are offered on every entity page including `kind: Bruno`, which
carries no `backstage.io/techdocs-ref`. `app.extensions` in `app-config.yaml`
overrides each one's `filter` with `{ $not: { kind: bruno } }`, which suppresses
both on Bruno entities and leaves them untouched everywhere else.

## Related documentation

- [`docs/Bruno Backstage Plugin PRD - Entity.md`](../../docs/Bruno%20Backstage%20Plugin%20PRD%20-%20Entity.md)
  — the product requirements this plugin implements.
- [`docs/execution/`](../../docs/execution/) — the phase plans (`BE-P1`, `BE-P2`,
  `BE-UI`, `UI-P6`) referenced from the source comments.
