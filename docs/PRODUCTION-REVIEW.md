# Bruno for Backstage — Production-Readiness Review

**Status:** POC (Phase 0). Produced 2026-08-07 by three parallel review passes
(frontend plugin, backend plugin, org-rollout risks). Companion docs:
[`POC-DECISIONS.md`](./POC-DECISIONS.md), [`POC-PLAN.md`](./POC-PLAN.md),
[`POC-GAPS.md`](./POC-GAPS.md).

**Overall verdict: NO-GO for org-wide production as-is.** Frontend ≈ 7/10,
backend ≈ 4.5/10. Both plugins pass `tsc` (0 errors) and lint. The gaps are
concentrated in the backend's security posture (authN/authZ, redaction, SSRF)
and a hard dependency on a staging CDN.

> **Severity legend:** P0 = must-fix before prod (security/correctness/data-loss),
> P1 = important, P2 = nice-to-have, P3 = polish.

## Already actioned from this review
- **[FIXED] Backend P0 — plaintext env-var leak on the unauthenticated
  `/collections/:id` JSON.** The raw detail is now run through
  `redactCollectionDetail` (same choke point as the YAML export): env-var
  values dropped, auth-block secrets → `<redacted>`. Live-verified. See
  `openCollectionExport.ts` / `router.ts:/collections/:id`. The *authentication*
  side of that finding (requiring creds / user-cookie on the read routes) is
  still open — see BE-1 below.

---

# 1. Frontend Plugin Review — `plugins/bruno/`

**Readiness: 7/10.** Well-structured POC-plus: typed end-to-end (no `any`, no
non-null assertions, discriminated-union state machines), a genuinely correct
gesture-safe OAuth flow, tokens never logged/persisted, async effects have
`cancelled` cleanup, both gates green. Held back by iframe trust posture, no
request cancellation/timeout, a single-tab connection-event bus, duplicated URL
validation, and some state-machine edge cases. Zero test coverage (greenfield).

## P0 — must fix before prod
- **FE-P0-1 · Iframe sandbox grants same-origin + scripts to a cross-origin backend doc.**
  `OcDocsFrame.tsx:139` — `sandbox="allow-scripts allow-same-origin"` on a
  backend-origin page generated from collection content pulled from arbitrary
  GitHub repos. If the backend doesn't rigorously escape collection-derived
  strings, this is stored-XSS executing on the backend origin (shared auth
  cookies). Fix is primarily backend (sanitize + tight CSP); on the frontend,
  document the trust dependency and reconsider whether `allow-same-origin` is
  required (a unique-origin frame + `postMessage` theme handshake removes the
  cross-origin-storage surface).
- **FE-P0-2 · Docs `src` built by hand-concatenating query string.**
  `BrunoClient.ts:56-59` / `OcDocsFrame.tsx:75-78` append `&v=${nonce}` to a URL
  already carrying `?theme=`. Fragile if params ever change. Assemble with
  `URLSearchParams` in one place (have `getDocsUrl` take the nonce / return a `URL`).

## P1 — important
- **FE-P1-1 · No request timeout/cancellation in `BrunoClient`.** Every call is a
  bare `fetchApi.fetch` with no `AbortSignal`; components drop results but the
  socket keeps running (backend does GitHub I/O + repo scans that can hang).
  Thread an `AbortSignal` through cancellable methods; add a client timeout.
- **FE-P1-2 · Connection-event bus is in-memory, single-tab, lost on reload.**
  `connectionEvents.ts` module-level `Map`. Common flow (connect on Overview →
  switch to API Docs tab) can miss the event; cross-tab never syncs;
  `CollectionsTab` doesn't subscribe at all. Back it with `BroadcastChannel`
  (+`storage` fallback), or move to a query cache with invalidation.
- **FE-P1-3 · `BrunoCard` picking path double-fetches; effect dep function-identity trap.**
  `BrunoCard.tsx:96-125` + `onLinked` (`:54-63`) fetch `getCollection`/
  `getConnection` twice after link. `picker` is fresh each render (excluded via
  eslint-disable) → latent stale-closure. Consume the connect result instead of
  re-fetching; wrap picker actions in `useCallback`.
