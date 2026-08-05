# Bruno for Backstage — Next Steps 2 (Bruno Page: Collections + Link API)

> Second-iteration plan, informed by the **UI mockup** for a dedicated Bruno page. Refines [`NEXT-STEPS.md`](./NEXT-STEPS.md) and absorbs [`DASHBOARD.md`](./DASHBOARD.md). Scopes a standalone **Bruno page** with two tabs — **Collections** (org dashboard) and **Link API** (link console) — plus the backend that powers them. The linking mechanism changes to a **catalog processor that injects the `bruno.dev/collection-path` annotation**, which is cleaner than the card-reads-DB approach in NEXT-STEPS and resolves its R5.

**Status:** 🟠 Scoped, not yet built · **Last updated:** 2026-08-05

---

## 1. What this plan covers (and deliberately does not)

**In scope — a Bruno page with exactly two tabs:**
- **Collections** — an org-wide dashboard: stat tiles, search, and a grid of collection cards.
- **Link API** — a console to attach a Bruno collection to a catalog API entity that has none, via **manual repo + path** entry, using a **catalog-processor annotation-injection** model.
- The **backend** that powers both: the connection store (DB), a `CatalogProcessor`, a catalog query for API entities, an aggregate endpoint for the dashboard, and a `bruno.json` verify-before-link check.

**Out of scope (per the requester):**
- **Test Runs** tab.
- **Setup & Workflow** tab.

**North-star — excluded here, tracked as future** (the mockup shows them, but they are large, uncertain, or beyond current data):
| Mockup element | Why deferred |
|---|---|
| "auto-discovered from Git" · **`142 repos`** | Org-wide repo crawling — a scaling project (GitHub org API, rate limits, cache). Current provider scans only configured sources. |
| **Match-% ranking** (`96% / 74% / 31%`, "OpenAPI matches") | Semantic collection↔spec comparison; a confident-but-wrong score erodes trust; only works where the API has a spec. Manual entry ships instead. |
| **"indexed · searchable"** (requests) | Full request-body search index. This plan's search is client-side over names/metadata. |
| **"linked entities · component bindings"** | Binding collections to `Component` entities — broader than APIs. |
| Rich **`team · domain`** ownership | Entities currently hardcode `owner: guests`; real ownership needs `bruno.json`/catalog data. |

The Collections dashboard here shows the tiles/cards with the **data we actually have** (see §5); the flashy numbers above are simulated in the mockup.

---

## 2. ⚠️ Placement principle (unchanged)

Auth wiring stays in the **app** (test harness — see [`NEXT-STEPS.md §4`](./NEXT-STEPS.md)). **Everything in this plan lives in the plugin:** the Bruno page + tabs (frontend, `plugins/bruno`), and the store + processor + routes (backend, `plugins/bruno-backend`). The page attaches via `PageBlueprint` + `NavItemBlueprint` (auto-registered; no `packages/app` edits).

---

## 3. Dependencies on NEXT-STEPS

This plan **builds on** [`NEXT-STEPS.md`](./NEXT-STEPS.md) and reuses:
- **Feature 1 (auth harness)** — needed to verify/fetch **private** repos during linking (service-token-then-user-OAuth) and for future "mine vs org" scoping.
- **The connection store (N1)** — the DB table is the shared source of truth for links; this plan adds the processor on top of it.
- It **supersedes** NEXT-STEPS Feature 2's "card reads the DB directly" mechanism with the processor model (§4). NEXT-STEPS Feature 3 (docs column) is unchanged and benefits automatically — once the annotation is injected, the existing card/tab/column filters attach with no extra work.

---

## 4. Linking model — catalog processor injects the annotation (the key change)

**Problem restated:** `BrunoEntityProvider` uses `type: 'full'` mutation and *owns* its entity set, so it cannot add an annotation onto an arbitrary, externally-owned API entity (NEXT-STEPS R5). A **`CatalogProcessor`** can — processors are allowed to augment entities they don't own during catalog processing.

