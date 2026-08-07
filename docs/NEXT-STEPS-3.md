# Bruno for Backstage — Next Steps 3 (Card picker · Dashboard import · YML export · OC-Docs iframe · Caching)

> Third-iteration plan. Builds on [`NEXT-STEPS.md`](./NEXT-STEPS.md) (runtime connect + store) and [`NEXT-STEPS-2.md`](./NEXT-STEPS-2.md) (Bruno page + link processor + the N2-P6 multi-collection discover machinery). Scopes five workstreams: (A) collection **selection in the BrunoCard**, (B) **Add-collection from the Bruno Dashboard**, (C) **Collection YML export**, (D) **OpenCollection docs rendering via iframe**, and (E) a concrete **cache strategy** for the backend collection caches.

**Status:** 🟠 Scoped, not yet built · **Last updated:** 2026-08-06

> **Planning only.** This document contains no executed changes. Every "confirm / verify" note below is an explicit pre-implementation step so nothing is assumed.

---

## 1. What this plan covers

| # | Workstream | One-liner |
|---|---|---|
| **A** | Collection selection in the card | The API-Catalog BrunoCard scans the repo, lists all collections, and lets the user link **exactly one** (auto-select if only one; show + allow changing the selected collection URL). |
| **B** | Add collection from the Dashboard | An **Add collection** button (top-right of the Bruno page) imports **one or more** collections from a repo into Backstage; linking to an API entity happens later via the Link subpage. |
| **C** | Collection YML export | Export the linked collection as a single **OpenCollection YAML** (mirroring Bruno's exporter), used to feed (D). |
| **D** | OC-Docs iframe rendering | On the **API Docs** tab, extract the collection YML and render it with the OpenCollection docs bundle inside a themed **iframe**. |
| **E** | Caching strategy | A defined lifecycle (when to build / update / evict) for the config cache, the connected cache, discover results, and the exported YML. |
| **F** | "Bruno" column in the API list | The API-Catalog list table (`/api-docs`) shows a **Bruno** column indicating whether each API entity is linked to a Bruno collection. |

**Out of scope / unchanged:** the auth harness placement (stays in the app), the north-star items excluded in [`NEXT-STEPS-2.md §1`](./NEXT-STEPS-2.md) (org-crawl "142 repos", match-% ranking, request full-text search), and the Test-Runs / Setup tabs.

---

## 2. ⚠️ Placement principle (unchanged)

Auth wiring stays in the **app** test harness. **Everything in this plan lives in the plugin** — the card states + dashboard modal + docs iframe (frontend `plugins/bruno`), and the export endpoint + cache lifecycle + any store change (backend `plugins/bruno-backend`). No Bruno feature logic in `packages/app` / `packages/backend`.

---

## 3. Grounding — how Bruno does import & export (investigated, not assumed)

The requester asked to look into how the Bruno app imports a collection from a GitHub URL and how it exports the YML. Findings from `~/Projects/bruno`:

### 3.1 Bruno's GitHub import = clone-and-scan (electron only)
- **Entry:** Import Collection → "Git Repository" tab (`packages/bruno-app/.../ImportCollection/GitHubTab.js`), validated via the third-party `git-url-parse` (`bruno-app/src/utils/git/index.js`).
- **Fetch:** a **full `git clone` to disk**, run in the **electron main process** via the `simple-git` library shelling out to the **system `git` binary** (`bruno-electron/src/utils/git.js` → `git.clone(url, path, ['--progress'])`; feature is gated on `git --version`). No GitHub API / Octokit / isomorphic-git.
- **Discovery:** `scanForBrunoFiles` walks the cloned tree (skipping `node_modules`/`.git`) and collects **every directory containing `bruno.json` OR `opencollection.yml`** (`bruno-electron/src/utils/filesystem.js`). A repo with several collections yields several candidates.
- **Selection:** the clone modal renders a **multi-select** list of found collections; invalid ones are shown as "skipped" (`bruno-electron/.../CloneGitRespository/index.js`). Selected paths → `openMultipleCollections`.
- **Auth:** **none in Bruno's code** — the URL is handed to system `git`, so auth is via the OS git credential helper, an SSH key, or an **embedded PAT** in the URL (Bruno only scrubs embedded `ghp_/gho_/…` tokens from *display*). No OAuth for cloning.
- **Reusability:** the clone-and-scan logic is **not** a shared package — it's electron-IPC-bound and needs a git binary.

### 3.2 Why the plugin diverges (and why that's correct)
A Backstage backend **cannot assume a git binary or clone to disk** for arbitrary repos. The plugin already does the server-appropriate equivalent:
- Fetches the repo **tree via `UrlReaderService` / Octokit** (`readUrlTreeWithCreds`) using the **anonymous/App default, then user-OAuth fallback** — the **service/App credential** never reaches the browser (RISK #1). (The user's own private-repo OAuth token *originates* in the browser by design; it's passed through for a single backend fetch and never persisted.)
- Scans for **the same two markers** (`bruno.json` / `opencollection.yml`) via `findAllCollectionRoots`, exposed as `POST /connections/discover` and the client `discover()` (**N2-P6**).

**Takeaway:** the plugin's `discover` is the API-tree analog of Bruno's clone-scan. Features A and B **reuse `discover`**; they do not add a new fetch mechanism. Bruno's *single-open* vs *multi-open* distinction maps cleanly onto A (pick one) vs B (pick many).

### 3.3 Bruno's YML export (single-file, bundled)
- `ShareCollection` → "Single File (YAML)" → `exportCollection` (`bruno-app/src/utils/exporters/opencollection.js`):
  1. `transformCollectionToSaveToExportAsFile(collection)` prep + `filterTransientItems`.
  2. `brunoToOpenCollection(collection)` (`@usebruno/converters`) → an OpenCollection `1.0.0` object (`opencollection`, `info`, `config`, `items`, `request`, `docs`, `bundled: true`, `extensions.bruno`).
  3. Stamp `extensions.bruno.exportedAt` + `exportedUsing`.
  4. `jsyaml.dump(oc, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false })` → `<name>.yml`.
- **Docs live inline** as markdown at three levels: collection (`docs: {content, type:'text/markdown'}`), folder (`ocFolder.docs`), and per request (`ocRequest.docs`).
- **Converter input** is Bruno's *in-memory* collection shape (`BrunoCollection` — items tree of `.bru`-parsed requests, `root`, `brunoConfig`, `environments`), **not** the plugin's `NormalizedCollection`. This gap is the crux of Feature C (§6).

---

## 4. Feature A — Collection selection in the BrunoCard

**Current behaviour (to change):** the card connects the pasted URL **directly** — `brunoApi.connect(entityRef, url)` (`plugins/bruno/src/components/BrunoCard/BrunoCard.tsx`), with no scan. A repo with multiple collections silently links against whatever the URL resolves to.

**Target behaviour (mirrors Bruno's clone-modal, single-select):**
1. **Paste URL → Scan.** On connect, call `discover(url)` (existing `POST /connections/discover`) instead of connecting immediately.
2. **Resolve candidate count:**
   - **0** → clean error: *"No Bruno collections found in this repo."* Nothing linked.
   - **1** → **auto-select** it; connect straight away (no dropdown), then show the connected state.
   - **>1** → render a **dropdown** of candidates (`name` + `collectionPath` + request count). Link stays disabled until one is chosen; on choose → `connect(entityRef, candidate.githubUrl)`.
3. **Show the selected collection.** The connected card displays the **selected collection's fully-qualified URL** (the sub-path-encoded `githubUrl` already persisted by N2-P6), so it's unambiguous which collection is linked.
4. **Allow changing it.** A **"Change collection"** affordance re-opens the picker for the same repo and re-links the chosen candidate (overwrite the connection row for this `entity_ref`).

**Reuse:** the **Link API tab already implements Scan→pick→Link** (`LinkPanel.tsx`, N2-P6). Extract that into a shared **`CollectionPicker`** component consumed by both `LinkPanel` and `BrunoCard`, so the two stay consistent. Gesture-safe OAuth (for private-repo scan) is already handled in both LinkPanel and the card's connect path — reuse it.

**Design notes / to confirm:**
- **"Change" needs the repo root.** The persisted `githubUrl` points at the *collection* sub-path. To re-scan for siblings, the card needs the **repo-root URL**. Options: (a) re-derive the root from the collection URL, or (b) persist the original scanned root alongside the connection. *Decision to lock (§10, D-A).*
- **Selection is still one-per-entity** — `entity_ref` is the store PK; unchanged from N2-P6.

*Files (frontend, plus a tiny backend read):* `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx`, new shared `plugins/bruno/src/components/CollectionPicker/`, `plugins/bruno/src/components/BrunoPage/LinkApi/LinkPanel.tsx` (refactor to the shared picker), `plugins/bruno/src/api/` (already has `discover`), and confirming `GET /connections/:entityRef` returns the fully-qualified URL for display.

---

## 5. Feature B — Add collection from the Bruno Dashboard

**Goal:** a third way to add collections (beyond config and the API-Catalog card) — an **Add collection** button at the **top-right of the Bruno page**, importing **one or more** collections from a repo. Imported collections appear in the dashboard and can be **linked later** to an API entity via the Link subpage.

**Flow (mirrors Bruno's clone-modal, multi-select):**
1. Click **Add collection** → modal with a GitHub repo URL input.
2. **Scan** via `discover(url)` → list of candidates with **checkboxes** (multi-select; "select all"), plus a "skipped/invalid" note for non-collections — the same shape Bruno surfaces.
3. **Import selected** → persist each chosen collection as an **imported-but-unlinked** record.

**The data-model decision this forces (the main architectural item):**
Today the only store is `bruno_connections`, keyed by **`entity_ref` (PK)** — it *requires* an API entity. "Import without linking" has **no entity**. So Feature B needs one of:
- **Option 1 (recommended): a separate `bruno_collections` table** keyed by `collection_id` — holds imported collections (`collection_id`, `github_url`, `name`, `imported_by`, `updated_at`). `bruno_connections` then becomes purely the **collection↔entity link** (add a `collection_id` FK). Clean separation: *imported* vs *linked*.
- **Option 2: nullable `entity_ref`** in `bruno_connections` with an `imported`/`linked` status. Less code, but overloads one table and complicates the PK/uniqueness.

*Decision to lock (§10, D-B).* This also **reconciles with N2-P5's Link API tab**: the Link subpage now links an **already-imported** collection to an unlinked API entity (dropdown of imported collections), instead of only manual repo+path entry — the manual entry becomes the "import + link in one step" shortcut.

**Dashboard surface:** the Collections tab's aggregate (`GET /dashboard`) must union config-materialized + connected + **imported-unlinked** collections, with a `linked` badge only where a `bruno_connections` row exists. An imported-unlinked card shows an **"Link"** action that deep-links to the Link subpage with that collection preselected.

*Files:* `plugins/bruno/src/components/BrunoPage/` (Add-collection button + modal, reusing `CollectionPicker` in multi-select mode), `plugins/bruno-backend/src/store/` (new table / model change), `plugins/bruno-backend/src/service/router.ts` (`POST /collections/import`, list imported), `plugins/bruno-backend/src/service/collectionService.ts` (dashboard union).

---

## 6. Feature C — Extracting Collection YML

**Goal:** produce a single **OpenCollection YAML** string for a linked collection, to feed the docs iframe (D) and to offer as a download.

**The core problem:** Bruno's `brunoToOpenCollection` consumes Bruno's **in-memory `BrunoCollection`** shape; the plugin holds a **`NormalizedCollection`** (different shape). So the plugin can't call the exporter directly on its cache. Paths considered:

- **Path 1 — serialize from the raw `FileTree`.** The backend already fetches the raw `.bru`/`.yml` files during connect (`readUrlTreeWithCreds` → `FileTree`). Build the OpenCollection object from those raw files (the same inputs Bruno's filestore parses), then `js-yaml` dump with Bruno's exact options. *Most faithful to Bruno's output.* Requires retaining or re-fetching the `FileTree` (today it's transient — §7 cache note).
- **Path 2 — map `NormalizedCollection` → OpenCollection.** Write a `normalizedToOpenCollection(collection)` serializer in the plugin (items tree → `items`, `environments` → `config.environments`, `readme`/docs → `docs`, etc.) and `js-yaml` dump. No re-fetch; works from the existing cache. Risk: drift from Bruno's canonical output.
- **Path 3 — pass-through when the source is already OpenCollection.** If the collection's source is `opencollection.yml` (single or multi-file), bundle/emit directly; only `.bru` sources need conversion.

**To confirm before choosing (do not assume):** the plugin already depends on **`@usebruno/converters@^0.22.0`** and **`@usebruno/filestore@^0.11.0`**. **Verify the exact export surface of the installed 0.22.x** (the local Bruno monorepo is `0.1.0` and its `brunoToOpenCollection` may not exist / may differ at 0.22). If 0.22 exposes a raw-files→OpenCollection or Bruno-collection→OpenCollection function, prefer **Path 1** built on it; otherwise **Path 2**. *Decision to lock (§10, D-C).*

**Endpoint:** `GET /collections/:id/opencollection.yml` returning `text/yaml` (raw), and/or `GET /collections/:id/opencollection.json` returning `{ yaml, theme? }` for the iframe host. Stamp `extensions.bruno.exportedAt/exportedUsing` like Bruno.

**Secrets:** the collection may embed auth secrets (`mapAuth` returns them — NEXT-STEPS R9). Exporting/rendering them widens exposure. **Decide redaction** (strip secret values before export) *(§10, D-D)*.

**Caching:** **derive on demand** — do not cache the YML bytes (see §8). Optionally memoize per `collection_id` keyed on the cache entry's identity, invalidated whenever the collection is re-fetched.

*Files:* `plugins/bruno-backend/src/service/collectionService.ts` (serializer), `plugins/bruno-backend/src/service/router.ts` (endpoint), `plugins/bruno-backend/src/api/`/`plugins/bruno/src/api/` (client method).

---

## 7. Feature D — Rendering OpenCollection docs via iframe

**Goal:** on the **API Docs** tab, fetch the collection YML (C) and render it with the OpenCollection docs bundle inside an **iframe**, themed to Backstage.

**Host HTML (the requester's template — `collectionData` is the only variable that changes):**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{name}} - API Documentation</title>
    <style>
        body { margin: 0; padding: 0; }
        #opencollection-container { width: 100vw; height: 100vh; }
    </style>
    <link rel="stylesheet" href="https://staging.cdn.opencollection.com/docs.css" />
    <script src="https://staging.cdn.opencollection.com/docs.js"></script>
</head>
<body>
    <div id="opencollection-container"></div>
    <script>
        const collectionData = {{JSON-encoded YML string}};
        new window.OpenCollection({
            target: document.getElementById('opencollection-container'),
            opencollection: collectionData,
            theme: '{{light|dark}}'
        });
    </script>
</body>
</html>
```

**Wiring:**
- **Where:** the iframe is the content of the existing API Docs tab (`plugins/bruno/src/components/CollectionDocs/…` area). Host via **`srcdoc`** (self-contained string) with a **`sandbox`** attribute.
- **Theme:** read Backstage's active theme (`appThemeApi` / `useTheme`) → `'light' | 'dark'` → into the `OpenCollection({ theme })` call. **Re-render the iframe on theme change.**
- **Safe injection (must):** build `collectionData` with **`JSON.stringify(yamlString)`**, not naive string concatenation — YAML can contain `"`, backticks, and `</script>`. Consider splitting any `</script>` sequence defensively.

**Decisions / risks this raises (call out explicitly):**
- **D-E — OC-docs vs the native viewer.** The plugin already ships a **native Collection Docs viewer + Try-it-out** (POC decision D2). Feature D makes the API Docs tab an **OpenCollection iframe** instead. Decide: does the iframe **replace** the native viewer, sit in a **separate tab**, or a **toggle**? And does OpenCollection's `docs.js` provide its own try-it-out (making the native one redundant)? *Lock this — it's a material product decision, not a detail.*
- **D-F — CDN dependency.** `staging.cdn.opencollection.com` is (a) **staging**, not a stable/pinned prod asset, and (b) an **external egress**, which conflicts with the POC's self-contained/zero-CDN stance (D5) and may violate a host Backstage **CSP** or break **air-gapped** installs. Options: pin a **versioned prod CDN URL**, or **self-host `docs.js`/`docs.css`** as plugin static assets. *Lock (§10, D-F).*
- **D-G — iframe sandbox.** The iframe runs third-party JS. Use `sandbox="allow-scripts"` (avoid `allow-same-origin` so it can't reach Backstage's origin/session). Confirm `docs.js` works under that sandbox and that the CDN is reachable from a sandboxed frame under the host CSP.
- **D-H — secrets in rendered docs.** Ties to D-D — if secrets aren't redacted in C, they render in the iframe.

*Files:* `plugins/bruno/src/components/CollectionDocs/` (new `OcDocsFrame` component + tab wiring), `plugins/bruno/src/api/` (fetch YML).

---

## 8. Feature E — Caching strategy (build / update / evict)

Grounded in the current caches (`plugins/bruno-backend/src/service/collectionService.ts`): a `cache` (config sources, cleared+rebuilt every scheduled tick — default 60s) and a `connectedCache` (runtime connections) that is **never cleared, never refreshed, never evicted on disconnect** — an unbounded `Map` that only resets on process restart. Two of the items below are **correctness fixes**, not tuning.

### 8.1 Lifecycle table
| Event | Config `cache` | `connectedCache` (+ imported, per §5) |
|---|---|---|
| **Startup** | Eager full load (as now). | Rehydrate from the store rows (`bruno_connections` / `bruno_collections`). |
| **Scheduled tick** (`frequencySeconds`) | Full rebuild (as now). | Rebuild from the store; re-fetch each **service-visible** collection; **drop entries whose row is gone** (self-bounding, kills disconnect ghosts). |
| **Connect / reconnect / import** | — | Write-through `.set` (immediate). |
| **Disconnect / delete (DELETE)** | — | **Evict the entry immediately** (⚠️ fix — today it isn't). |
| **TTL expiry** (per entry, e.g. 5–15 min) | n/a | Serve stale, refresh lazily on next access (stale-while-revalidate). Covers **user-token private** repos the scheduler can't re-fetch. |
| **Size/byte cap exceeded** | n/a | **LRU-evict**; re-fetch on demand (⚠️ backstop against unbounded growth). |
| **Process restart** | Clears; startup rehydrates. | Clears; startup rehydrates. |

### 8.2 Credential caveat (shapes the refresh)
The scheduled re-fetch uses the **host credential** (anonymous/App/PAT — whatever `integrations.github` resolves, like config sources): it can refresh public + service-visible-private collections. **User-token private** collections can't be background-refreshed (that token is never persisted — correct posture), so those rely on **TTL + refresh-on-next-authenticated-access**.

### 8.3 Discover-result cache (for §4/§5 "change collection")
Cache a repo's `discover` result **briefly per session** (keyed by normalized repo URL) so re-opening the picker / "Change collection" doesn't re-walk the tree. Short TTL; not durable.

### 8.4 Exported YML (§6)
**Derive on demand; do not cache the bytes.** If a hot path emerges, memoize per `collection_id` keyed on the cache entry's fetch identity and invalidate on any re-fetch. A frontend `useAsync` / stale-while-revalidate around the API-Docs YML fetch is the right place to avoid iframe re-spins on tab switches — a UX layer over the backend cache, never a replacement.

---

## 9. Feature F — "Bruno" column in the API list table

**Goal:** in the API-Catalog list at **`/api-docs`**, add a **Bruno** column so a user can tell at a glance which API entities are linked to a Bruno collection — without opening each entity.

**Signal (no extra fetch):** the **`bruno.dev/collection-path` annotation** injected by the **`BrunoLinkProcessor`** (N2-P2) is the unified "connected" marker — present on both card-connected and Link-tab-linked entities after a catalog refresh. A custom column cell reads `entity.metadata.annotations['bruno.dev/collection-path']` client-side and renders:
- **Linked** → a badge (✓, optionally the collection name), clickable to the entity's **API Docs** tab.
- **Not linked** → a subtle "—".

**Feasibility & the placement wrinkle (confirm, do not assume):**
- The API list table is the **API explorer page from `@backstage/plugin-api-docs`**, not our plugin. Columns are customizable, but the page belongs to that plugin.
- In the **new frontend system**, customizing its columns means either (a) an **extension override** of the api-docs explorer table, or (b) mounting a **custom API explorer page** with an extra column. **Confirm which is possible** before building. A custom column is a *feature*, so it should be contributed by our plugin where possible; if the only route is swapping the explorer page, that swap is thin glue (like the `SignInPage`) but is an **app-side touch** — so it bumps the placement principle. *Decision to lock (§10, D-I).*
- **Alternative signal** if annotation lag is a concern: a bulk `GET /connections` cross-referenced by `entityRef` — but that's a fetch on every table render; **prefer the annotation** (zero fetch, already injected).

**Freshness caveat:** a just-connected entity gets the annotation only on the **next catalog refresh** (ties to N2-P2's refresh-on-link, R-B), so the column may briefly show "not linked" until the processor runs.

**Nice-to-have:** make the column **filterable/sortable** by connected state ("show only APIs with Bruno collections").

*Files:* a small `BrunoStatusColumn` cell component in `plugins/bruno`, plus the explorer-page override/registration point (confirm: plugin extension override vs an `packages/app` page swap, per D-I).

---

## 10. Decisions to lock before building (do not assume)

| # | Decision | Options | Default lean |
|---|---|---|---|
| **D-A** | "Change collection" needs the repo root (§4) | (a) re-derive root from collection URL · (b) persist the scanned root on the connection | (a), fall back to (b) if derivation is lossy |
| **D-B** | Imported-vs-linked data model (§5) | (1) new `bruno_collections` table + FK · (2) nullable `entity_ref` + status | (1) — clean separation |
| **D-C** | YML serialization path (§6) | Path 1 (raw files) · Path 2 (`NormalizedCollection` mapper) · Path 3 (OC pass-through) — **after confirming `@usebruno/converters@0.22` export surface** | Path 1 if the converter supports it, else Path 2 |
| **D-D** | Redact secrets in exported YML (§6/§7) | redact · keep | redact |
| **D-E** | OC-docs iframe vs native viewer (§7) | replace · separate tab · toggle | decide with requester — product call |
| **D-F** | CDN for `docs.js`/`docs.css` (§7) | staging CDN · pinned prod CDN · self-host assets | self-host or pinned prod (CSP / offline) |
| **D-G** | iframe sandbox model (§7) | `allow-scripts` only · looser | `allow-scripts` only |
| **D-I** | How to register the API-list Bruno column (§9) | plugin extension override of the api-docs table · custom explorer page in `packages/app` | plugin extension override if the new frontend system allows it; else app page swap (thin glue) |

---

## 11. Risks & blockers

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Data-model split** (D-B) touches the store + every read path | Largest change; migration | Additive table + backfill; keep `bruno_connections` as the link table |
| R2 | **`@usebruno/converters@0.22` API unknown** (D-C) | Feature C blocked if no usable export | Confirm export surface first; fall back to a plugin-side serializer (Path 2) |
| R3 | **CDN staging URL + external egress** (D-F) | Broken/air-gapped/CSP installs; staging instability | Self-host or pin a prod asset; document the host-CSP requirement |
| R4 | **Unsafe `collectionData` injection** | XSS in the docs iframe | `JSON.stringify` the YAML; `</script>` splitting; sandboxed iframe |
| R5 | **Secrets in exported YML** (D-D, ties to NEXT-STEPS R9) | Secret exposure in docs/download | Redact before export |
| R6 | **OC-docs replaces a POC deliverable** (D-E) | Native viewer + Try-it-out may become dead code | Explicit product decision; delete or gate the native viewer accordingly |
| R7 | **Unbounded `connectedCache`** (existing) | Slow memory growth; disconnect ghosts | Evict-on-disconnect + DB-driven rebuild + LRU/TTL (§8) |
| R8 | **Private-repo scan needs a token** | Scan fails on private without creds | Reuse service-then-user-OAuth (N2); prompt to connect GitHub |
| R9 | **Bruno's clone-based import ≠ plugin's API-tree read** | Behavioural differences (e.g. very large repos, submodules) | Documented (§3); plugin uses `UrlReader`/Octokit tree read — no git binary, no clone |
| R10 | **API-list column registration in the new frontend system** (D-I) | May require an app-side explorer-page swap, bumping the placement principle | Confirm plugin-extension override first; treat any app swap as thin glue and document it |
| R11 | **Bruno column freshness lag** | A just-connected entity shows "not linked" until the next catalog refresh | Accept brief lag; pair with N2-P2 refresh-on-link (R-B); annotation is the zero-fetch signal |

---

## 12. Phased implementation (sequenced; all PLUGIN)

- **N3-P1 — Cache lifecycle hardening (§8) (S–M).** Evict-on-disconnect; DB-driven rebuild of `connectedCache` on the existing scheduler; TTL + LRU/byte bound; discover-result session cache. *(Two correctness fixes here — do this first; it also underpins C's on-demand export.)* `plugins/bruno-backend/src/service/collectionService.ts`, `router.ts`.
- **N3-P2 — Collection picker in the BrunoCard (§4) (M).** Shared `CollectionPicker`; card Scan→pick(one)→link; auto-select single; show selected URL; "Change collection". Refactor `LinkPanel` onto the shared picker. `plugins/bruno/src/components/BrunoCard/`, `CollectionPicker/`, `BrunoPage/LinkApi/`.
- **N3-P3 — Imported-collections model + Dashboard Add-collection (§5) (M–L).** Lock D-B; add the store table/migration; `POST /collections/import`; Add-collection modal (multi-select); dashboard union + `linked` badge + Link deep-link; reconcile the Link subpage to select imported collections. `plugins/bruno-backend/src/store/`, `router.ts`, `collectionService.ts`, `plugins/bruno/src/components/BrunoPage/`.
- **N3-P4 — Collection YML export (§6) (M).** Confirm D-C; serializer + `GET /collections/:id/opencollection.yml`; secret redaction (D-D); client method. `plugins/bruno-backend/src/service/`, `plugins/bruno/src/api/`.
- **N3-P5 — OC-Docs iframe on API Docs (§7) (M).** `OcDocsFrame` (srcdoc + sandbox + safe injection); theme wiring + re-render; lock D-E/D-F/D-G. `plugins/bruno/src/components/CollectionDocs/`.
- **N3-P6 — "Bruno" column in the API list (§9) (S).** Confirm D-I; `BrunoStatusColumn` reading the `bruno.dev/collection-path` annotation; register via plugin extension override (or app page swap); optional filter/sort. `plugins/bruno/src/…`, explorer-page registration point.

Effort: **S** ≈ <1 day · **M** ≈ 1–3 days · **L** ≈ >3 days (rough).

**Suggested order:** P1 (correctness + foundation) → P2 (card picker, reuses existing discover) → P6 (Bruno column — small, high-visibility, only needs the existing annotation) → P4 (YML export) → P5 (docs iframe) → P3 (data-model split — largest, can land last). P4+P5 are the visible "docs" win; P3 is the biggest architectural change.

---

## 13. Verification (per workstream)

- **A — card picker:** a multi-collection repo → dropdown of all collections; single-collection repo → auto-selected, no dropdown; none → clean error, nothing linked. Connected card shows the selected collection URL; "Change collection" re-scans and re-links; reload rehydrates the same selection.
- **B — dashboard import:** Add-collection → scan → multi-select → import; imported collections appear on the Collections tab as **unlinked**; the Link subpage lists them and links one to an unlinked API entity; skipped/invalid folders surfaced, not silently dropped.
- **C — YML export:** `GET /collections/:id/opencollection.yml` returns valid OpenCollection `1.0.0` YAML matching the collection (items/envs/docs); secrets redacted per D-D; output re-imports cleanly.
- **D — OC-docs iframe:** API Docs tab renders the iframe from the exported YML; theme matches Backstage and updates on toggle; `collectionData` injection is escape-safe (test a collection containing `"`/`</script>`); assets load per the D-F decision; sandbox holds.
- **E — caching:** disconnect immediately removes the entry (no ghost by id); a changed repo reflects within one scheduled tick for service-visible collections; user-token privates refresh on next authenticated access; the cache stops growing under many connects (bound holds).
- **F — Bruno column:** the `/api-docs` list shows a **Bruno** column; a linked entity renders the badge (→ its API Docs tab) and an unlinked one renders "—"; linking an entity then refreshing the catalog flips its cell to linked; the optional filter narrows to Bruno-linked APIs.
- **Scope guard:** no Bruno logic in `packages/app`/`packages/backend` beyond the auth harness; no north-star features; native-viewer fate matches the D-E decision.