- **FE-P1-4 · Duplicated, drift-prone GitHub URL validation.**
  `useCollectionPicker.ts:75-93` and `AddCollectionModal.tsx:29-47` are
  byte-identical; `hostname.includes('github')` accepts `github.evil.com`,
  `notgithub.io`, etc. Extract `validateGithubRepoUrl` to `lib/githubUrl.ts` and
  use an exact-host allowlist. Backend must validate independently.
- **FE-P1-5 · `linkWithGithub` re-scans and re-resolves by id — silent mismatch.**
  `useCollectionPicker.ts:232-284`. On the private-repo retry it re-runs
  `discover` and re-finds by `selectedCollectionId`; if the repo changed or the
  id derives differently with a token, `find` returns undefined → "no longer
  found." Cache the chosen `githubUrl` at `link()` time and reuse it.

## P2 — nice-to-have
- **FE-P2-1** `CollectionsTab` doesn't subscribe to connection changes (`CollectionsTab.tsx:35-56`).
- **FE-P2-2** `OpenInBruno` clipboard-failure fallback dumps a multi-line clone command into a `Snackbar` with no copy affordance (`OpenInBruno.tsx:51-54`) → use a dialog + read-only `TextField`.
- **FE-P2-3** `bruno://open` deep-link is a dead-end today (`OpenInBruno.tsx:42`); give feedback or disable until the verb ships.
- **FE-P2-4** Dead `mode?: 'single'` API surface (`useCollectionPicker.ts:21`).
- **FE-P2-5** `CollectionTreeCard` uses array index as React key (`:46,50`).
- **FE-P2-6** Dashboard search filters client-side over the whole loaded list (`CollectionsTab.tsx:60-73`).
- **FE-P2-7** `LinkApiTab` fetches all `kind:API` entities then filters client-side (`:37-47`); request a field subset.

## P3 — polish
- Fixed `height: '80vh'` iframe (`OcDocsFrame.tsx:19`); inline `style`/hardcoded rgba border bypassing theme (`BrunoCard.tsx:263`, `OpenInBruno.tsx:80`); redundant all-caps button labels; stale `plugin.ts:22` doc comment; missing `role="alert"` on error text (`BrunoCard.tsx:171`, picker fields `:113`).

## Cross-cutting themes (frontend)
1. **Duplicated logic that will drift** — `validateUrl` (2 copies) and a ~30-line annotation→connection resolve-and-fetch effect repeated across **four** components (`BrunoCard`, `OcDocsFrame`, `CollectionTreeCard`, `CollectionOverviewCard`). Extract a shared `useResolvedCollection(entity)` hook (~100 lines saved).
2. **Bespoke data-fetching instead of a cache** — every component hand-rolls state+effect+`cancelled`+error-normalize. Correct but large; causes the redundant fetches, stale-UI, and no-cancellation issues. A query lib (react-query/SWR) or `useAsync` would subsume it.
3. **Implicit trust boundary with the backend** — forwards user tokens + arbitrary GitHub URLs, embeds backend HTML with `allow-same-origin`. Make it an explicit documented contract.
4. **Low-signal errors** — raw backend messages shown verbatim; no user-friendly mapping.

## Suggested phased plan (frontend)
1. Security & trust boundary: confirm/enforce backend sanitization + CSP, reconsider `allow-same-origin` (FE-P0-1); dedupe + tighten URL validation (FE-P1-4); assemble docs URL safely (FE-P0-2).
2. Correctness: `AbortSignal`/timeout (FE-P1-1); `BroadcastChannel` bus + subscribe `CollectionsTab` (FE-P1-2/P2-1); fix `linkWithGithub` (FE-P1-5) and BrunoCard double-fetch (FE-P1-3).
3. Consolidation: shared `useResolvedCollection`; evaluate a query cache.
4. Testing (greenfield): `@backstage/frontend-test-utils` + Jest + RTL + MSW; priority = `useCollectionPicker` state machine, URL helpers, `BrunoClient` error normalization.
5. UX/scale polish: server-side search/pagination; remaining P2/P3.

---

# 2. Backend Plugin Review — `plugins/bruno-backend/`