**Mechanism (matches the mockup's "What linking does"):**
1. User links a collection to an API entity (via the Link API tab or the entity card). The backend **verifies** the repo+path contains a `bruno.json`, then **stores** `{ entityRef → github_url, collection_id }` in the plugin DB (the NEXT-STEPS N1 table).
2. A new **`BrunoLinkProcessor`** (registered through `catalogProcessingExtensionPoint`) runs on the next catalog refresh: for each entity it processes, it looks up a stored link by `entityRef` and, if found, **injects `bruno.dev/collection-path` (+ `bruno.dev/source-url`, `bruno.dev/collection-id`)** onto the entity.
3. The existing frontend filter (`spec.type`/annotation) then attaches the BrunoCard, the API Docs tab, and the docs-column card — no further wiring.
4. Refresh is **triggered automatically** after a link (poke the catalog / rely on the refresh loop), so it feels instant. **One click, no PR.**

**Optional durability:** offer a follow-up "persist to `catalog-info.yaml` via PR" so a team can make the YAML the source of truth. Keep this optional and secondary (it's the heavier path).

**Design wrinkle to resolve (R-A):** the processor runs inside the **catalog** backend module, while the store + write routes live in the **`bruno`** backend plugin (separate DBs). The processor must read the links across that boundary. **Recommended:** the processor reads links via an **internal service-to-service HTTP call** to the bruno backend (`GET /connections` bulk, using `auth`/`httpAuth` service credentials + discovery) rather than sharing a DB handle. Documented as a risk with this as the default resolution.

---

## 5. Collections tab (org dashboard)

Layout mirrors the mockup: header ("Bruno" · subtitle), tab bar, three stat tiles, a search box, and a 2-column card grid.

**Stat tiles** — grounded in current data:
| Tile | Value source | Notes |
|---|---|---|
| **Collections** | count from the aggregate endpoint | Drop the "across N repos" sub-line (that's org-crawl / north-star). |
| **Total Requests** | sum of `requestCount` | Drop "indexed · searchable" (north-star); label plainly. |
| **Linked Entities** | count of rows in the connection store | The links created via §4 (API entities only). |

**Search** — client-side filter over the loaded list (name, spec type, environment name). Not a backend full-text index.

**Collection card** — per the mockup, with corrected semantics:
- `B` icon + **collection name** (links to the entity's API Docs tab).
- `team · domain` **if available**, else omit (no hardcoded `guests`).
- **`linked`** badge when a connection row exists for the entity.
- **`N requests`** (`requestCount`), **`N envs`** (environments length), and the **active/default environment name** — e.g. `production`. *(Clarified: this label is the collection's selected/active environment, not a lifecycle. Since Bruno has no built-in "active env" marker, define it as the collection's default/first environment, or a user-chosen one later.)*
- **Spec-type badge** (`openapi` / `grpc` / …) = the **linked API entity's** `spec.type` (available on catalog API entities); Bruno-provider entities are `bruno-collection`.
- **`OPEN`** → the entity's API Docs tab (or Open-in-Bruno secondary).

**Backend:** an aggregate endpoint `GET /dashboard` (or extend `GET /collections`) returning per-collection `{ id, name, requestCount, envCount, activeEnv, specType, linked, entityRef }`, computed + cached server-side to avoid N frontend calls. Surface failed sources (today they're silently dropped in `collectionService.loadSource`) as an error state rather than omitting them.

---

## 6. Link API tab (link console)

Two-panel layout per the mockup.

**Left — "APIs without collections (N)":**
- List catalog entities of `kind: API` that **lack** the `bruno.dev/collection-path` annotation (via the catalog client). Each row: name, `team · domain` if present, spec-type tag (e.g. `graphql`), selectable.
- Keep the explanatory note: these entities exist (e.g. from `catalog-info.yaml`) but the linker won't auto-attach without confirmation.

**Right — "Link a Bruno collection to `<selected-api>`":**
- **Manual repo + path entry** is the **primary** path (match-ranked auto-discovery is north-star, excluded): input `org/repo#/path-within-repo`, a `LINK` action, and the helper text *"The plugin verifies the path contains a `bruno.json` before linking."*
- On `LINK`: backend **fetches + verifies** `bruno.json` at that path (reusing `readUrlTreeWithCreds` — public via service token, private via service-then-user-OAuth from NEXT-STEPS), then **stores** the link and **triggers** the processor injection (§4).
- Keep the **"What linking does"** explainer (store → processor injects annotation on refresh → one click, no PR → optional PR-to-YAML).

**No auto-discovery list** in this plan — the "DISCOVERED GIT COLLECTIONS · RANKED BY MATCH" section is intentionally omitted (north-star). The manual entry covers the same outcome without the org-crawl + scoring machinery.

---

## 7. Current-state facts this builds on (`file:line`)

- Backend list/detail already exist: `GET /collections`, `GET /collections/:id` (`plugins/bruno-backend/src/service/router.ts`). `FileTree → parseCollection` is source-agnostic (`collectionService.ts:331+`); `readUrlTree` (`:305–324`) is the fetch seam.
- Provider is full-mutation, cannot annotate arbitrary entities (`BrunoEntityProvider.ts`) → **why we add a processor**, not extend the provider.
- Catalog wiring already uses `catalogProcessingExtensionPoint` (`plugins/bruno-backend/src/module.ts:47–81`) — the same extension point registers the new processor via `catalog.addProcessor(...)`.
- Frontend filter attaches card/tab on annotation/`spec.type` (`plugins/bruno/src/extensions.tsx:13–15`) → injected annotation makes existing surfaces light up for free.
- No DB / `httpAuth` / `userInfo` wired yet (`plugins/bruno-backend/src/plugin.ts:19–24`) — added in NEXT-STEPS P2 and reused here.

---

## 8. Risks & blockers

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-A | **Processor ↔ store cross-plugin DB boundary** | Processor (catalog module) can't share the bruno plugin's DB directly | Processor reads links via internal service-to-service HTTP to the bruno backend (`GET /connections`, service creds + discovery). Documented as default. |
| R-B | **Refresh latency after link** | "Instant" may lag the catalog refresh loop | Trigger a targeted refresh / entity re-process on link; show an optimistic "linking…" state; fall back to the scheduled refresh. |
| R-C | **Catalog query cost** for "APIs without collections" | Large catalogs | Query `kind: API` with an annotation-absent filter + pagination; cache. |
| R-D | **`activeEnv` has no native source** | Card's env label is ambiguous | Define it as the default/first environment now; allow user selection later. |
| R-E | **Verify-before-link needs private creds** | Private repo link fails without a token | Reuse NEXT-STEPS service-then-user-OAuth; if unauthorized, prompt to connect GitHub (same flow). |
| R-F | **Optional PR-to-YAML path** | Write access + PR machinery | Keep optional/secondary; not required for the one-click link. |
| R-G | **Overlap with `/api-docs`** | Why a dedicated page | Justified by Bruno-specific tiles/cards + the link console; else fall back to a filtered catalog view. |

---

## 9. Phased implementation (sequenced; all PLUGIN unless noted)

- **N2-P1 — Link store + verify + routes (M).** Reuse/confirm the NEXT-STEPS connection store; add `POST /connections` with **`bruno.json` verify-before-link**; `GET /connections` (bulk, service-auth) for the processor; `DELETE /connections/:entityRef`. *`plugins/bruno-backend/src/service/router.ts`, `src/store/`, `src/service/collectionService.ts`.*
- **N2-P2 — `BrunoLinkProcessor` (M).** New `CatalogProcessor` registered via `catalogProcessingExtensionPoint`; reads links (R-A) and injects `bruno.dev/collection-path` + siblings; trigger refresh on link (R-B). *`plugins/bruno-backend/src/processor/`, `src/module.ts`.*
- **N2-P3 — Dashboard aggregate endpoint (S–M).** `GET /dashboard` with per-collection summary + `linked` + failed-source surfacing. *`plugins/bruno-backend/src/service/`.*
- **N2-P4 — Bruno page shell + Collections tab (M).** `PageBlueprint` + `NavItemBlueprint`; tab bar (Collections, Link API only); stat tiles; search; card grid with corrected env semantics. *`plugins/bruno/src/components/BrunoPage/`, `src/extensions.tsx`.*
- **N2-P5 — Link API tab (M).** Left "APIs without collections" (catalog client query); right manual repo+path link + verify + "what linking does" explainer. *`plugins/bruno/src/components/BrunoPage/LinkApi/`, `src/api/`.*

Effort: **S** ≈ <1 day · **M** ≈ 1–3 days · **L** ≈ >3 days (rough).

---

## 10. Verification

- **Link (public):** on the Link API tab, pick an unlinked API, enter a public `org/repo#/path` → verify passes → link stored → within one refresh the entity shows the BrunoCard + API Docs tab (annotation injected by the processor). Confirm `bruno.dev/collection-path` is present on the entity.
- **Link (private):** same with a private repo → service-token path when the org PAT can see it; otherwise the GitHub-connect prompt → user-OAuth fetch → link succeeds. Bad path (no `bruno.json`) → clean "not a Bruno collection" error, no link stored.
- **Collections tab:** tiles show real counts (collections, total requests, linked); cards show request count, env count, the active/default env name, spec-type badge, and `linked` where applicable; search filters live; a deliberately broken source shows as failed, not missing.
- **Unlink:** `DELETE` removes the row; after refresh the injected annotation is gone and the surfaces detach.
- **Scope guard:** no Test Runs / Setup & Workflow tabs; no match-ranking, org-crawl, or request-search present. No Bruno logic in `packages/app`/`packages/backend` beyond the auth harness.
