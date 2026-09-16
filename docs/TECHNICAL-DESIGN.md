# Bruno for Backstage — Technical & Architecture Design

> **Ticket:** [BRU-4488](https://usebruno.atlassian.net/browse/BRU-4488) — *Backstage plugin: architecture study and technical design doc*
> **Epic:** [BRU-2982](https://usebruno.atlassian.net/browse/BRU-2982) · **PoCs:** [BRU-2867](https://usebruno.atlassian.net/browse/BRU-2867) (annotation) / [BRU-4446](https://usebruno.atlassian.net/browse/BRU-4446) (entity) · **Beta:** [BRU-824](https://usebruno.atlassian.net/browse/BRU-824) · **Themes:** [BRU-4465](https://usebruno.atlassian.net/browse/BRU-4465)
>
> **Status:** 🟠 Draft for team review · **Last updated:** 2026-09-16
> **Basis:** this repository (`usebruno-backstage-poc`) at `main`, its full git history, and the
> five superseded planning documents recovered from it (`POC-DECISIONS`, `POC-GAPS`,
> `PRODUCTION-REVIEW`, `MULTI-SCM-PLAN`, `NEXT-STEPS 1–3`).

---

## How to read this document

Each of the thirteen scope areas from BRU-4488 gets its own section with the same four
headings: **Options**, **Trade-offs**, **Recommendation**, and **Evidence** — what the two
PoCs actually demonstrated, with file references into this repository so any claim can be
checked rather than taken on trust.

Three conventions:

- **Verified** means it was executed against a real system and the result recorded (usually
  in a commit message, a source docblock, or one of the recovered planning docs). The date
  is given where it matters.
- **Asserted** means it is a design position argued from verified facts but not itself run.
- **Unproven** means we believe it and have not checked. These are listed in §18.

Nothing here is a code change. The deliverable is the decision.

### Coverage map — BRU-4488 scope item → section

| Scope item | Section |
| --- | --- |
| 1. Entity model and linking | [§2](#2--scope-1-entity-model-and-linking) |
| 2. Ingestion and artifact generation | [§3](#3--scope-2-ingestion-and-artifact-generation) |
| 3. Storage of the generated artifact (incl. file-vs-database) | [§4](#4--scope-3-storage-of-the-generated-artifact) |
| 4. Git provider support and rate limits | [§5](#5--scope-4-git-provider-support-and-rate-limits) |
| 5. Org-wide auto-discovery without rate limiting | [§6](#6--scope-5-org-wide-auto-discovery-without-rate-limiting) |
| 6. Entity lifecycle and relations | [§7](#7--scope-6-entity-lifecycle-and-relations) |
| 7. Frontend integration | [§8](#8--scope-7-frontend-integration) |
| 8. Backend and security | [§9](#9--scope-8-backend-and-security) |
| 9. Docs embedding and theme sharing | [§10](#10--scope-9-docs-embedding-and-theme-sharing) |
| 10. Distribution | [§11](#11--scope-10-distribution) |
| 11. Backstage version support | [§12](#12--scope-11-backstage-version-support) |
| 12. Prior art | [§13](#13--scope-12-prior-art) |
| 13. Anything else (catch-all) | [§14](#14--scope-13-additional-concerns-surfaced-by-the-study) |

And the deliverable's other requirements:

| Requirement | Section |
| --- | --- |
| Synthesis of both PoCs | [§1](#1--where-this-design-comes-from-the-two-pocs) |
| Recommended architecture + rationale | [§0](#0--executive-summary), then per-area |
| Step-by-step setup and usage guide | [§15](#15--setup-and-usage-guide) |
| Risks | [§16](#16--risks-register) |
| Version-compat and maintenance | [§12](#12--scope-11-backstage-version-support) |
| Product-level calls flagged for the PRD | [§17](#17--product-level-calls-flagged-for-the-prd) |
| Open questions | [§18](#18--open-questions-and-unproven-assumptions) |

---

## §0 — Executive summary

We ran two PoCs. The first modelled a Bruno collection as an annotation on a `kind: API`
entity plus a backend-owned connection database. The second modelled it as a first-class
`kind: Bruno` catalog entity. **The second is the architecture we should build the Beta on**,
and the reason is narrower and more useful than "it is nicer": the first PoC's central
mechanism — a runtime connection store that the UI reads through — is load-bearing in a way
that Backstage actively fights, and every operational problem in the production review
traced back to it. The second PoC moves the same information onto the entity, where the
catalog's own machinery (filtering, ownership, relations, permissions, search, CSV export,
URL-synced facets) applies for free and where there is nothing to keep in sync.

### The thirteen recommendations, in one table

| # | Area | Recommendation | Confidence |
| --- | --- | --- | --- |
| 1 | Entity model & linking | **Custom `kind: Bruno`**, `apiVersion: usebruno.com/v1alpha1`, `spec.partOf: string[]` → native `partOf`/`hasPart` relations. Keep a documented escape hatch for orgs that forbid custom kinds. | High — built and running |
| 2 | Ingestion & generation | Generate the OpenCollection document **in the `CatalogProcessor`**, from a shared TTL-cached probe. Sync = the catalog's native `refreshEntity`. No new endpoint, no generation in the provider. | High — built and running |
| 3 | Storage | **Inline on `spec.definition`**, exactly as `kind: API` stores OpenAPI, with a hard byte cap and *omit-never-truncate*. A database is needed **only** for the two things the catalog has no write model for, and both sit behind one config key. | High — built and running |
| 4 | Multi-SCM & rate limits | `UrlReaderService` for every read + a per-host `ScmProvider` seam that owns **URL grammar only**. One credential (`integrations.*`), no per-user read path. Conditional-request revalidation tier in front of `readTree`. | High — seam built, GitHub adapter complete |
| 5 | Org-wide discovery | Our **own `EntityProvider` sweep** (org repo listing + `pushed_at`-gated tree reads), not `GithubEntityProvider` and not code search. Defer to an authored descriptor by default. | High — built, measured on a 37-repo org |
| 6 | Lifecycle & relations | Deterministic names per source; first-wins claim guard; `full` mutation with a **fail-closed skip**; relations re-derived every cycle; `spec.owner` → `Group` by default. | High — built, with known edges |
| 7 | Frontend integration | Ship the **new frontend system** as the supported target. Add legacy support only as a thin separate entry point, and only if adopter demand justifies it. | Medium — needs a product call |
| 8 | Backend & security | Permissions framework + ownership enforcement, SSRF allowlist, pinned CSP on a dedicated docs origin. **None of this is built.** It is the single biggest block of Beta work. | High as a plan, zero as code |
| 9 | Docs embedding & theme | Keep the **backend-served iframe** (not `srcdoc`, not an extracted component). Ship `backstage-light`/`backstage-dark`; add a `postMessage` palette handshake for customised host themes. | Medium — iframe built, handshake not |
| 10 | Distribution | Public repo in the `usebruno` org, two npm packages (`@usebruno/plugin-bruno`, `@usebruno/plugin-bruno-backend`), release tracking Backstage's monthly cadence. | Medium — needs a product call |
| 11 | Version support | **New backend system required** (non-negotiable). Verified floor is **1.53.0**; a lower floor needs a compatibility matrix build, not a guess. | Medium — floor is honest, not optimised |
| 12 | Prior art | Borrow: `kind: API`'s inline-definition storage, `DefaultApiExplorerPage`'s list page, `BuiltinKindsEntityProcessor`'s relation timing, `UrlReaderProcessor`'s ETag discipline. | High |
| 13 | Catch-all | Nine additional concerns surfaced by the study — secret exposure in generated docs, `resultHash` churn, multi-replica behaviour, tests, and five more. | — |

### The three decisions that actually matter

Everything else follows from these.

1. **A Bruno collection is a catalog entity, not a row in our database.** This is scope area 1,
   and it decides 2, 3, 6 and 7 as a consequence.
2. **Reads use one credential — the host's — and never a user's.** This is scope area 4, and it
   is what makes `spec.definition` a coherent shared artifact rather than a value that depends
   on whose refresh tick happened to run.
3. **The generated document is derived output that must be byte-stable.** This is scope area 2,
   and if it is wrong, every Bruno entity in the catalog is rewritten and re-stitched every
   100–150 seconds, forever, invisibly.

### What is *not* ready

To be blunt, because the ticket asks for a decision and a decision needs the downside stated:
the entity PoC has **no authorization model at all**. Any authenticated user can ask the
backend to read any URL its integrations can reach, add a collection everyone else then sees,
and delete or unlink anything. These were deliberate POC-scope shortcuts, are recorded as such
in the route comments, and are re-stated here in §8. They are the gating work for Beta.

---

## §1 — Where this design comes from: the two PoCs

### 1.1 PoC 1 — the annotation flow ([BRU-2867](https://usebruno.atlassian.net/browse/BRU-2867))

Branch `annotation-flow` (merge-base `b8b86e0`). Verdict recorded 2026-08-04: **GO** on
feasibility; verdict recorded 2026-08-07 after the production review: **NO-GO** for org-wide
production as built.

**Model.** A Bruno collection was materialised as `kind: API` with `spec.type: bruno-collection`
and three annotations — `bruno.dev/collection-id`, `bruno.dev/collection-path`,
`bruno.dev/source-url`. A separate `BrunoLinkProcessor` injected those annotations onto
*existing* API entities so an API the org already had could be pointed at a collection. Two
database tables carried the state: `bruno_connections` (primary key `entity_ref`) and
`bruno_collections`. Collection identity was `sha256(normalizeGithubUrl(url)).slice(0, 16)`.

**What it proved (and these carry forward unchanged):**

- Backstage's `UrlReaderService` is the right read primitive. Private repositories work,
  the service credential never reaches the browser, and the only network egress is
  Backstage → SCM host.
- `.bru` parsing via `@usebruno/lang` works server-side. The exports are `bruToJsonV2` /
  `bruToEnvJsonV2` (V2-suffixed), not the bare names — a bug found and fixed on day one and
  the reason `collectionParser.ts` still aliases them today.
- A collection's documentation can be rendered *inside* a Backstage tab. The PoC first built
  a native React viewer with in-portal "try it out" through `@backstage/plugin-proxy-backend`
  (verified live: `GET {{host}}/ping` → `200 OK pong`), then later replaced it with the
  OpenCollection renderer in an iframe.
- Backstage's own `proxy-backend` enforces Backstage auth for free — an unauthenticated
  `curl` to a proxy endpoint returns `401`.

**What it got wrong, and why it matters to this design:**

| Problem | Root cause | Where it resurfaced |
| --- | --- | --- |
| **Annotation lag made the product look broken.** A user connected a collection and the annotation-gated docs tab simply never appeared. | `BrunoLinkProcessor` only injects annotations while the catalog *reprocesses* the entity — Backstage's multi-minute default — and connecting triggered no refresh. | §7. The rule "never gate a Bruno surface on an annotation" is now a standing constraint. |
| **Two sources of truth.** The catalog said one thing, `bruno_connections` said another, and the UI had to reconcile them at render time in four different components. | The link lived in our database; the entity was derived from it a cycle later. | §1, §6. Relations are derived output; a link must live either in a reviewed file or in a row we re-derive *every* cycle. |
| **Identity was a hash of URL text.** Any change to URL normalisation silently re-keyed every collection, breaking both tables, all three annotations and every bookmarked docs URL. | `collectionIdFromUrl`. | §6. Identity is now `metadata.name`, authored or deterministically derived — never a hash. |
| **Unauthenticated read surface.** `addAuthPolicy({ path: '/collections', allow: 'unauthenticated' })` is a *prefix* match, so `/collections`, `/:id`, `/:id/docs` and `/:id/opencollection.yml` were all open. Environment variable values were served in plaintext until a fix landed. | Convenience during the PoC. | §8. The docs route now uses a narrowly-scoped `user-cookie` policy instead. |
| **Per-process caches under horizontal scaling.** Connect on replica A, miss on replica B; the rebuild scheduler ran on every replica (N× SCM fetches); eviction only touched the serving replica. | In-memory `Map`s with no coordination. | §13.3. |

**The production review's own verdict**, three parallel passes, 2026-08-07: frontend ≈ 7/10,
backend ≈ 4.5/10, five hard blockers. Worth reading in full as the honest baseline of what
"a Backstage plugin that works in a demo" costs to make real.

### 1.2 PoC 2 — the entity flow ([BRU-4446](https://usebruno.atlassian.net/browse/BRU-4446))

Current `main`. Built from the scaffold as a full rewrite (not a migration), per the PRD at
[`docs/Bruno Backstage Plugin PRD - Entity.md`](./Bruno%20Backstage%20Plugin%20PRD%20-%20Entity.md),
in six phases (`BE-P1` → `BE-P2` → dashboard → entity page → API card → create/PR flows).

**Model.** `kind: Bruno`, `apiVersion: usebruno.com/v1alpha1`. Everything a consumer needs is
on the entity; the backend plugin is left with only the things an entity cannot carry.

**What it proved:**

- The custom kind works end to end: `BrunoKindProcessor.validateEntityKind` teaches the
  catalog the kind, `preProcessEntity` enriches it, `postProcessEntity` emits
  `partOf`/`hasPart` and `ownedBy`/`ownerOf` — so the native relations graph renders
  Bruno ↔ API edges with no custom rendering at all.
- The generated OpenCollection `1.0.0` document stores inline on `spec.definition` exactly as
  `kind: API` stores OpenAPI, and `ApiDefinitionCard`'s pattern (read it straight off React
  context, no fetch) applies.
- **Byte stability holds.** Verified at commit `e0cb2ae`: record `metadata.etag`, force a
  catalog refresh, confirm the refresh actually re-probed the source, re-read `metadata.etag` —
  identical. This is the single test that proves the catalog is not churning.
- Org-wide discovery is viable on a 60-second schedule. Verified against the public
  `github.com/bruno-collections` org: 37 repositories swept, 41 collections found, and a second
  sweep moments later reused all 37 cached results with **zero** tree calls.
- Authenticated GitHub `304`s cost **no** primary rate-limit quota. Measured 2026-09-02: three
  consecutive conditional requests left `x-ratelimit-remaining` at 4834 while one
  unconditional call took it to 4833. Unauthenticated `304`s *do* decrement (58 → 57 → 56).

**What it has not solved:** authorization, SSRF constraint, a pinned docs CSP, multi-replica
correctness, GitLab/Bitbucket discovery, non-GitHub pull requests, and the legacy frontend
system. All are enumerated in their own sections below.

### 1.3 Side-by-side

| | PoC 1 — annotation | PoC 2 — entity |
| --- | --- | --- |
| Catalog representation | `kind: API` + `spec.type: bruno-collection`, or annotations on an existing API | `kind: Bruno` (`usebruno.com/v1alpha1`) |
| Collection ↔ API link | `bruno_connections` row keyed on `entity_ref` (one collection per API) | `spec.partOf: string[]` → native relations (many-to-many) |
| Identity | `sha256(normalised URL)[0:16]` | `metadata.name`, authored or deterministically derived |
| Where the docs document lives | generated per request from a per-process cache | `spec.definition` on the entity |
| Listing / filtering / search | hand-rolled dashboard, client-side filter over the whole loaded list | `CatalogTable` + `EntityListProvider` — URL-synced facets, owned/starred, CSV export, free |
| Ownership | hardcoded `owner: 'guests'` | `spec.owner` → `ownedBy`/`ownerOf` relation |
| DB required? | Yes, for the core read path | Only for two optional write flows, both behind a config key |
| Rate-limit posture | Octokit `getTree` + per-blob fetch (worst available pattern) | one tarball `readTree`, TTL cache, conditional-request revalidation |

The decisive column is the last three rows. PoC 1 needed the database to *work*; PoC 2 needs
it only to offer two conveniences an operator can switch off entirely.

---

## §2 — Scope 1: Entity model and linking

### Options

**(a) Annotation on an existing `kind: API` entity.** `bruno.dev/collection-url` (or similar)
pointing at the collection folder; a `CatalogProcessor` reads it and enriches.

**(b) `kind: API` + `spec.type: bruno-collection`.** The collection *is* an API entity, with a
Bruno-shaped definition.

**(c) Custom `kind: Bruno` with `spec.partOf` linking to API entities.**

### Trade-offs

| | (a) annotation | (b) `kind: API` subtype | (c) `kind: Bruno` |
| --- | --- | --- | --- |
| Adoption friction | Lowest — one line in an existing descriptor | Low — a familiar kind | Highest — needs `catalog.rules` to allow the kind |
| Discoverability | None. A collection is invisible unless you already know the API | Appears in the API explorer, mixed in with real APIs | First-class: own dashboard, own facets, own icon |
| Multi-collection per API | Awkward. Annotations are single-valued; a list means inventing a delimiter | Natural | Natural |
| One collection documenting several APIs | Impossible | Possible but semantically odd (an API that is "part of" other APIs) | Natural — `partOf` is a list |
| Ownership | Inherited from the API; a collection cannot be owned separately | Own `spec.owner` | Own `spec.owner` |
| Conflicts with existing content | The API's own `spec.definition` (OpenAPI) and the collection's document compete for one slot | Same conflict, worse: an OpenCollection document in an `API` entity's `definition` field breaks `ApiDefinitionCard`'s format sniffing | None |
| Org restrictions | None | None | **Real.** Some platform teams restrict `catalog.rules` to the built-in kinds |
| Filtering / counting | Not possible without scanning every API entity | Possible but pollutes API facets | Native |

The two that decide it:

**(a) cannot express the actual relationship.** In practice a collection documents *several*
APIs (an end-to-end collection hitting three services) and an API is documented by *several*
collections (a smoke-test collection and a full-coverage one). PoC 1 made this concrete: its
store keyed on `entity_ref` as the primary key, which hard-limited it to one collection per API,
and the first real user need that hit was "I have two collections for this service."

**(b) collides on `spec.definition`.** `kind: API` requires `spec.definition` with
`minLength`, and Backstage's own `ApiDefinitionCard` dispatches rendering on `spec.type`
(`openapi`, `asyncapi`, `graphql`, …). Storing an OpenCollection document there means either
squatting a type the platform will one day define, or shipping an entity that fails validation
when generation fails. Worse — an unreachable repository or an over-cap document would make the
entity *invalid*, and a validation failure makes the processing run `ok: false`, which abandons
stitching and **deletes the entity outright**. A degraded Bruno collection must still be a
valid entity; under `kind: API` it cannot be.

### Recommendation

**(c) — custom `kind: Bruno`.**

```yaml
apiVersion: usebruno.com/v1alpha1
kind: Bruno
metadata:
  name: payments-collection        # required, frozen before any processor runs
  title: Payments API              # optional; falls back to the manifest's own name
  description: ...                 # optional; enriched from the manifest
  version: ...                     # optional; enriched from the manifest
spec:
  type: bruno-collection           # required
  url: https://github.com/acme/apis/tree/main/collections/payments   # required
  owner: guests                    # optional; unprefixed defaults to Group
  partOf:                          # optional; unprefixed defaults to API
    - api:default/payments-api
    - api:default/billing-api
  # --- derived; never authored ---
  definition: |                    # the generated OpenCollection 1.0.0 YAML
    ...
  requestCount: 42
  environments: [local, staging]
```

Four specifics worth defending individually:

1. **`apiVersion: usebruno.com/v1alpha1`, not `backstage.io/v1alpha1`.** That namespace is
   reserved for kinds Backstage itself ships; squatting it means an upstream kind named `Bruno`
   would silently collide. `apiVersion` is unvalidated in 1.53 (`EntityEnvelope.schema.json`
   types it `string, minLength: 1`), so this is convention — which is exactly why it should
   follow the convention.
2. **`spec.partOf` is a list, and it points from the collection to the APIs.** The direction
   matters: a collection knows which APIs it exercises; an API does not know which collections
   exist. `postProcessEntity` emits `RELATION_PART_OF` and the mirror `RELATION_HAS_PART`, so
   the API-side card reads `hasPart` and gets the reverse lookup for free, with no second index.
3. **None of the derived fields is in `spec.required`, and `definition` carries no
   `minLength`.** A degraded entity — unreachable repo, missing manifest, over the size cap —
   must still validate, for the `ok: false` reason above.
4. **`metadata.name` cannot be enriched.** The catalog validates the entity envelope *before*
   any processor runs and throws `ConflictError` if a processor changes the ref. So the name is
   whatever the descriptor or the provider says, and only `title` can come from the manifest.
   This is not a limitation to work around; it is the reason §6's naming rules exist.

**The escape hatch for orgs that restrict custom kinds.** This is a genuine adoption risk and
the design should answer it rather than hope. Two mitigations, in order:

- `catalog.rules` is a per-location allowance, so an org can permit `Bruno` for *only* the
  locations that carry collections. This is a one-line config change and should be the first
  line of the install guide.
- If a host genuinely cannot add a kind, the fallback is to register the collection as a
  `kind: API` with `spec.type: bruno-collection` and let the card render from the annotation
  set. **This is not v1 scope** — it is a documented degradation path, and it should be
  written down so an evaluator does not conclude the plugin is unusable for them.

### Evidence

- `plugins/bruno-backend/src/types.ts` — the `BrunoEntity` interface, with the envelope-freezing
  constraint recorded on `metadata.name`.
- `plugins/bruno-backend/src/processor/BrunoKindProcessor.ts` — `validateEntityKind` (which is
  what makes the catalog *recognise* the kind; `catalog.rules` only *permits* it),
  `preProcessEntity` enrichment, `postProcessEntity` relation emission.
- PoC 1's `bruno_connections` table, primary key `entity_ref`, is the concrete form of the
  one-collection-per-API limit.

---

## §3 — Scope 2: Ingestion and artifact generation

### Options

| When generation runs | Where the result goes |
| --- | --- |
| **A** — in the `EntityProvider`, on its schedule | stored on the emitted entity |
| **B** — in the `CatalogProcessor`, on every processing cycle | stored on the processed entity |
| **C** — on demand, when a UI asks for the document | nowhere; regenerated per request |

### Trade-offs

**A (provider) cannot serve authored descriptors.** A collection registered as a
`catalog-info.yaml` never passes through our provider at all — it arrives via a `Location`.
Generating in the provider means those collections get no document, which rules A out on its own.

**A also breaks Sync.** `refreshEntity` re-runs **processors, never providers**, and there is no
on-demand provider trigger in Backstage 1.53. So a Sync button backed by provider-side
generation would have nothing to call.

**C (on demand) makes the entity a lie.** `spec.requestCount` and `spec.environments` are what
the dashboard's stat tiles aggregate and what a catalog facet query counts across the whole org.
If they are computed per request they cannot be indexed, and the dashboard becomes N fetches
instead of one entity list. It also puts a network read on the render path of every card.

**B (processor) is the only option that converges.** Both entry points — an authored descriptor
and a provider-emitted entity — flow through the identical processing loop, so generation in the
processor is reached by both. This is not a preference; it is the only place the two meet.

The cost of B is that it runs **often**: the catalog reprocesses every entity every 100–150
seconds by default. Without caching, a 50-collection catalog would issue ~50 tree reads per
cycle against the SCM host, forever, whether or not anyone pushed anything.

### Recommendation

**B, with a shared cached probe in front of it, and Sync = native `refreshEntity`.**

The pipeline is `readTree` → parse → `brunoToOpenCollection` → YAML, in
`service/definitionBuilder.ts`, behind `service/manifestProbe.ts`. Four properties are
load-bearing:

**1. One tree read produces both the manifest metadata and the definition, cached as one
entry.** Splitting them into a cheap probe and an expensive probe costs a second read whenever
one warms an entry the other has to upgrade. Two entities pointing at the same repository cost
one `readTree`, not one each.

**2. Generation never throws.** A collection that cannot be parsed degrades to an entity without
a definition, not to no entity. Over the cap the definition is **omitted, never truncated** — a
truncated YAML document is invalid, so a renderer would fail with a parse error instead of
showing the reader *why* the content is missing. The reason is stamped as an annotation
(`usebruno.com/definition-omitted: size|error`) with the size it would have been.

**3. When generation fails, whatever was there is left alone.** A transient outage or one bad
push must not blank a definition that was good a cycle ago. Conversely, when generation
*succeeds* the derived fields are overwritten unconditionally — nobody hand-writes an
OpenCollection document into a `catalog-info.yaml`, and letting a stale authored value win would
make Sync a permanent no-op.

Note the deliberate asymmetry: an authored `title` / `description` / `version` in `metadata`
**wins** over the fetched value, while `spec.definition` / `requestCount` / `environments`
always lose to it. The rule is *authored metadata is the operator's; derived spec is ours.*

**4. Generation must be deterministic and carry no timestamp.** Backstage computes `resultHash`
over the **processed** entity, not the input. So nothing prevents every Bruno entity being
rewritten and re-stitched every 100–150 seconds *except* the generated string being
byte-identical across runs. Bruno's own exporter stamps `extensions.bruno.exportedAt`; ours must
not. Three separate things can break this and none of them fails loudly — a timestamp in the
output, unsorted tree paths (item order falls back to `Map` insertion order), or the ETag
short-circuit silently dying (`instanceof NotModifiedError` across a package boundary).

> **The byte-stability test, which should be part of CI.** Record `metadata.etag`; force a
> catalog refresh; confirm the refresh actually re-probed the source (the
> `Reading Bruno collection tree via UrlReader:` log count must increase); re-read
> `metadata.etag`. It must be **identical**. Run this after any change to
> `definitionBuilder.ts`, `openCollectionExport.ts`, `collectionParser.ts` or the probe's
> caching. Verified passing 2026-08-31 at `e0cb2ae`.

**Sync.** The PRD asks for a Sync button. It is the catalog's own `refreshEntity` and needs no
route of our own: it marks the entity for reprocessing, the processor runs, and the probe
revalidates. The user-visible latency is bounded by `bruno.cacheTtlSeconds` (default 60), which
is why that value is deliberately short — a five-minute cache makes Sync look broken.

One known wart, and it is the right trade: `ManifestProbe.evict` exists and is **deliberately
unwired**. The obvious caller is Sync, but the probe instance backing catalog processing is
constructed inside the *catalog module* while the router lives in the `bruno` plugin. Reaching
it would be a shared in-process import across a plugin boundary, and silently wrong on any
multi-replica deployment where the evict lands in a process that is not the one serving the next
processing run. Sync converges within the TTL instead.

### Evidence

- `plugins/bruno-backend/src/service/manifestProbe.ts` — the single fetch/detect/extract/generate
  seam, with the two revalidation tiers documented in its header.
- `plugins/bruno-backend/src/service/definitionBuilder.ts` — never-throws, omit-never-truncate.
- Byte-stability verified at `e0cb2ae`; the etag test is recorded as a standing check.
- The provider's emission loop **reads nothing**. It used to probe every collection every tick to
  stamp fetched metadata, duplicating what the processor derived from the same probe moments
  later. With a 60 s tick against a 60 s TTL every tick was a guaranteed cache miss, and that
  loop alone accounted for roughly **two thirds** of steady-state Git traffic while computing
  nothing new. Removing it is the single largest efficiency result of the entity PoC.

---

## §4 — Scope 3: Storage of the generated artifact

### Options

| | Where | Read path |
| --- | --- | --- |
| **A** | Inline on the catalog entity (`spec.definition`) | free with the entity — already in React context |
| **B** | Plugin database, keyed by entity ref | a fetch per render, plus a cache |
| **C** | Object storage (S3/GCS), URL on the entity | a fetch per render, plus infra the adopter must provision |
| **D** | Cache layer only (regenerate on miss) | a fetch per render, plus an SCM read on a cold cache |

### Trade-offs

**A's ceiling is entity size.** Backstage puts no hard limit on an entity, but the catalog's
`final_entities` table holds the whole serialised entity and the stitcher rewrites it on every
change. A multi-megabyte definition on a few hundred entities is a real database and
memory cost, and every `getEntities` call that does not project fields pays it.

**B, C and D all reintroduce PoC 1's central problem.** They make the entity incomplete, so
every consumer needs a second round trip and a reconciliation step, and the two can disagree.
PoC 1's frontend had a ~30-line "resolve the annotation, then fetch the connection" effect
repeated across **four** components — that duplication is the direct cost of a split read model.

**C additionally shifts infrastructure onto the adopter.** A plugin that requires an S3 bucket
before it renders anything is a plugin most platform teams will not evaluate.

**D is what PoC 1 did**, and its caches were per-process, never evicted on disconnect, and
unbounded. Those are fixable, but the fixed version is just B with extra steps.

### Recommendation

**A — inline on `spec.definition`, capped, with an explicit omission signal.** Precisely how
`kind: API` stores an OpenAPI document, which is the strongest available argument: it is the
platform's own answer to this exact question, and it means `ApiDefinitionCard`'s pattern (read
`entity.spec.definition` straight off React context, no fetch, no loading state) applies to us
unchanged.

The cap is `bruno.definition.maxBytes`, default **1 MiB**. Over it, the definition is omitted and
the entity is annotated with the reason and the size. `spec.requestCount` is still reported even
when the definition was omitted for size, so the dashboard's counts do not go blank on exactly
the largest collections.

`spec.environments` is a **string array**, not a comma-joined string, because the catalog indexes
one search row per array item — so a facet query can count *unique* environments across all
collections. A joined string would group as one opaque value. This is a small decision with a
disproportionate effect on what the dashboard can do without a custom index.

### Do we need a database at all?

**Not for the read path. Yes for two write flows, and both are optional.**

The catalog is a read model with **no write model**: entities come from a Location (a descriptor
that must already exist somewhere a reader can fetch) or from an `EntityProvider`, and there is
no insert-an-entity API anywhere in Backstage. Relations are worse — they are derived output,
recomputed and rewritten by the stitcher on every cycle, and `plugin-catalog-backend` exposes no
relation-mutation endpoint at all. So a relation written into the catalog would be reverted
within one processing cycle.

That leaves exactly two things a database can buy us:

| Table | What it holds | What it enables |
| --- | --- | --- |
| `bruno_ui_collections` | `name` (PK), `title`, `url`, `owner`, `part_of` (JSON in a `text` column), `created_by`, `created_at` | "Add collection" from the dashboard, without a `catalog-info.yaml` |
| `bruno_runtime_links` | `(collection_ref, api_ref)` composite PK, `created_by`, `created_at` | linking a collection to an API in *this instance* rather than by pull request |

Both are materialised the same way — the provider re-emits the stored collections and the
processor re-derives the stored links, **every cycle**. Re-deriving is what makes the link
survive the stitcher's rewrite.

**Both sit behind one config key, `bruno.allowRuntimeWrites`, off by default.** One key rather
than two because it is one decision: an operator who does not want an entity to exist without a
reviewed descriptor does not want a relation to either, and separate keys would only offer a
state where a collection can be created but never linked. With it off, this backend's database
declares nothing that the catalog shows, and source control is the single source of truth —
which is the posture most platform teams will want.

Two details that are easy to get wrong and expensive to discover:

- **The deletes stay open when the key is off.** Turning it off does not retract rows that
  already exist; the provider keeps materialising them. Refusing `DELETE` would strand exactly
  the state the operator turned the key off to be rid of, with no way out but the database.
- **`part_of` is `text` holding JSON, not a `json` column.** `text` is the only column type
  whose read-back value is byte-identical on better-sqlite3 and on Postgres — Knex's
  `table.json()` maps to a native `json` column on Postgres, where the driver parses it on read,
  forcing a dialect fork that can only ever be exercised on one side at a time.

**What Beta must add here.** The current tables are created on first boot with
`hasTable`-guarded DDL and no formal migrations (one add-column-if-missing, for `title`). That
is fine for a PoC and not fine for a published plugin: adopt Backstage's Knex migration
convention before v1, because after v1 there is no safe way to evolve the schema.

### Evidence

- `plugins/bruno-backend/src/store/uiCollectionStore.ts`, `store/runtimeLinkStore.ts`.
- `plugins/bruno-backend/README.md` §"Runtime writes" — the full argument, including the
  fail-closed provider behaviour described in §6.4.
- PoC 1's four-component duplicated resolve-effect is recorded in `PRODUCTION-REVIEW.md`
  §"Cross-cutting themes (frontend)".

---

## §5 — Scope 4: Git provider support and rate limits

### Options

| | Approach |
| --- | --- |
| **A** | Per-provider API clients (Octokit, GitLab SDK, …) |
| **B** | `UrlReaderService` for everything, with a thin per-provider seam for what it does not cover |
| **C** | `UrlReaderService` only, no seam — accept whatever it can do |

### Trade-offs

**A is what PoC 1 partly did and it is the worst option on every axis.** Its Octokit fallback
did `git.getTree({recursive})` then fetched blobs individually — an N+1 against the one provider
where quota matters most. It also bypassed Backstage's HTTP proxy configuration (raw Octokit
does not honour it), and it had no host validation, which is the SSRF finding in §8.

**C is not quite enough**, for one specific reason: URL *grammar* is per-provider and
`@backstage/integration` has no generic parser. It exports only `parseGiteaUrl`,
`parseHarnessUrl` and `parseGitilesUrlRef`. The grammars actually differ:

| Provider | Web URL shape |
| --- | --- |
| GitHub | `/{owner}/{repo}/tree/{ref}/{path}` |
| GitLab | `/{group}/{subgroup…}/{repo}/-/tree/{ref}/{path}` — arbitrary-depth groups, `-` separator |
| Bitbucket Cloud | `/{workspace}/{repo}/src/{ref}/{path}` |
| Bitbucket Server | `/projects/{KEY}/repos/{slug}/browse/{path}?at=refs/heads/{ref}` — **ref in the query string** |
| Azure DevOps | `/{org}/{project}/_git/{repo}?path=…&version=GB{ref}` — **path and ref in the query string** |
| Gitea | `/{owner}/{repo}/src/branch/{ref}/{path}` |

The last two matter more than they look: a normalisation step that does `u.search = ''` — which
PoC 1's did — **destroys the ref** for Bitbucket Server and Azure DevOps.

### Recommendation

**B — `UrlReaderService` for every read, plus a per-host `ScmProvider` seam that owns URL
grammar and nothing else.**

```
              ScmProvider (one per integration type)
              ├── normalizeUrl(url)          → the stable identity string
              ├── parseRepoUrl(url)          → { owner, repo, ref?, subpath }
              ├── composeCollectionUrl(...)  → rebuild a collection URL from a discovered root
              ├── repoRootFromUrl(url)       → reduce a collection URL to its repo
              ├── assertConfigured(url)      → fail early, with the fix in the message
              ├── checkTreeIdentity(...)     → OPTIONAL conditional-request revalidation
              └── resolveDefaultBranch(url)  → name a ref when the URL carries none
                             │
                             ▼
              reader.readTree(url, { etag })   ← the INJECTED UrlReaderService
```

Dispatch is on `integrations.byUrl(url)?.type`, with a host-name fallback so a self-hosted
GitLab whose integration is missing still gets a GitLab-shaped parse and therefore a *useful*
error ("no GitLab integration is configured for gitlab.company.com") rather than a GitHub-shaped
parse failing somewhere further down.

**Credentials: one, and it is the host's.** Reads authenticate with `integrations.*` and nothing
else. There is deliberately no `userToken` parameter anywhere in the read path — not on the
probe, not on the SCM adapters. Two reasons, and both are structural rather than stylistic:

1. No user request exists behind a catalog processor or a scheduled provider run, so a token
   there could only be one **borrowed from an unrelated request**.
2. A read whose credential varies by who is looking would make `spec.definition` — a single
   shared catalog entity — depend on which user's tick happened to refresh it.

The consequence must be stated plainly in the README, because it will generate support tickets:
**a private repository the host's credential cannot see is unreadable by this plugin, even for a
user whose own account can see it.** PoC 1 had a per-user read path (`x-bruno-github-token`); it
was deliberately removed on 2026-09-01 in favour of one credential, and the `ScmProvider`
docblock says "do not reintroduce".

The user's own SCM token survives in exactly one place, and it is never a read: the frontend's
pull-request flows resolve it through `scmAuthApi.getCredentials({ additionalScope: { repoWrite:
true } })` so a `catalog-info.yaml` or a `spec.partOf` edit is authored by the actual user —
correct attribution, correct audit trail, no server-side write credential. That token stays in
the browser and is never sent to our backend.

### Rate limits — what Backstage gives us, and what we must own

This is the area where the study found the most that contradicts the obvious assumption.

**What exists upstream is close to vestigial.** `ScmIntegration.parseRateLimitInfo` is
implemented by **GitHub only**, its sole consumer is `GithubUrlReader`, and all it does is
append `" (rate limit exceeded)"` to an error message. No retry, no backoff, no queueing. GitLab
has an entirely separate, unrelated mechanism (`integrations.gitlab[].retry` — `Retry-After`
parsing, exponential backoff capped at 10 s, per-minute throttling) which is **off by default**.
No other provider has a retry or throttle config block at all. `RateLimitMiddleware` in
`backend-defaults` is *inbound* protection for Backstage's own API and must not be conflated
with outbound SCM quota.

**What Backstage actually relies on is structural, not reactive:** conditional requests, archive
endpoints instead of tree APIs (`readTree` fetches a tarball — one request per tree, not one per
file), credential scoping (GitHub App installation tokens carry their own per-installation
quota), and scheduled refresh instead of on-demand fanout.

**The correction that shaped our design.** `readTree`'s ETag is **not** an HTTP 304. It is a
client-side commit-sha compare: the reader spends 1–2 API calls on GitHub (2 on GitLab)
resolving the sha and only then throws `NotModifiedError`. It saves the tarball download and the
parse — and **no quota at all**. With one probe per collection per catalog cycle, that is the
entire steady-state cost of the plugin, and it scales with `collections × time` whether or not
anybody pushes anything.

So we added a cheaper tier in front of it:

| Tier | Mechanism | Cost when unchanged |
| --- | --- | --- |
| **1** | `ScmProvider.checkTreeIdentity` — a real conditional HTTP request, replaying a stored `If-None-Match` against `GET /repos/{owner}/{repo}/commits` scoped to the collection's subpath | **Zero quota**, authenticated. Measured 2026-09-02: three consecutive 304s held `x-ratelimit-remaining` at 4834 |
| **2** | `readTree`'s ETag → `NotModifiedError` | 1–3 API calls; saves the download, not the quota |
| **3** | full `readTree` | one tarball |

Tier 1 is implemented for **GitHub only**, on purpose — that is where the free-304 property was
measured. GitLab and Bitbucket would spend the same quota the sha-compare already spends, for no
gain, so they skip to tier 2. Tier 1 is **optional and total**: it reports `unknown` rather than
throwing, and every failure falls through to exactly the `readTree` that would have happened
anyway. Nothing in it can turn a readable collection into an unreadable one.

Two measurement notes worth carrying forward, because both nearly produced a wrong conclusion:

- **`GET /rate_limit` is not a usable meter.** It reported `core.remaining` 5000 while response
  headers on the same token showed 4798 → 4797. Always read `x-ratelimit-remaining` off the
  actual response.
- **`@octokit/request` throws on a 304**, which is the one status this path exists to observe.
  The conditional-request path is written against plain `fetch` for that reason.

**Webhooks vs polling.** Recommendation: **polling, for v1.** Not because webhooks are worse —
they are better — but because the honest cost/benefit has changed. With tier-1 revalidation, an
unchanged collection on an authenticated GitHub host costs zero quota per cycle, so the pressure
that usually forces webhooks is largely gone. Webhooks in exchange require a publicly reachable
Backstage ingress, per-provider registration and secret management, and a signature-verification
endpoint per provider — a substantial surface for a plugin whose adopters include air-gapped
installs. Revisit after Beta with real usage data; the seam to add them later is the provider's
`refresh()` trigger, which already exists.

### Support matrix (this is a README deliverable, not just a design note)

| Provider | Read (public) | Read (private) | Discovery | Pull requests |
| --- | --- | --- | --- | --- |
| GitHub / GHE | ✅ | ✅ `integrations.github` | ✅ | ✅ |
| GitLab (SaaS + self-hosted) | ✅ | ✅ `integrations.gitlab` | ❌ planned | ❌ |
| Bitbucket Cloud | ✅ | ✅ `integrations.bitbucketCloud` (`clientId`+`clientSecret`) | ❌ planned | ❌ |
| Bitbucket Server / DC | ❌ no adapter — ref lives in the query string | ❌ | ❌ | ❌ |
| Azure DevOps, Gitea, Gerrit, Harness | reader-level only | reader-level only | ❌ | ❌ |

Credential shapes are **not** uniform and the differences are silent failures, not errors:

- **Bitbucket Cloud silently drops a bare `token`** (it requires `username` alongside it, or
  `clientId` + `clientSecret`). A bare token produces an anonymous read, not an error.
- **Gitea** carries a token in `password` with `username` omitted.
- **Azure** *throws* on a scalar `token`; it wants `credentials: [{ personalAccessToken }]`.
- **An empty-string config value is fatal**, not equivalent to absent: `ConfigReader`'s
  `getOptionalString` throws on `''`, and because every `core.urlReader` consumer builds
  `ScmIntegrations` at init, one blank env var fails the **whole backend startup** — techdocs,
  catalog, scaffolder and all. Comment a credential block out rather than emptying its vars.
- All three public hosts (`github.com`, `gitlab.com`, `bitbucket.org`) get an auto-injected
  default integration entry, so public repos on any of them read with **no** `integrations`
  config. Only **self-hosted** instances return `undefined` from `byUrl()` and must be declared.

### Evidence

- `plugins/bruno-backend/src/scm/` — the seam, three adapters, and `treeIdentity.ts` whose header
  carries the measurement.
- Recovered `docs/MULTI-SCM-PLAN.md` — blockers B1–B11, verified by a validation spike against
  real GitHub and GitLab.
- The credential-shape findings were produced by round-tripping a sentinel token through
  `ScmIntegrations.fromConfig` and reading each `get*RequestOptions`.

---

## §6 — Scope 5: Org-wide auto-discovery without rate limiting

### Options

| | Approach |
| --- | --- |
| **A** | Backstage's own `GithubEntityProvider` with a `catalogPath` glob |
| **B** | Provider-native code search (`GET /search/code`) |
| **C** | Our own `EntityProvider`: org repo listing + targeted tree reads |
| **D** | Require every collection to be declared (`bruno.collections[]` or a descriptor) |

### Trade-offs

**A does not work, and the reason is instructive.** `GithubEntityProvider` *will* find any
filename — `catalogPath` accepts a glob — but what it **emits** is a `kind: Location` of
`type: url` pointing at the file, and the catalog then reads that file with the *entity
descriptor parser*. A Bruno manifest has no `apiVersion`/`kind`, so every hit would land as a
processing error instead of an entity. The two seams that could bend this are both wrong for a
plugin to take: `CatalogProcessor.readLocation` keys on the location *type*, which that provider
hardcodes to `url`; and `catalogModelExtensionPoint.setEntityDataParser` is a single **global
singleton** that would put this plugin in charge of parsing every descriptor in the catalog.

**B is tempting and wrong.** One query instead of N calls, but: authenticated-only, indexes the
default branch late, misses large repositories, and allows **30 requests a minute**. A discovery
source that silently lags behind source control is worse than one that costs a tree call — a
collection pushed an hour ago that Backstage cannot see reads as the plugin being broken.

**D is the honest baseline** and stays supported. It is not sufficient on its own: the whole
point of "org-wide" is that nobody has to declare anything.

### Recommendation

**C — our own sweep, as a third source of the same `EntityProvider`**, so every discovered
collection goes through the identical probe, guards and enrichment as a configured one.

**The cost model, which is what makes it viable on a 60-second schedule:**

- One repository listing per configured org per tick.
- One recursive tree call **only for each repository whose `pushed_at` moved since the last
  sweep**.
- Archived and empty repositories are skipped without a tree call at all.

In a steady state an organization of any size costs its listing alone. `pushed_at` covers pushes
to *any* branch, so it over-invalidates and never under-invalidates for the default branch — the
direction that matters.

**Measured**, against the public `github.com/bruno-collections` org: 37 repositories swept, 41
collections found; a second sweep moments later reused all 37 cached results with **zero** tree
calls. Note the credential requirement that falls out of this: that first sweep is 37 calls, and
an **anonymous** reader gets 60 an hour. Discovery of any real organization needs an
`integrations.github` token (5000/hr). The sweep fails **loudly** when it runs out rather than
emitting a short set — see the failure semantics below.

**What a sweep finds that you did not want.** Every collection in a repository, including ones
nobody meant to publish: a client library's `tests/fixtures/bru` holds a real `bruno.json` and
nothing about it says otherwise. The sweep of `bruno-collections` found three such fixture
collections. `repositoryPattern` cannot exclude them because the noise is *inside* a repository
that does belong in the sweep — hence `excludePathPattern`, an anchored regex over a
collection's repo-relative path (`''` at the repository root).

**Deferring to an authored descriptor**, `deferToCatalogInfo`, default `true`. A collection whose
own directory or repository root holds a `catalog-info.yaml`/`.yml` declaring `kind: Bruno` is
left to that descriptor. The descriptor is the richer source — it can carry `spec.partOf`, an
owner and a chosen name, none of which a sweep can infer — and publishing both would put two
differently-named entities on one collection, which the sweep could not even detect since it
cannot see the catalog. The cost of the default is a repository whose descriptor nobody
registered with Backstage: its collection is skipped and never appears. That skip is logged at
info with the descriptor's path, and the flag turns it off.

**Failure semantics are the part most likely to be got wrong.** The provider applies a `full`
mutation, which the catalog applies **by set difference** — anything emitted before and not now
is **deleted**. So a partial sweep is indistinguishable from "these collections are gone".
Therefore:

| Situation | Behaviour |
| --- | --- |
| repository listing fails | the whole sweep **throws** (never returns a short list) |
| tree read fails, repository swept before | keep the collections found last time, warn |
| tree read fails, repository new since the last successful sweep | skip it, warn — it has published nothing, so skipping deletes nothing |
| tree read fails on the entry's **first** sweep in this process | throw: what that repository publishes is unknown |
| GitHub truncates the tree listing | warn, naming the repository — collections past the truncation point cannot be discovered, and a `bruno.collections[]` entry is the way to reach them |

And at the provider level: a throw is answered by emitting the last set this process swept
successfully, or — if it has none — **skipping the tick entirely** and changing nothing.

**Scheduling.** The sweep runs on `bruno.schedule` (`frequencySeconds`, `timeoutSeconds`),
inside the provider's own task, not on the catalog's processing interval. The two are
deliberately different clocks: the provider decides *which entities exist*, the processor
decides *what is on them*.

**Gap: GitHub only.** The `ScmProvider` seam is per-host and the sweep's GitHub calls sit behind
a small injectable client, so GitLab and Bitbucket Cloud are the same shape of work — nothing
about the provider, naming, deferral or failure handling changes. Sequence GitLab first: it
exercises nested groups and the `-` separator, so it validates the seam properly.

### Evidence

- `plugins/bruno-backend/src/discovery/` — `githubDiscovery.ts`, `githubClient.ts`,
  `collectionRoots.ts`, with tests.
- `plugins/bruno-backend/README.md` §"Autodiscovery" — the full cost model and the
  `GithubEntityProvider` rebuttal.

---

## §7 — Scope 6: Entity lifecycle and relations

### 7.1 Naming and uniqueness

`metadata.name` is frozen before any processor runs, so it must be right at authoring time and
can never be repaired later. Rules per source:

| Source | Name | Why |
| --- | --- | --- |
| Authored descriptor | whatever the file says | the operator's field |
| `bruno.collections[]` | last path segment of `url`, or an explicit `name:` override | the operator can see the collision and fix it in the same file |
| UI "Add collection" | typed by the user, validated in the dialog | the catalog's rejection would otherwise arrive at the far end of a pull request |
| **Discovery** | `<repo>` at the repository root, `<repo>-<path-with-dashes>` in a subfolder, sanitized | **not** the URL's last segment |

That last row is the one that needed thought. A folder called `collection`, `api` or `tests` is
the single most likely thing to find in two different repositories, and a name collision is
resolved by skipping the loser — so the second repository's collection would simply never
appear. There is no `name:` override for a discovered collection, which is exactly why the name
has to be unambiguous by construction. The manifest's own name still lands in `metadata.title`.

**Namespaces.** We do not use them, and should not for v1. Backstage namespaces are not a
general-purpose partition — most installs run everything in `default`, entity refs get noisier,
and a namespace would not actually solve cross-repo collisions (two repos in the same namespace
still collide). The subfolder-aware discovery name is the real fix.

**The claim guard.** The provider iterates **config entries first, then UI-created ones, then
discovered ones**, first-wins, keyed on the **lower-cased** name (an entity ref is lower-cased
when stringified, so `Payments` and `payments` are one entity). Config wins because
`app-config.yaml` is the operator's file and cannot be edited from the UI. Discovery is swept
last so it always loses — a discovered entry is re-derived every tick, so dropping it strands
nothing and it reappears once whatever shadowed it is gone. The log line names both sides and
gives advice specific to which origin lost.

A **discovered duplicate of an already-catalogued URL** is not a collision at all: a sweep
cannot see the catalog, so the same collection being configured *and* discovered is expected.
Those are dropped quietly by URL — before the probe runs, so they cost no tree read — and
counted separately in the provider's summary.

### 7.2 Deletion and orphans

| Event | What happens |
| --- | --- |
| A `bruno.collections[]` entry is removed | the next `full` mutation deletes the entity by set difference |
| A discovered collection stops being found | same — and this is self-healing by design |
| A descriptor is deleted from source control | the catalog's own location handling removes it |
| A UI-created collection is removed | `DELETE /collections/:name` → the provider prunes the entity on its next tick (up to `frequencySeconds`) |
| A UI-created collection is removed **and had runtime links** | `deleteForCollection` drops them with it — otherwise a collection re-added under the same name would silently inherit the links of the one it replaced |
| An API entity a collection is `partOf` disappears | the relation is simply absent; the collection-side card reads the *relation*, so a ref naming a non-existent entity renders nothing rather than a dead row |

**The one genuinely stranded state**, and it is worth knowing: a UI-created collection whose name
a `bruno.collections[]` entry claimed first. The configured entry wins by design and cannot be
overruled, so the collection stays a stored row with no entity — and the dashboard's Remove
action is gated on the *entity's* origin annotation, so a row with no entity is unreachable from
the product. The fix shipped is a "pending collections" strip on the dashboard that subtracts the
catalog from the stored list, marks a row **stalled** past `frequencySeconds * 2 + 30`, names
both possible causes, and offers a Remove that calls the DELETE route directly.

**Broken-link detection.** Today: none, beyond the relation simply being absent. Recommended for
Beta: when a `spec.partOf` ref resolves to no entity, surface it on the collection's Related APIs
card as a distinct state ("`api:default/orders` — not found in the catalog") rather than omitting
it. The information is available — `spec.partOf` and the relations can be compared — and the
silent omission is exactly the failure mode that makes a user think the link did not take.
Do **not** emit a processing error for it: an unparseable or unresolvable `spec.partOf` entry is
logged and skipped, never thrown, because an unguarded throw makes the run `ok: false` and on
first ingestion the entity would never land at all rather than merely losing one relation.

### 7.3 The `partOf` relation in both directions

`postProcessEntity` emits the pair — `RELATION_PART_OF` from the collection and the mirror
`RELATION_HAS_PART` on the API — matching `BuiltinKindsEntityProcessor`. The API-side card reads
`hasPart` filtered to `kind: Bruno`, so the reverse lookup needs no index of our own.

Two timing rules the UI must respect, both learned the hard way in PoC 1:

- **Relations are stitched a cycle after registration.** So the *dashboard* reads
  `spec.partOf`, not the relation — a relation-backed column reads as "the link did not take"
  for minutes on a fresh collection. The *entity page* reads the relation, because there the
  benefit (dead refs vanish, runtime links appear alongside descriptor ones) outweighs the lag.
- **Never gate a surface on an annotation.** Catalog processing stamps annotations a cycle
  (minutes) after an entity is registered, so an annotation-gated card renders empty exactly when
  a user has just wired something up and gone looking for it. Surfaces resolve at render time and
  render their own empty state.

### 7.4 The two places a link can live

Because relations are derived output, a link has exactly **two** durable homes, and both link
dialogs offer both:

| | Where it lives | Undone by | Latency |
| --- | --- | --- | --- |
| **Pull request** (default) | `spec.partOf` in the collection's `catalog-info.yaml` | another pull request | a review, then a re-read |
| **Runtime link** | a row in the `bruno` backend, re-derived into a relation every cycle | one call, from the card | a few seconds |

The pull request leads because a link in source control is reviewable, survives a rebuilt
database and travels with the repository. The runtime link is the second choice — and the *only*
one where no descriptor can be edited by pull request at all: a `bruno.collections[]` entry, a
UI-added collection, a discovered collection, a `file:` location, or a descriptor on a host other
than GitHub.

The two stay **distinguishable** on the entity (`usebruno.com/runtime-part-of`, a sorted
comma-separated list of canonical refs) rather than being merged into `spec.partOf`. The relation
is identical — every card that reads relations shows both without knowing there are two kinds —
but they are removed in completely different ways, and a UI that could not tell them apart would
offer a pull request that removes a line no file contains.

**Refs are canonicalised on both sides.** `spec.partOf` is written by hand, so `orders`,
`api:orders` and `api:default/orders` must all key the same relation, or a link created under one
spelling could not be removed under another. One shared helper (`service/entityRefs.ts`) owns
this.

### 7.5 Ownership

`spec.owner` → `ownedBy` / `ownerOf`, with **`Group` as the default kind** for an unprefixed
value, matching Backstage's own convention for `spec.owner`. Sources: the descriptor, a
`bruno.collections[].owner`, a `bruno.discovery[].owner`, or the UI dialog's owner picker.

Without it a collection has no `ownedBy` relation and reads as unowned — which is why
`bruno.discovery[].owner` exists at all: **nothing in a repository states who owns a
collection**, so a swept collection is unowned unless the discovery entry says otherwise. PoC 1's
hardcoded `owner: 'guests'` is the anti-pattern here; it made every collection appear to belong
to the guest group in a real org's ownership reports.

### 7.6 `usebruno.com/origin` — the annotation that earns its place

One annotation with five values, recording **how the collection got into the catalog** and
therefore **what has to be edited to change it**. This is the one thing the UI genuinely cannot
work out for itself.

| Value | Written by | What must be edited |
| --- | --- | --- |
| `config` | provider, for a `bruno.collections[]` entry | `app-config.yaml`; no descriptor file exists |
| `ui` | provider, for a dashboard-added collection | the store row; no descriptor, so no pull request. The Remove action is offered on this origin only |
| `discovery` | provider, for a swept collection | nothing local — re-derived every tick. Authoring a descriptor takes it over |
| `file` | processor, for a `catalog.locations` `type: file` | the file on the Backstage host's disk; not in an SCM |
| `descriptor` | processor, by default | the hand-authored `catalog-info.yaml` |

An existing value always wins, which is what makes one annotation sufficient instead of three.
The value is a pure function of how the entity was created and never changes — so, unlike a
source commit sha, stamping it cannot churn `resultHash`.

This replaced a frontend guess ("does `managed-by-location` end in `.yaml`?") that was right for
every case we ship and wrong for two we cannot rule out. Note also that the UI must read
`backstage.io/managed-by-location`, **not** `backstage.io/source-location`, to name the file to
edit: the processor stamps `source-location` to the collection *folder*, so
`getEntitySourceLocation` points at the `.bru` files rather than at the YAML that declares the
entity.

---

## §8 — Scope 7: Frontend integration

### Options

| | |
| --- | --- |
| **A** | New frontend system only (`@backstage/frontend-plugin-api` blueprints, config-driven) |
| **B** | Legacy frontend system only (adopter edits `EntityPage.tsx`) |
| **C** | Both, from one package with two entry points |

### Trade-offs

**The new frontend system is the strategic target** — it is where Backstage is going, it needs no
`EntityPage.tsx` edit, and every extension is overridable from `app-config.yaml`, which is a
materially better install story:

```yaml
app:
  extensions:
    - entity-card:bruno/collection:
        config:
          filter: { kind: api }   # or disable it entirely: `- entity-card:bruno/collection: false`
```

**But the legacy system is what most production installs are still running.** This is an adoption
question, not a technical one, and it is the sharpest **product call** in this document. A plugin
that only supports the new system will be evaluated and put down by a meaningful share of teams.

**C is cheap on the backend side and not cheap on the frontend side.** The backend plugin is
already new-backend-system only and that is fine — the new backend system is the default and the
legacy one is removed. The frontend is different: the two systems have genuinely different
composition models, and supporting both means a second entry point
(`@usebruno/plugin-bruno/legacy`) exporting `createPlugin`/`createRoutableExtension` wrappers,
plus a second set of manual tests.

### Recommendation

**Ship A for v1, with C as a fast-follow gated on adopter demand.**

Concretely: build the plugin so that all rendering lives in plain React components that take
props, with the blueprint declarations as a thin registration layer over them
(`src/extensions.tsx` is 9 declarations over components that know nothing about either system).
That is already how the entity PoC is built, and it is what makes a legacy entry point a day of
work rather than a fork.

**What the plugin provides today**, all declared in one file:

| Extension id | Blueprint | Attaches to |
| --- | --- | --- |
| `api:bruno/bruno` | `ApiBlueprint` | registers `brunoApiRef` |
| `page:bruno/bruno` | `PageBlueprint` | route `/bruno` — the dashboard |
| `plugin-header-action:bruno/add-collection` | `PluginHeaderActionBlueprint` | **Add Bruno Collection** |
| `entity-card:bruno/collection` | `EntityCardBlueprint` | **API** pages — the Bruno Collections card |
| `entity-header-layout:bruno/header` | `EntityHeaderLayoutBlueprint` | `kind: Bruno` header |
| `entity-card:bruno/documentation` | `EntityCardBlueprint` | `kind: Bruno` Overview |
| `entity-card:bruno/related-apis` | `EntityCardBlueprint` | `kind: Bruno` Overview |
| `entity-card:bruno/environments` | `EntityCardBlueprint` | `kind: Bruno` Overview |
| `entity-content:bruno/api-docs` | `EntityContentBlueprint` | the **Bruno API Docs** tab |

Two implementation notes that will otherwise be rediscovered:

- **Filter forms are not interchangeable.** `EntityHeaderLayoutBlueprint` accepts no string form
  at all, and only the object form (`{ kind: 'bruno' }`) is overridable from `app-config.yaml`.
  So the five `kind: Bruno` extensions all use the object form, keeping them overridable as a
  set. The API-side card uses the predicate-function form instead, to avoid coupling to the exact
  `FilterPredicate` shape across versions.
- **Entity tab labels cannot vary per entity.** `EntityContentBlueprint` types `title: string`
  and resolves it once at registration, with no entity in scope. So the tab strip reads a static
  label and the collection's name goes in a `ContentHeader` inside the content — which also wins
  the document title, giving `<entity> | <collection> | <app>`.

**The standalone dashboard.** `/bruno` is a direct mirror of Backstage's own
`DefaultApiExplorerPage`: `EntityListProvider` owns fetching and filter state,
`CatalogFilterLayout` splits pickers from content, `CatalogTable` renders rows. Nothing fetches,
filters or paginates by hand — *the entire point of modelling a collection as an entity is that
it gets URL-synced filters, owned/starred, tag facets, search, sorting and CSV export for free.*
The kind picker is hidden and pinned to `bruno`, exactly as the API explorer pins itself to
`api`. There is no lifecycle picker, because `kind: Bruno` has no `spec.lifecycle` and it would
render an empty facet on every load.

The three stat tiles the PRD asks for (Collections, Requests, Environments) are derived in-page
from the entities `useEntityList` has already loaded, **post-filter**, so filtering to one owner
moves the numbers with the table. Deliberately not `catalogApi.getEntityFacets` — a second round
trip would drift out of step with the filters applied here.

**Degrading gracefully.** `scmIntegrationsApi`, `scmAuthApi` and `catalogImportApi` are resolved
through `useApiHolder`, never `useApi`, because a host app is not obliged to register them and
`useApi` throws at **render** time for a missing one — which would take down a whole card instead
of disabling one action.

---

## §9 — Scope 8: Backend and security

> **This section describes work that is largely not done.** The entity PoC's route comments call
> each gap out explicitly; they are repeated here so nothing is discovered by surprise.

### 9.1 What exists

- **New backend system**, `createBackendPlugin`, plugin id `bruno` → `/api/bruno/*`.
- **Two separate backend features**: the plugin (routes) and `brunoCatalogModule` (processor +
  provider), with no wiring between them. Each builds its own `ManifestProbe` — sharing one
  in-process would be wrong on a multi-replica deployment anyway; the cost is one duplicated tree
  read the first time a scanned collection is then ingested.
- **Per-route auth policies**, not a blanket one. `/health` unauthenticated; most routes `user`;
  `GET /collections` and `GET /links` additionally `service` (the provider and processor read
  them with a plugin token); the docs route `user-cookie`.
- **Credential isolation**, verified: no route returns a token, no HTTP response or generated
  HTML contains one, and the only egress is Backstage → SCM host. Reader errors are logged as a
  **structured second argument, never string-interpolated**, because the error can echo the
  request it made and interpolating it would put the plugin bearer token in the log.

### 9.2 The four open holes

| # | Hole | Shape of the fix |
| --- | --- | --- |
| **S1** | **SSRF + private-repo existence oracle.** Any authenticated user may ask the backend to read any URL its integrations can reach (`POST /collections/probe`, `POST /collections`). | Validate up front that `integrations.byUrl(url)` is defined and the host is in an allowlist, **before** any fetch. Never fall through to a hardcoded API base. Rate-limit the probe per user. |
| **S2** | **No authorization (IDOR).** Any authenticated user may add a collection everyone sees, and may delete **any** UI-created collection or remove **any** runtime link. `created_by` is recorded and *not* enforced. | `@backstage/plugin-permission-*`: define `bruno.collection.create/delete` and `bruno.link.create/delete` permissions, and enforce entity ownership via `userInfo.ownershipEntityRefs` on the delete paths. |
| **S3** | **The docs CSP allows `https:` broadly** rather than pinned hosts, because the renderer bundle lazy-loads from several CDNs (its own bundle, Monaco from jsDelivr, Inter from Google Fonts, HLS/FLV players, oEmbed iframes). It also needs `'unsafe-eval'` for a QuickJS WASM runtime. | Pin exact hosts by auditing the shipped bundle; serve the route from a **dedicated origin** so a CSP escape cannot reach the app's cookies; add SRI where the bundle is versioned. |
| **S4** | **The renderer bundle is on a staging CDN** (`staging.cdn.usebruno.com/api-docs`), unpinned. | Move to a versioned production CDN, or self-host the bundle as a plugin static asset for air-gapped installs. This was a **hard blocker** in PoC 1's production review and it is still open. |

**S2 deserves one extra note.** The link routes already resolve both entities *as the requesting
user*, so visibility is inherited from the catalog — a user cannot link a collection they cannot
see. That is a meaningful partial mitigation and should not be mistaken for authorization.

### 9.3 The proxy for the playground's outbound requests

PoC 1 solved the CORS problem by routing in-portal "try it out" through
`@backstage/plugin-proxy-backend` (`proxy.endpoints` in `app-config.yaml`), and verified it live.
It also inherited a useful property for free: the proxy **enforces Backstage auth**, so an
unauthenticated `curl` to a proxy endpoint returns `401`.

Two things were wrong with it and must be fixed before it returns:

- The host→endpoint map was **hardcoded in the frontend** and had to be kept manually in sync
  with `proxy.endpoints`. Adding a target host meant edits in two places, and an unmapped host
  fell back to a direct browser `fetch` that hits CORS.
- There is no **server-side secret injection**. This is the differentiating capability — the
  proxy is exactly the seam for it — but it needs a secrets story (where a secret lives, who may
  use it, how it is scoped to a collection or an environment) that does not exist yet.

**Recommendation:** derive the allowlist from config at runtime rather than duplicating it, and
treat server-side secret injection as its own design (and its own ticket). Do not ship a
playground that silently sends no credentials — PoC 1's try-it-out never applied `auth.mode` at
all, which is worse than not offering the feature.

### 9.4 Permission gating

Recommended permission set for Beta:

| Permission | Guards |
| --- | --- |
| `bruno.collection.read` | the dashboard and the docs route (on top of the catalog's own read permission) |
| `bruno.collection.create` | `POST /collections` |
| `bruno.collection.delete` | `DELETE /collections/:name` — plus an ownership check |
| `bruno.link.create` | `POST /links` |
| `bruno.link.delete` | `DELETE /links` — plus an ownership check |

Catalog read permissions apply to `kind: Bruno` entities automatically, since they are ordinary
entities — which is another quiet dividend of scope area 1.

---

## §10 — Scope 9: Docs embedding and theme sharing

### Options

| | |
| --- | --- |
| **A** | Extract the OpenCollection renderer as a React component and mount it in the tab |
| **B** | `<iframe srcdoc="…">` — assemble the document in the browser |
| **C** | `<iframe src="…">` — the document is served from the backend, on its own origin |
| **D** | Build a native Backstage viewer from scratch (what PoC 1 did first) |

### Trade-offs

**D was PoC 1's answer and it genuinely worked** — folder tree, method badges, request detail
tabs, and live in-portal execution. It was also the right call *at the time*, because
`@opencollection/docs` was not published to npm. But it is a permanent second implementation of
Bruno's own docs UI, drifting from it with every Bruno release, and it never gained GraphQL
bodies, multipart bodies, auth application or an environment switcher. Recommend **dropping it**;
it is already gone from `main`.

**A is the cleanest-looking option and has the most failure modes.** The renderer uses a
`HashRouter` (which hijacks the app's URL), touches `sessionStorage`, lazy-loads Monaco and a
QuickJS WASM runtime, and would land its whole bundle in the app's chunk graph. Every one of those
is a fight with the host app.

**B fails for a specific, non-obvious reason.** A `blob:` or `about:srcdoc` document **inherits
the app's Content-Security-Policy**, under which the renderer's CDN is not allowed — so the
bundle is blocked everywhere the app is served by `plugin-app-backend`, i.e. everywhere except a
CSP-less dev server. `srcdoc` also gives the document no real origin, which the renderer's
`sessionStorage` access and `HashRouter` routing both need.

### Recommendation

**C — the backend renders the document at `GET /entities/:namespace/:name/docs` and the tab
frames it by `src`.**

Five details that make it work:

1. **Auth.** An iframe `src` is a browser GET with no `Authorization` header. The frontend mints
   the Backstage limited-access **cookie** (`/.backstage/auth/v1/cookie` on the `bruno` plugin,
   `credentials: 'include'`) and re-mints it shortly before expiry so a tab left open overnight
   keeps rendering. The URL is **withheld from the frame until the cookie exists**.
2. **The route reads the catalog as the requesting user**, so it can never surface a collection
   the caller could not read from the catalog itself.
3. **Embedding headers are set before any error branch** — `X-Frame-Options` removed and the CSP
   replaced with one scoped to the document — so every error page is framable too. Otherwise the
   user gets a cryptic "refused to connect" instead of the message. Errors on this route are HTML
   documents, not JSON, for the same reason.
4. **Empty states branch on the entity, not the response.** `spec.definition` is already in React
   context, so a collection with no document never costs a request, and the reason (over the cap,
   generation failed, not processed yet) is explained from data already in hand.
5. **The YAML is injected as a JSON string literal with `</script` neutralised** — the HTML
   tokenizer ends a script element on `</script` followed by whitespace, `/` or `>`, not just
   `</script>`.

### Theme sharing

**Today:** the frontend reads the active Backstage theme (`useTheme().palette.type`), maps it to
`light`/`dark`, and passes it as `?theme=` on the docs URL; changing theme changes the `src` and
re-renders the frame. That is a two-state match and it is correct for a default Backstage theme.

**The gap, and it is [BRU-4465](https://usebruno.atlassian.net/browse/BRU-4465)'s territory:** a
host that has customised its Backstage theme gets a docs frame that does not match. Two options:

| | Approach | Cost |
| --- | --- | --- |
| **T1** | Ship `backstage-light` / `backstage-dark` presets in the renderer and keep the `?theme=` query | Zero integration work; wrong for a customised host |
| **T2** | Read the live theme (`useTheme` / `appThemeApi`), extract a small set of palette tokens, and send them to the frame by **`postMessage`**; the renderer applies them as CSS custom properties | A message contract between two repos; needs a renderer change |

**Recommend both: T1 as the floor, T2 as the enhancement.** T1 must exist regardless, because it
is what renders before any handshake completes and what renders if the handshake fails. T2 should
be scoped as **palette match, not clone** — a fixed, small, versioned token set (background,
paper, primary text, secondary text, accent, border, and the method colours), not an attempt to
mirror a MUI theme object.

Three implementation constraints for T2:

- `postMessage` must target the **exact backend origin**, never `'*'`, and the frame must verify
  `event.origin` against the app's origin on receipt. This is a cross-origin channel by
  construction (that is the whole point of serving the docs from the backend).
- The handshake must be **idempotent and re-sendable** — the frame may load after the first send,
  so the parent should re-send on the frame's `load` and on any theme change.
- Falling back to T1 must be silent and instant. A frame that waits for a theme message it never
  receives renders unstyled.

**One trust note that should not be lost.** The frame is currently
`sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` on a backend-origin document
generated from collection content pulled from arbitrary repositories means: if the backend ever
fails to escape a collection-derived string, that is stored XSS executing on an origin that
shares Backstage's auth cookies. The escaping is there and is correct for the JSON-in-script
context, but **the right structural fix is a dedicated docs origin** (S3 above), after which
`allow-same-origin` is no longer a shared-cookie risk.

---

## §11 — Scope 10: Distribution

### Recommendation

**Two packages, one public repository in the `usebruno` org, released on a cadence pinned to
Backstage's.**

| Package | Role | Notes |
| --- | --- | --- |
| `@usebruno/plugin-bruno` | `frontend-plugin` | default-exports the plugin for `createApp({ features })`; also exports `BrunoIcon` and `brunoApiRef` |
| `@usebruno/plugin-bruno-backend` | `backend-plugin` | default export is the plugin; `brunoCatalogModule` is a **named** export |

(The PoC's names carry a `-poc` suffix and `private: true`; both go before publication.)

**Repository.** A dedicated public repo in the `usebruno` org, not a folder inside `usebruno/bruno`
and not this app. Reasons: Backstage plugins are conventionally standalone and evaluated as such;
the plugin's release cadence is Backstage's, not Bruno's; and CI needs a Backstage app fixture,
which does not belong in the Bruno monorepo. **This repository stays** as the reference app —
the thing a reviewer clones to see it running, and where end-to-end tests live.

**Versioning and cadence.** Backstage ships roughly monthly. Recommended policy:

- **Do not use caret ranges on `@backstage/*` in the published packages' `dependencies`.** PoC 1's
  production review flagged this (`MNT-1`): caret ranges silently drift the tested baseline, and
  the new frontend system's API surface is still moving. Use a range you have actually built
  against and widen it deliberately.
- Publish a release within ~2 weeks of each Backstage minor, after running the compatibility
  matrix (§12).
- Maintain a **`backstage-compat` table in the README**: plugin version → verified Backstage
  versions. This is the single most useful thing a plugin can publish for a platform team.

**Marketplace listing** (backstage.io/plugins) after the first stable release, not before.

### Open product questions

- Package scope: `@usebruno/*` vs a `backstage-plugin-*` name (the community convention). Both
  work; `@usebruno/*` is better for brand, the community prefix is better for discovery.
- Licence. The PoC is `UNLICENSED`. This needs an answer before publication, and PoC 1's review
  flagged `@usebruno/*` + renderer licensing as needing legal sign-off (`CMP-2`).

---

## §12 — Scope 11: Backstage version support

### What is non-negotiable

**The new backend system.** It is the default and the legacy backend is removed; there is no
argument for supporting it.

### What is verified

This repository pins **`backstage.json: 1.53.0`** and is the only version anything here has been
built or run against. Key dependency floors as built: `@backstage/frontend-plugin-api ^0.17.3`,
`@backstage/plugin-catalog-react ^3.2.0`, `@backstage/backend-plugin-api ^1.9.3`,
`@backstage/integration ^2.0.3`, `@backstage/catalog-model ^1.9.0`, Node `22 || 24`.

### The honest answer on a floor

**We do not yet know how far below 1.53 the plugin works, and we should not guess.** The
constraint is not the catalog APIs — `CatalogProcessor`, `EntityProvider`, `UrlReaderService` and
the relation constants have been stable for a long time. It is the **frontend blueprints**:
`EntityHeaderLayoutBlueprint` and `PluginHeaderActionBlueprint` are recent additions, and
`EntityHeaderLayoutBlueprint` is the one that forced the object-form filter. Those are what set
the floor.

**Recommendation:** state **1.53.0 as the verified minimum for v1**, and establish the real floor
with a compatibility matrix rather than a guess:

1. Stand up the reference app at 1.53, 1.52, 1.51 and 1.50.
2. For each: `yarn tsc`, boot, and run a scripted smoke path (register a collection → entity
   appears → docs tab renders → link by runtime → unlink).
3. Record the lowest version that passes, and what broke below it.
4. Publish the result as the `backstage-compat` table.

This is a day of work and it converts the single weakest claim in this document into a fact.

### API-surface risk, by area

| Area | Stability | Risk |
| --- | --- | --- |
| Catalog (`CatalogProcessor`, `EntityProvider`, relations) | High | Low |
| `UrlReaderService`, `ScmIntegrations` | High | Low — but credential *shapes* differ per provider and changed at least once |
| Permissions framework | Medium | Medium — not yet used by us |
| New **backend** system | High | Low |
| New **frontend** system blueprints | **Medium–low** | **The main upgrade risk.** `frontend-plugin-api` is pre-1.0 |
| MUI | Transitional | The app mixes `@material-ui` v4 and `@backstage/ui`; this migration is ongoing upstream and will need tracking |

### Maintenance implications

- A named owner for the Backstage upgrade cadence. Without one, a monthly-release platform
  outruns a plugin in a quarter.
- A CI matrix running the smoke path against the current and previous Backstage minors.
- The byte-stability etag test in CI (§3), because its failure mode is invisible.
- A watch on `frontend-plugin-api` release notes specifically — it is the dependency most likely
  to break us.

---

## §13 — Scope 12: Prior art

What we borrowed, and from where. Each of these was read in this repository's dependency tree
rather than recalled.

| Source | Pattern | Where we use it |
| --- | --- | --- |
| **`kind: API` / `ApiDefinitionCard`** | Store the definition **inline on the entity**; the card reads `entity.spec.definition` straight off React context with no fetch and no loading state | §4 — the whole storage decision |
| **`DefaultApiExplorerPage`** | `EntityListProvider` + `CatalogFilterLayout` + `CatalogTable`, kind picker hidden and pinned | §8 — the `/bruno` dashboard is a direct mirror |
| **`BuiltinKindsEntityProcessor`** | Emit relations from `postProcessEntity`, never `preProcessEntity`, so no relation is emitted for an entity that later fails validation | §7.3 |
| **`UrlReaderProcessor`** (catalog) and the TechDocs URL preparer | ETag-conditional reads, `NotModifiedError` → skip processing | §5 tier 2 |
| **`GithubEntityProvider`** | *A negative result*: its `kind: Location` emission is what a Bruno manifest cannot be parsed as | §6 — why we sweep ourselves |
| **`catalogImportApi` / the catalog's import flow** | The "generate a descriptor, open a pull request, then register it" shape, including linking to the catalog's own *Register an existing component* page as the final step | §15 modal 2 |
| **The scaffolder's `RepoUrlPicker`** | *Considered and not adopted*: the platform's own answer to per-provider URL grammar is a structured `repoUrl` (`host?owner=&repo=&…`) rather than parsing web URLs | §5 — revisit if pasted-URL parsing keeps producing bugs |
| **PagerDuty plugin** (cited in BRU-4488) | Database-backed entity linking with `CatalogProcessor` injection | *Cited from the ticket; not independently verified in this study. Re-read its current source before using it as precedent — our conclusion (a link belongs in a reviewed file first, a row second) may differ from theirs* |
| **GitHub Actions entity cards** (cited in BRU-4488) | Annotation-driven entity cards | *Same caveat. Note our own finding in §7.3 that annotation-gated visibility is a UX trap* |

One meta-lesson worth recording: **the platform's own answer is usually the right one, and when
it is not, the reason is specific and worth writing down.** Both of our deviations
(`GithubEntityProvider`, `catalogImportApi.submitPullRequest`) have a one-paragraph justification
in the source, and both would otherwise look like not-invented-here.

---

## §14 — Scope 13: Additional concerns surfaced by the study

Things the ticket did not list that this study found. Several are more important than some that
were listed.

### 14.1 Secrets reach the catalog in plaintext — **highest severity**

`spec.definition` mirrors Bruno's own "Generate docs" pipeline
(`transformCollectionToSaveToExportAsFile` → `brunoToOpenCollection` → YAML), deliberately, so a
collection documented from Backstage matches one documented from Bruno. **That pipeline redacts
in exactly one place:** `toOpenCollectionEnvironments` omits the value of an environment variable
flagged `secret` and emits `secret: true`.

Everything else is exported verbatim — auth passwords, tokens and client secrets (the converter's
auth mapping performs **no** redaction), header and query values, request bodies, scripts and
tests.

An earlier revision redacted secret-looking fields with a hand-rolled name-matching pass. It was
**removed**, because it made Backstage's output silently diverge from Bruno's for the same
collection. That is also why there is no redaction config knob.

Stated plainly, because it must be in the README and probably in the install flow: **the same
YAML is stored on a catalog entity, where the audience is anything that can read the catalog,
rather than one signed-in user entitled to one collection. A credential hardcoded in a `.bru`
file reaches the catalog in plaintext.**

**Open decision:** keep byte-parity with Bruno and document loudly, or diverge and redact. PoC 1's
production review called plaintext environment values a **policy breach** (`CMP-3`). Parity is
the current position; it should be an explicit, recorded choice rather than an inherited one.
*Flagged for the PRD.*

### 14.2 `resultHash` churn

Covered in §3, repeated here because it is invisible when broken and expensive: if the generated
definition is not byte-stable, every Bruno entity is rewritten and re-stitched every 100–150
seconds. Put the etag test in CI.

### 14.3 Multi-replica behaviour

PoC 1 failed here (per-process caches, a rebuild scheduler running on every replica → N× SCM
fetches, eviction that only touched the serving replica). PoC 2 is structurally better — the
catalog is the shared state — but it is **untested on more than one replica**. Specific things to
verify before Beta:

- Two `ManifestProbe` instances per process (plugin + module) is by design; N replicas means 2N
  caches, all revalidating. With tier-1 conditional requests this should be cheap, but it is
  unmeasured.
- The provider's scheduled task must be `scope: 'global'` so one replica sweeps, not all of them.
- `ManifestProbe.evict` is unwired precisely because it would be wrong across replicas (§3).

### 14.4 Testing

PoC 1 shipped with **zero** automated tests. PoC 2 has **11** test files, all unit-level, all on
pure logic (config parsing, entity accessors, URL parsing, the processor, discovery roots, ref
canonicalisation, descriptor generation, brand tokens). Missing, and needed before v1:

- Router tests with `supertest` covering **auth policies, the runtime-writes gate, and the
  SSRF allowlist** — these are security properties and deserve tests, not review.
- An integration test for the processor against a real catalog engine.
- A Playwright smoke path in the reference app, run against the compatibility matrix.

Commands, for the record: `CI=true yarn test --watchAll=false`, `yarn tsc`,
`yarn lint:bruno <paths>`. (Jest is v30 here — the flag is `--testPathPatterns`, plural.)

### 14.5 `bruno://` deep link is still a gap

`Open in Bruno` currently opens Bruno's hosted fetch endpoint
(`https://fetch.usebruno.com/?url=<repo root>`) in a new tab, with a **Clone & open in Bruno**
fallback that copies a `git clone` instruction. Bruno desktop handles only
`bruno://app/oauth2/callback`; there is no `open`/`clone` verb. Closing this properly is a change
in the **`bruno-electron`** repo and is its own workstream. Note also that only the repo *root*
is sent, not the deeper collection subpath — so a multi-collection repository opens at the wrong
level.

### 14.6 Pull requests are GitHub-only

`lib/unlinkPr.ts` speaks the GitHub contents/pulls API and nothing else. Capability is resolved
from the host app's configured `scmIntegrationsApi` (so self-hosted GHE works), but GitLab and
Bitbucket users get the runtime-link path or nothing. Backstage itself offers no unified write
abstraction — writes are seven separate scaffolder modules — so this is per-provider work, not a
missing abstraction.

Note we deliberately do **not** use `catalogImportApi.submitPullRequest`: it writes to the
repository *root* rather than the descriptor's real path, it can only create a file and never
update one, and it uses a fixed branch name so a second unlink collides with the first. Our own
flow edits the file through `yaml`'s `parseDocument` rather than `js-yaml`, because a round-trip
through the latter strips every comment — and a PR that silently deletes a team's comments will
not get merged.

### 14.7 Large-repo truncation

GitHub truncates recursive tree listings. The sweep warns and names the repository; collections
past the truncation point cannot be discovered, and a `bruno.collections[]` entry is the
documented way to reach them. Acceptable, but it should be surfaced in the UI rather than only in
logs.

### 14.8 Known divergences from Bruno's own exporter

Collection/folder request-defaults, settings, examples, tags and the full `brunoConfig` are absent
from our source model, and assertions are omitted. The output is **faithful-for-docs, not
byte-identical**. Worth stating in the README so nobody diffs the two and files a bug.

### 14.9 The dev-database caveat

The default dev config is `better-sqlite3` on `:memory:`, so UI-created collections and runtime
links do **not** survive a backend restart. The catalog is equally ephemeral, so the two stay
consistent and nothing ends up wrong — but a Postgres smoke test is a before-go-live item, and
this is worth a line in the README so an evaluator does not think they found a bug.

---

## §15 — Setup and usage guide

> Written as the shape of the README's install section. Steps marked **(v1)** are what an
> adopter will do; steps marked **(today)** describe the PoC as it stands.

### 15.1 Install

**1. Add the packages.**

```sh
yarn --cwd packages/app  add @usebruno/plugin-bruno
yarn --cwd packages/backend add @usebruno/plugin-bruno-backend
```

**2. Wire the backend** (`packages/backend/src/index.ts`):

```ts
import { brunoCatalogModule } from '@usebruno/plugin-bruno-backend';

// The Bruno backend plugin — serves /api/bruno/*
backend.add(import('@usebruno/plugin-bruno-backend'));
// The catalog module — teaches the catalog `kind: Bruno`, and materialises entities
backend.add(brunoCatalogModule);
```

The default export is the plugin; `brunoCatalogModule` is a **named** export. Both are needed:
without the module, `kind: Bruno` entities are rejected as an unrecognised kind.

**3. Wire the frontend** (`packages/app/src/App.tsx`, new frontend system):

```ts
import { createApp } from '@backstage/frontend-defaults';
import brunoPlugin from '@usebruno/plugin-bruno';

export default createApp({ features: [catalogPlugin, brunoPlugin /* … */] });
```

Optionally register the icon so `kind: Bruno` rows get the Bruno mark:

```ts
import { BrunoIcon } from '@usebruno/plugin-bruno';
// register as the `kind:bruno` catalog icon in your icons module
```

**4. Allow the kind** (`app-config.yaml`) — the step most likely to be missed:

```yaml
catalog:
  rules:
    - allow: [Component, System, API, Resource, Location, Bruno]
```

`catalog.rules` only *permits* the kind; recognition comes from the catalog module in step 2.
Both are required.

**5. Configure credentials.** Public `github.com`, `gitlab.com` and `bitbucket.org` need nothing.
A **private** repository — or **any** discovery sweep — needs the matching `integrations` block:

```yaml
integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
```

> Do not leave a partial or blank credential entry. An empty-string config value is **fatal** at
> startup for the whole backend, not just this plugin. Comment the block out instead.

A GitHub fine-grained PAT needs **Contents: Read**, **Metadata: Read**, and — because the
conditional-request revalidation path calls the commit-status endpoint — **Commit statuses:
Read**.

**6. Optional: suppress TechDocs on Bruno pages.** Both TechDocs entity surfaces ship with no
filter, so they appear on `kind: Bruno` pages that carry no `techdocs-ref`:

```yaml
app:
  extensions:
    - entity-content:techdocs:
        config: { filter: { $not: { kind: bruno } } }
    - entity-icon-link:techdocs/read-docs:
        config: { filter: { $not: { kind: bruno } } }
```

### 15.2 Add a collection — four ways

**(a) A `catalog-info.yaml` beside the collection** *(recommended; the only one that is reviewed
and travels with the repository)*:

```yaml
apiVersion: usebruno.com/v1alpha1
kind: Bruno
metadata:
  name: payments-collection
  title: Payments API
spec:
  type: bruno-collection
  url: https://github.com/acme/apis/tree/main/collections/payments
  owner: team-payments
  partOf:
    - api:default/payments-api
```

Register it like any other descriptor — `catalog.locations`, or the catalog's *Register an
existing component* page. **Merging the file is not the same as registering it**; that is the
step users most often miss.

**(b) `app-config.yaml`**, for collections the operator owns:

```yaml
bruno:
  collections:
    - type: url
      url: https://github.com/acme/apis/tree/main/collections/payments
      name: payments          # optional; default is the URL's last path segment
      owner: team-payments
      partOf: [api:default/payments-api]
```

Every key must stay under the single `bruno:` root. Nested under `proxy:` by mistake — YAML is
happy either way — the `schedule` block silently re-parses and the provider falls back to its
defaults with zero collections.

**(c) Org-wide discovery**, so a collection is catalogued by being *pushed*:

```yaml
bruno:
  discovery:
    - organization: acme
      host: github.com
      repositoryPattern: '.*-api'                 # anchored, over the repo NAME
      excludePathPattern: '(tests|examples|fixtures)/.*'   # anchored, over the repo-relative path
      owner: team-platform
      deferToCatalogInfo: true
```

**(d) The dashboard's Add collection button** — requires `bruno.allowRuntimeWrites: true`.
Paste the collection folder URL; it is probed server-side for a `bruno.json` or
`opencollection.yml`/`.yaml`; pick an owner and any APIs; then either **Create pull request**
(generates a `catalog-info.yaml`, which you still have to merge *and* register) or **Add
collection** (stores it in this instance only).

### 15.3 Link a collection to an API

From either side — the Bruno Collections card on an API page, or the Related APIs card on a
collection page. Both offer the same two methods:

- **Pull request** *(default)* — edits `spec.partOf` in the collection's `catalog-info.yaml`,
  authored by **you** (your own SCM token, via `scmAuth`). GitHub only, today.
- **Link in this Backstage instance** — a row in the Bruno backend, visible within seconds.
  Requires `bruno.allowRuntimeWrites`. Rows carry a **Runtime link** chip so you can tell them
  apart, because they are unlinked in completely different ways.

When no descriptor can be edited by pull request — a config entry, a UI-added collection, a
discovered collection, a `file:` location, or a non-GitHub host — the pull-request option is
disabled with the reason stated, rather than offered and then failing.

### 15.4 Everyday usage

| I want to… | Do this |
| --- | --- |
| See every collection | the **Bruno Collections** dashboard at `/bruno` — filter by owner, tag, or text; export CSV |
| Read a collection's docs | its entity page → **Bruno API Docs** tab |
| Open it in the Bruno app | **Fetch in Bruno** on the header or any row menu (opens `fetch.usebruno.com` with the repo root), or the dropdown's **Clone & open in Bruno** |
| Pull in a change made upstream | **Sync** on the entity header — the catalog's own refresh. Converges within `bruno.cacheTtlSeconds` |
| See which collections document an API | the **Bruno Collections** card on that API's page |

### 15.5 Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Entity registered but nothing on it | not processed yet | wait one processing cycle (100–150 s), or hit Sync |
| "No manifest found" on a URL that looks right | the URL points at the repo, not the collection folder | point at the folder holding `bruno.json` / `opencollection.yml` |
| Private repo unreadable although *you* can see it | there is **no per-user read path** | add the host's `integrations.*` credential |
| A collection added from the dashboard never appears | its name was claimed by a `bruno.collections[]` entry | the pending strip marks it **stalled** and offers Remove; rename and re-add |
| Docs tab empty on a big collection | over `bruno.definition.maxBytes` | raise the cap, or split the collection |
| Discovery finds nothing | anonymous rate limit (60/hr), or a bad `repositoryPattern` (it is **anchored**) | add `integrations.github`; check the pattern |
| Backend will not start | a blank `${VAR}` in an `integrations` block | comment the block out; `.env` is read **once** at process start and is not hot-reloaded |

---

## §16 — Risks register

| # | Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | **Secrets in generated docs reach the catalog in plaintext** | Policy breach at an enterprise adopter | High without action | §14.1 — decide parity-vs-redaction; document loudly; consider an install-time warning |
| R2 | **No authorization model** | Any user can mutate anything | Certain until fixed | §9 S2 — permissions + ownership |
| R3 | **SSRF / private-repo existence oracle** | Security review failure | Certain until fixed | §9 S1 — host allowlist before any fetch |
| R4 | **Staging CDN as a runtime dependency** | Broken installs; air-gapped installs impossible | High | §9 S4 — pin a production CDN or self-host |
| R5 | **Custom kind restricted by an org's `catalog.rules`** | Plugin unusable for that org | Medium | §2 — per-location allowance documented; `kind: API` fallback documented |
| R6 | **New frontend system only** | Silent non-adoption by legacy installs | Medium–high | §8 — keep rendering system-agnostic; add a legacy entry point if demand appears |
| R7 | **`frontend-plugin-api` churn** (pre-1.0, caret ranges) | Breakage on a Backstage upgrade | Medium | §12 — exact ranges, compat matrix, named upgrade owner |
| R8 | **Byte-stability regression → catalog churn** | Invisible load on every adopter's catalog | Medium | §3 — etag test in CI |
| R9 | **Multi-replica behaviour unverified** | Duplicate sweeps, N× SCM traffic | Medium | §14.3 — `scope: 'global'`, measure |
| R10 | **No migrations on the two tables** | No safe schema evolution after v1 | Certain if unaddressed | §4 — adopt Knex migrations before publishing |
| R11 | **Rate limit exhaustion on a large org** | Discovery fails loudly; collections vanish from view | Low–medium | §5/§6 — tier-1 revalidation, `pushed_at` gating, fail-closed sweep |
| R12 | **Non-GitHub adopters get a degraded product** (no discovery, no PRs) | Adoption ceiling | Medium | §5 — publish the support matrix honestly; sequence GitLab next |
| R13 | **`bruno://` verb absent** | The headline "open in Bruno" is a hosted-page redirect | Certain today | §14.5 — separate `bruno-electron` workstream |
| R14 | **Licensing / legal sign-off on `@usebruno/*` + the renderer** | Blocks publication | Unknown | §11 — get the answer before the first publish |
| R15 | **Zero security tests** | A regression re-opens a closed hole silently | High | §14.4 — supertest coverage of auth policies and the writes gate |

---

## §17 — Product-level calls flagged for the PRD

These are decisions this document deliberately does **not** make, because they are product calls.

| # | Question | Options | Engineering lean |
| --- | --- | --- | --- |
| **P1** | **Secret handling in generated docs.** Byte-parity with Bruno (exports verbatim) or diverge and redact? | parity + loud docs · redact + document the divergence · redact behind a config key | Parity is the current state and is defensible; but an enterprise security review will fail it. Recommend: parity by default, an opt-in `bruno.definition.redact` for regulated adopters. |
| **P2** | **Legacy frontend system support.** | new only · both · new now + legacy on demand | New now, legacy on demand — but this is an adoption number, not an engineering preference. |
| **P3** | **Theme fidelity.** Presets only, or the `postMessage` palette handshake? | T1 · T1+T2 | T1+T2. T2 needs a renderer change in another repo, so it needs scheduling, not just agreement. |
| **P4** | **Install DX: is `allowRuntimeWrites` on or off in the docs' recommended config?** | off (source control is truth) · on (better first-run experience) | Off. The whole "add from the dashboard" flow is a convenience, and an operator who wants it can read one line. |
| **P5** | **Is the docs playground ("try it out") in Beta scope?** | yes · yes without secret injection · defer | Defer the *execution* half. A playground that sends no credentials is worse than none, and server-side secret injection is its own design. |
| **P6** | **Package naming and licence.** | `@usebruno/*` vs `backstage-plugin-*`; licence TBD | Needs an answer before the first publish either way. |
| **P7** | **Do we ship the `kind: API` fallback for kind-restricted orgs?** | yes · document only · no | Document only for v1. |

---

## §18 — Open questions and unproven assumptions

Listed so nobody mistakes a belief for a finding.

1. **The real Backstage floor.** 1.53 is the only version verified. §12 describes the one-day
   matrix that would answer this.
2. **Multi-replica behaviour.** Never run on more than one replica.
3. **A real private read on GitLab and Bitbucket.** GitHub is proven with a real PAT. The other
   two have been verified only at the config-resolution and header-construction layer — no
   `readTree` has ever been issued against a private repository on either.
4. **Postgres.** Everything has run on in-memory SQLite. The `part_of` column type was chosen
   *specifically* for cross-dialect byte-identity, which means the risk is known and untested.
5. **`integrations.gitlab[].retry`** — documented, never exercised.
6. **HTTP-proxy honouring** — claimed as a benefit of using `UrlReader` over raw Octokit, never
   exercised.
7. **Entity size at scale.** No measurement of catalog database or memory impact at, say, 500
   collections with 1 MiB definitions. This directly tests §4's central decision and should be
   measured before Beta commits to it.
8. **PagerDuty / GitHub Actions prior art** — cited from the ticket, not independently read.
9. **Whether `deferToCatalogInfo: true` is the right default.** It is the safer default, but its
   cost (a repository whose descriptor nobody registered gets no collection at all) has not been
   seen in the wild.
10. **The renderer bundle's real CDN dependency set** — derived by statically auditing the staging
    bundle. It needs re-auditing against whatever production bundle ships, and the result is what
    the pinned CSP in §9 S3 will be built from.

---

## Appendix A — Entity reference

```yaml
apiVersion: usebruno.com/v1alpha1     # NOT backstage.io/v1alpha1
kind: Bruno
metadata:
  name: <required>                    # frozen before processing; cannot be enriched
  title: <optional>                   # authored wins; else derived from the manifest name
  description: <optional>             # authored wins; else from the manifest
  version: <optional>                 # authored wins; else from the manifest
  annotations:
    usebruno.com/origin: config|ui|discovery|file|descriptor
    usebruno.com/definition-omitted: size|error
    usebruno.com/definition-bytes: '<n>'
    usebruno.com/runtime-part-of: 'api:default/a,api:default/b'   # sorted, canonical
    backstage.io/source-location: 'url:<collection folder>/'
    backstage.io/managed-by-location: 'url:…'                     # the file to edit
spec:
  type: bruno-collection              # required
  url: <required>                     # the collection folder in source control
  owner: <optional>                   # → ownedBy/ownerOf; default kind Group
  partOf: [<optional>]                # → partOf/hasPart;   default kind API
  definition: <derived>               # generated OpenCollection 1.0.0 YAML
  requestCount: <derived>             # reported even when definition was omitted for size
  environments: [<derived>]           # string ARRAY — one search row per item
```

Relations emitted: `ownedBy`/`ownerOf` and `partOf`/`hasPart` (from `spec.partOf` **and** from
`usebruno.com/runtime-part-of`).

## Appendix B — Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `bruno.collections[].type` | — | Only `url`. Anything else is logged and skipped |
| `bruno.collections[].url` | — | The collection **folder** |
| `bruno.collections[].name` | last path segment of `url` | `metadata.name` override |
| `bruno.collections[].owner` | — | `spec.owner`; unprefixed → Group |
| `bruno.collections[].partOf` | `[]` | A bare string is accepted as a one-element list |
| `bruno.discovery[].organization` | — | Org, or a **user** login (falls back to the user endpoint on 404) |
| `bruno.discovery[].host` | `github.com` | Anything else needs an `integrations.github` entry |
| `bruno.discovery[].repositoryPattern` | every repo | **Anchored** regex over the repo *name* |
| `bruno.discovery[].excludePathPattern` | — | **Anchored** regex over the repo-relative path (`''` at root) |
| `bruno.discovery[].owner` | — | `spec.owner` for everything this entry finds |
| `bruno.discovery[].deferToCatalogInfo` | `true` | Leave a collection with a `kind: Bruno` descriptor to that descriptor |
| `bruno.allowRuntimeWrites` | `false` | Gates `POST /collections` and `POST /links`. `@visibility frontend` |
| `bruno.cacheTtlSeconds` | `60` | Probe TTL; also the upper bound on Sync latency |
| `bruno.definition.maxBytes` | `1048576` | Over it, the definition is **omitted, never truncated** |
| `bruno.schedule.frequencySeconds` | `60` | Provider tick — the latency of the dashboard's add and remove |
| `bruno.schedule.timeoutSeconds` | `30` | Per-run timeout |

Reading is **tolerant per entry**: a malformed entry is logged and skipped, never thrown. This
runs inside a scheduled task, and letting one bad entry reject the read would leave every *other*
configured collection unpublished on that tick and every tick after it.

## Appendix C — HTTP API

Base path `/api/bruno`.

| Method & path | Auth | Returns |
| --- | --- | --- |
| `GET /health` | unauthenticated | `{ status: 'ok' }` |
| `POST /collections/probe` | `user` | `{ found: true, format, manifestPath, name?, version?, description? }`, or `{ found: false, reason: 'no-manifest' }` (**200**), or `{ found: false, reason: 'unreadable', message }` (**400**) |
| `POST /collections` | `user` | `201`. **403** unless `allowRuntimeWrites` |
| `GET /collections` | `user` \| `service` | a `user` principal gets rows with `createdBy` omitted |
| `DELETE /collections/:name` | `user` | `404` when no stored row exists |
| `GET /links` | `service` | every runtime link, for the processor |
| `POST /links` | `user` | takes a **list** of API refs; all or none. **403** unless `allowRuntimeWrites` |
| `DELETE /links?collection=&api=` | `user` | singular — unlinking is a per-row action |
| `GET /entities/:namespace/:name/docs` | `user-cookie` | `text/html`, `?theme=light\|dark` |

Two shapes worth keeping: the probe's three outcomes are deliberately **not** three status codes
(`no-manifest` is a 200 because the read *succeeded*); and the DELETE's refs travel in the
**query string** because entity refs contain `:` and `/`, which a proxy in front of the backend
will decode early and route wrong if they are percent-encoded into a path segment.

## Appendix D — Source map

| Concern | File |
| --- | --- |
| Entity shape | `plugins/bruno-backend/src/types.ts` |
| Kind recognition, enrichment, relations | `plugins/bruno-backend/src/processor/BrunoKindProcessor.ts` |
| Entity materialisation (config + UI + discovery) | `plugins/bruno-backend/src/provider/BrunoCollectionEntityProvider.ts` |
| Fetch / detect / generate / cache | `plugins/bruno-backend/src/service/manifestProbe.ts` |
| OpenCollection generation | `plugins/bruno-backend/src/service/definitionBuilder.ts`, `openCollectionExport.ts` |
| SCM seam + adapters | `plugins/bruno-backend/src/scm/` |
| Conditional-request revalidation | `plugins/bruno-backend/src/scm/treeIdentity.ts` |
| Org sweep | `plugins/bruno-backend/src/discovery/` |
| Routes and auth policies | `plugins/bruno-backend/src/service/router.ts`, `src/plugin.ts` |
| Write models | `plugins/bruno-backend/src/store/` |
| Frontend extension declarations | `plugins/bruno/src/extensions.tsx` |
| Entity accessors (the read model the UI uses) | `plugins/bruno/src/lib/brunoEntity.ts` |
| Docs session + theme | `plugins/bruno/src/lib/docsSession.ts` |
| Pull-request flows | `plugins/bruno/src/lib/unlinkPr.ts`, `src/components/PartOfPr/` |

## Appendix E — Superseded documents

Recovered from git history for this study; not on `main`.

| Document | Date | Still useful for |
| --- | --- | --- |
| `docs/POC-PLAN.md` | 2026-08 | the original Q1–Q6 feasibility frame |
| `docs/POC-DECISIONS.md` | 2026-08-04 | decisions D1–D5, the GO verdict, and the native-viewer reasoning |
| `docs/POC-GAPS.md` | 2026-08-05 | G1–G10, the try-it-out gaps in particular |
| `docs/PRODUCTION-REVIEW.md` | 2026-08-07 | **the best security/ops checklist we have** — §9 is largely derived from it |
| `docs/MULTI-SCM-PLAN.md` | 2026-08-19 | blockers B1–B11 and the spike findings behind §5 |
| `docs/NEXT-STEPS.md` / `-2` / `-3` | 2026-08-06 | the caching lifecycle table and the docs-iframe design |
| `docs/execution/*` | various | per-phase plans (`P2`–`P9`, `N2`, `N3`, `N4`, `MSCM`, `SYNC`, `DOCS-AUTH`, `BE-P1/P2/UI`, `UI-P6/P7`) |