**Readiness: 4.5/10.** Clean, well-commented, 0 tsc errors; parsing, LRU caches,
grace-window logic, and store idempotency are well-built. Not production-ready
on the security axis: the read surface is unauthenticated with no per-entity
authorization, there is no authorization model for mutations, a staging CDN is a
runtime dependency inside a broad CSP, per-process caches diverge under scaling,
and DDL is `hasTable`-guarded rather than migration-based. With the P0s closed
this reaches ~8/10. Live-verified on :7007 where noted.

## P0 — must fix before prod
- **BE-1 · Full collection contents served unauthenticated (+ detail JSON was un-redacted).**
  `plugin.ts:84-87` (`addAuthPolicy({ path:'/collections', allow:'unauthenticated' })`,
  a **prefix** match) exposes `/collections`, `/collections/:id`,
  `/collections/:id/docs`, `/collections/:id/opencollection.yml` with no token.
  Live-verified all return 200. The `.yml` export redacts secrets; the raw
  `:id` JSON did **not** (env values in plaintext) — **now fixed** via
  `redactCollectionDetail`. Still open: require `httpAuth.credentials` on
  `/collections`, `/:id`, `/opencollection.yml`; gate `/docs` behind
  **user-cookie** auth (it's the iframe `src`, no bearer token) rather than
  blanket-unauthenticating the whole prefix.
- **BE-2 · No authorization model — any authenticated user can mutate/delete any connection.**
  `router.ts:158-243`. Zero permission checks. `allow:['user']` proves only that
  the caller is *some* user; no ownership check on the target `entityRef`. Any
  user can rebind another team's entity to an attacker repo or delete any
  connection (`upsert` PK = `entity_ref` with `.onConflict().merge()` silently
  overwrites). Integrate `@backstage/plugin-permission-*`; enforce entity
  ownership (`userInfo` `ownershipEntityRefs`) on connect/import/delete.
- **BE-3 · SSRF — user URL fetched server-side; Octokit fallback not host-constrained.**
  `collectionService.ts:291-334` / `647-668` / `701-759` / `678-694`. The
  UrlReader path is integration-constrained (good), but the `userGithubToken`
  fallback `readUrlTreeViaOctokit` calls `parseGithubUrl` (no host validation)
  and defaults `apiBaseUrl` to `https://api.github.com` for unmatched hosts.
  Validate host up front (`integrations.github.byUrl(url)` must be defined)
  before any fetch; never fall through to a hardcoded API host.
- **BE-4 · Runtime dependency on a *staging* CDN with a broad CSP.**
  `generateOcDocsHtml.ts:2` (`staging.cdn.usebruno.com/api-docs`) +
  `router.ts:296-310`. Unversioned/unpinned ~8MB bundle; CSP allows
  `script-src ... https: blob:` with `'unsafe-eval'`/`'unsafe-inline'` and
  `frame-src https:` (live-verified). Move to a prod CDN with a pinned version +
  SRI; tighten CSP to exact hosts (drop bare `https:`); serve `/docs`
  authenticated.

## P1 — important
- **BE-5 · Two independent `createCollectionService` instances diverge.**
  `plugin.ts:42-46` (router) and `module.ts:36-40` (entity provider) each build
  their own caches/failures. Only the router runs `rebuildConnected`; the
  provider never sees connected collections; the dashboard reads the router's
  `failures`. Share one instance (custom service ref) or make both stateless.
- **BE-6 · In-memory caches are per-process — wrong under horizontal scaling.**
  `collectionService.ts:226-228, 341-364` + `plugin.ts:52-62`. Connect on
  replica A → miss on B until B's next tick; `bruno-connected-rebuild` runs on
  **every** replica (N× GitHub fetches); `evictConnected` only evicts the
  serving replica. Make the rebuild cluster-coordinated (`scope:'global'`)
  and/or back the connected cache with a shared store.
- **BE-7 · Ad-hoc `hasTable`-guarded DDL; no indexes; unbounded growth.**
  `connectionStore.ts:41-57`, `collectionsStore.ts:40-56`. No migrations → no
  safe schema evolution; `collection_id` unindexed on `bruno_connections`;
  `updated_at` is stringified ISO in a text column; `listAll()` is unbounded.
  Adopt Backstage Knex migrations; add indexes + `created_at`.
- **BE-8 · `/refresh` triggers a full re-read of all sources, gated only by "any principal".**
  `router.ts:246-249`. Protected from anonymous (401 verified) but any
  user/service token can force an unbounded full re-scan (GitHub included). No
  rate limit. Restrict to `service`/admin; debounce.

## P2 — nice-to-have
- **BE-9** User token in JSON body over default `express.json()`; minimal body validation (`router.ts:57,67-94,158-200`). Accept token via header; add `express.json({ limit })`; validate `githubUrl` host on import; schema-validate bodies.
- **BE-10** `rebuildConnected` sequential; `refresh()` unbounded `Promise.all`; Octokit fetches each blob individually (N+1) (`collectionService.ts:351-363,372,750`). Bound concurrency; per-fetch timeouts; GitHub 403/429 backoff; prefer `readTree`.
- **BE-11** Tree truncation only warns → silent partial collections on large repos (`collectionService.ts:726-730`). Fail or fall back per-directory; surface truncation.

## P3 — polish
- `</script` neutralization is correct for the JSON-in-script context (`generateOcDocsHtml.ts:36`); residual risk is the broad CSP only.
- Header/param/body **values** intentionally not redacted (documented R-D, `openCollectionExport.ts:19-22`). Post-auth, consider scrubbing `authorization`/`x-api-key`/`cookie` header names.
- `@usebruno/converters` typed `any` (ambient decl) → no compile-time safety at that boundary; `@octokit/rest` pinned to v19 (old). Add a minimal output interface; plan a bump.

## Cross-cutting themes (backend)
- **AuthN ≠ authZ, and neither is enforced on reads.** The dominant issue.
- **Per-process state assumes single replica** (caches, rebuild scheduler, eviction).
- **User-supplied URLs trusted deep into the fetch layer.**
- **External/staging deps embedded at runtime** with a permissive CSP.
- **Good instincts, incompletely applied** — redaction existed only in the export (now also in the detail); token-safe logging but tokens still travel in bodies.

## Quick wins (backend)
1. Require creds on `/collections*` except a purpose-built `/docs` (BE-1). — *detail JSON redaction already done.*
2. Restrict `/refresh` to `service` creds (BE-8).
3. Pin CDN version + SRI; drop bare `https:` from `script-src`/`frame-src` (BE-4).
4. Reject non-integration hosts up front in connect/discover (BE-3).
5. `express.json({ limit })` (BE-9).

## Suggested phased plan (backend)
1. Security gate: authenticate reads; per-entity authz on connect/delete/import; host-allowlist URL inputs + remove the unguarded Octokit fallback; tokens to headers.
2. Supply-chain/embedding: prod CDN + pinned version + SRI; tighten CSP; `/docs` behind user-cookie auth.
3. Scaling: unify to one shared service; cluster-coordinate the rebuild; shared connected cache; fix cross-replica eviction.
4. Data: Knex migrations; indexes + `created_at`; audit-log mutations.
5. Resource hardening: bounded concurrency + timeouts + GitHub backoff; truncation-as-error; batch blob reads.
6. Observability & types: fetch/failure metrics + audit trail; replace converter `any`; greenfield tests (`@backstage/backend-test-utils` + `supertest`) covering auth policy, redaction, SSRF allowlist.

---

# 3. Risks & Blockers Register — Org-Wide Rollout

**Scope:** platform-team adoption for all org teams on Backstage 1.53.
**Verdict: NO-GO as-is.** Well-built, honestly-documented POC, but its POC
security/operational shortcuts are disqualifying for multi-team production.

## Hard blockers (must-clear gate)
1. **SEC-1 + SEC-2 — Authenticate + redact reads.** Auth on `/collections/:id`,
   `/docs`, `/opencollection.yml`; redact detail JSON *(redaction done; auth
   pending)*. Env values were live-served in plaintext.
2. **SEC-3 / authz — Real authorization.** Replace allow-all policy; enforce
   entity ownership on connect/import/delete.
3. **OPS-4 — Remove guest auth from `app-config.production.yaml`** and wire org
   SSO (with SEC-1/3 this is anonymous write access today).
4. **SEC-4 — SSRF/token hardening.** Least-privilege GitHub credential (App, not
   org-wide PAT), host/org allowlist, prefer on-behalf-of user tokens.
5. **SCL-4 / OPS-2 — Eliminate the staging-CDN SPOF.** Self-host + pin + SRI the
   renderer bundle; never ship pointing at `staging.cdn.usebruno.com`.

## Risk categories (summary)
- **Security & privacy:** SEC-1 unauthenticated reads (prefix policy,
  `plugin.ts:80-87`); SEC-2 plaintext env-value leak (redaction was export-only —
  now fixed); SEC-3 no authz (allow-all policy, `packages/backend/src/index.ts:59`);
  SEC-4 SSRF w/ service token; SEC-5 broad docs CSP + `X-Frame-Options` removal;
  SEC-6 secrets-in-values not redacted; SEC-7 inherited permissive app CSP
  (`app-config.yaml:29-37`, no prod override).
- **Scalability & availability:** SCL-1 per-process caches; SCL-2 two service
  instances; SCL-3 per-replica scheduler → N× GitHub; SCL-4 staging-CDN SPOF;
  SCL-5 large-repo scans / truncation; SCL-6 no timeouts/bounded concurrency.
- **Data & persistence:** DAT-1 no migrations; DAT-2 dev SQLite vs prod PG gap
  (dev `:memory:` loses all data on restart); DAT-3 unbounded growth / no backup;
  DAT-4 orphan rows on entity delete.
- **Operational:** OPS-1 no metrics / trivial `/health`; OPS-2 CDN not
  pinned/rollback; OPS-3 no feature flag; OPS-4 guest auth in prod; OPS-5 single
  org-wide PAT / no rotation; OPS-6 no readiness gating.
- **Compatibility & maintenance:** MNT-1 new-frontend-system churn
  (`frontend-plugin-api ^0.17.3`, caret ranges drift the tested baseline); MNT-2
  `@usebruno/*` + renderer licensing/stability; MNT-3 ambient-`any` converter;
  MNT-4 zero tests; MNT-5 duplicated logic.
- **Adoption/UX at scale:** ADO-1 processor runs against every API entity every
  cycle (`BrunoLinkProcessor.ts:49-99`, whole-list fetch every 30s); ADO-2 no
  permissions (= SEC-3); ADO-3 name collisions (`sanitizeName`); ADO-4 onboarding
  docs; ADO-5 hardcoded `owner: 'guests'` / `lifecycle: 'experimental'`
  (`BrunoEntityProvider.ts:127`).
- **Compliance/legal:** CMP-1 data egress to multiple external origins from the
  docs UX; CMP-2 `@usebruno/*` + renderer licensing; CMP-3 plaintext env values
  = policy breach (tied to SEC-1/2).

## Before-go-live checklist
- [ ] Auth on all Bruno read routes; ~~redaction on detail JSON~~ **(done)**
- [ ] Permission checks + ownership; allow-all policy removed
- [ ] Guest provider removed from prod config; SSO wired
- [ ] GitHub credential scoped down; SSRF allowlist
- [ ] Renderer bundle self-hosted, versioned, SRI-pinned; docs CSP narrowed
- [ ] Knex migrations; Postgres smoke test
- [ ] Replica-safe / DB-backed cache read path; one service instance
- [ ] `bruno-connected-rebuild` coordinator-elected or DB-driven
- [ ] Backstage deps pinned to exact tested versions
- [ ] Tests for redaction, parsers, auth policy
- [ ] Provider `owner`/`lifecycle` configurable, not `guests`
- [ ] Processor load validated on a full-size catalog
- [ ] Legal sign-off on `@usebruno/*` + renderer licensing and data egress
- [ ] App-wide production CSP tightened

## After-go-live / operate checklist
- [ ] Metrics: fetch latency, cache hit rate, GitHub rate-limit headroom, source failures
- [ ] Meaningful `/health` (DB + CDN + source status); readiness gating
- [ ] Alerting on CDN availability + background-refresh failures
- [ ] Rollback / feature-flag for the suite and the renderer bundle
- [ ] DB growth/retention monitoring + backups; orphan-row cleanup on entity delete
- [ ] Backstage upgrade-cadence owner + new-frontend-system regression watch
- [ ] Onboarding docs, annotation conventions, discoverability

## Go/No-Go
**NO-GO for org-wide production in the current state.** None of the blockers are
architecturally deep — the design anticipates the fixes — but they are not
optional for a multi-team rollout. Clear the five hard blockers + the
before-go-live checklist and the suite is a reasonable candidate for a
**staged, opt-in Beta** with a small set of teams first.
