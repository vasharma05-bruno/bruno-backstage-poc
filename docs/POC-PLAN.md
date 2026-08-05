# Plan: Bruno for Backstage — Feasibility POC

> Supersedes the earlier speculative "full plugin" plan. Reframed around the POC requirement doc for **Epic BRU-2982**, de-risking **Beta BRU-824**. (Jira not accessed; ticket IDs used only as labels.)

## Context

**Purpose.** The Beta (**BRU-824**) is a large plugin build; committing to it before the core spine is proven is the risk this work removes. This **time-boxed POC** exists to de-risk that commitment *before* it's made — proving the spine works, answering the open feasibility questions, and producing a **go / adjust / no-go** recommendation so the Beta is scoped to only what the POC validated. **It is exploration, not a production build.** The output is a *findings + decisions doc* and a *recommended Beta scope*, backed by a thin running demo slice.

**The two riskiest assumptions to kill or confirm first:**
1. Fetching collections from **private GitHub repos with Backstage's own credentials**, server-side, no creds in the browser, no data egress to Bruno-operated services.
2. Whether the **Collection Docs experience can live inside Backstage** — and if not, whether a generate-HTML-and-link-out path works instead.

**Competitive framing (why this scope):** Postman is the only API client with a real Backstage plugin — entity cards + a "Run in Postman" hand-off, cloud-backed, API-key-gated, no in-portal execution. Backstage's native api-docs renders specs view-only. **No one runs requests in-portal against git-hosted private collections.** Matching Postman (card + Open in Bruno) is low-risk table stakes; the private-repo fetch and in-Backstage embedding are the unbuilt, differentiating space — git as source of truth, no API key, no data egress.

## Corrections this plan makes to the earlier draft

The prior plan mis-framed three things; the POC doc + code exploration correct them:

| Earlier draft assumed | POC reality |
|---|---|
| Backend = a cors-anywhere **request-execution proxy** (port `proxy-server`) for in-portal Send | Backend = **collection fetch** with Backstage Git creds. **Server-side multi-protocol execution is OUT of scope.** In-portal request execution (if any) is browser-side, Swagger-"try-it-out" style — a Beta concern, not this POC. |
| A tab gated on a pre-existing entity's annotation | A **`BrunoEntityProvider`** scans a configured repo, finds `bruno.json`, and **materializes its own catalog API entity** (reads `bruno.dev/collection-path`). |
| The docs experience = embed `@opencollection/docs` | Renderer choice is **open**. The POC carries **both** docs-experience scenarios (native-component embed **vs** generate-HTML/iframe) and returns a verdict; it does not presuppose OpenCollection docs. |

**Two auth stories to keep straight throughout:**
- **Open in Bruno desktop** → the *desktop* needs its *own* Git access to the private repo.
- **Render inside / from Backstage** → the *backend* fetches with *Backstage's* creds; the browser/desktop never sees them.

## Questions to answer, with evidence gathered so far

Each question below already has partial evidence from the codebase; the spike confirms end-to-end.

**Q1 — Discovery.** Can a plugin scan a configured GitHub repo for `bruno.json` and surface it as a catalog **API entity** using Backstage's existing Git integration creds?
→ *Standard Backstage `EntityProvider` territory; no blocker anticipated. Spike proves the `bruno.json`→entity mapping and the `bruno.dev/collection-path` annotation read.*

**Q2 — Basic surface.** Can an entity page show a **BrunoCard** (name, request count, source link) + an **"Open in Bruno"** action?
→ *Proven Backstage card pattern. Low risk. The risk is entirely in the Open-in-Bruno verb (Q3), not the card.*

**Q3 — Open-in-Bruno path.** Does `bruno://` open + Bruno's fetch/import-from-URL (PR #3000 / issue #2970) work end-to-end, and what's missing?
→ **⚠️ Bigger gap than the doc assumes.** Evidence from `packages/bruno-electron`:
  - `bruno://` protocol handler **exists but only handles OAuth2 callbacks** (`bruno://app/oauth2/callback`) — see `src/utils/deeplink.js`, registered in `src/index.js` (`setAsDefaultProtocolClient('bruno')`, `open-url`, `second-instance`). **No `open`/`clone` verb exists.**
  - URL import exists **only for API specs** (OpenAPI/Postman/Insomnia) via `renderer:fetch-api-spec` (`src/ipc/apiSpec.js`) + `fetchAndValidateApiSpecFromUrl` (`bruno-app/.../importers/common.js`). **No "open a Bruno collection from a URL."** Closest existing path: **git-clone-and-scan** (`renderer:clone-git-repository` in `src/ipc/git.js` + `renderer:scan-for-bruno-files`).
  - **Gap list (must-build in Bruno desktop):** `bruno://open?...` / `bruno://clone?repo=...` verb parsing; a collection-from-URL / clone-collection import action. This is **not** free wiring — it's a desktop change and an external dependency for the demo slice.

**Q4 — Private repo (RISK #1).** Can the backend fetch a collection from a **private** GitHub repo server-side with Backstage creds, no creds to the browser, no egress to Bruno services?
→ *Backstage exposes `ScmIntegrations` / `UrlReaderService` in backend plugins, which already resolve GitHub App/token creds from `app-config`. The spike wires `bruno.dev/collection-path` → `UrlReader.readUrl()` and returns the collection to the frontend. Confirm: token never crosses to browser; the only network egress is Backstage→GitHub.*

**Q5 — In-Backstage docs (RISK #2).** Can a Collection Docs viewer/playground be embedded in a Backstage tab and load a fetched (private) collection instantly? How much extraction is needed?
→ *This is the embeddability spike. Carries **both scenarios** (see next section). Facts on the candidate `@opencollection/docs` renderer: default-exports `<OpenCollection collection={obj|yaml|json|url|File} …>`, owns its own Redux store per instance (safe to mount), but wraps itself in `HashRouter` with no `basename` (will contend for Backstage's URL) and executes requests **browser-direct via native `fetch`** with no proxy hook. Extraction cost is real; the spike quantifies it.*

**Q6 — Fallback path.** If embedding is too heavy, can we **generate the Collection Docs HTML** from the fetched private collection and open it via an access-controlled link?
→ **✅ Strongly feasible.** The generation pipeline is portable to Node: `brunoToOpenCollection` (`@usebruno/converters`) is pure/zero-DOM; serialization (`js-yaml`, `jsesc`) and the HTML template are plain string work. Only the UI wrapper (Redux/`file-saver`/toast) in `bruno-app/.../GenerateDocumentation/index.js` is browser-bound. The generated HTML **embeds the collection inline** (self-contained) but loads the standalone bundle from `cdn.usebruno.com/api-docs/api-docs.{js,css}` — mirror/self-host to avoid egress. **Generation runs in the Backstage backend; the link is access-controlled at the Backstage layer.** Est. 1–2 days to extract a `generateCollectionHtml()`.

## The two docs-experience scenarios (the embeddability verdict)

The POC keeps **both** first-class and picks between them with evidence. The renderer used in Scenario A is itself an open question — extracted `@opencollection/docs`, a lighter purpose-built viewer, or another approach.

| | **Scenario A — Native component** (GraphiQL / Swagger "try-it-out" model) | **Scenario B — Generate-HTML / iframe** (Grafana / Roadie model) |
|---|---|---|
| **What it is** | A Collection Docs viewer compiled *into* Backstage as a real component in a tab | Backend generates a self-contained docs HTML; Backstage links to / iframes it |
| **Auth model** | Uses Backstage auth; backend fetches the private collection and hands the object to the component | Backend fetches + generates behind an access-controlled URL |
| **Server-side secret injection** | Possible (this is the differentiating target) | **Not** possible via the iframe; secrets only at generation time |
| **Effort / risk** | Higher — needs the viewer **extracted** into an embeddable, arbitrary-Backstage-friendly component; must handle `HashRouter`, bundling, CSP, its own store | Lower — pipeline already portable (Q6); ~1–2 days for generation, plus link/iframe wiring |
| **Maps to** | The Beta "north-star" embed; RISK #2 | The fallback (Q6) |
| **Known blockers to resolve in the spike** | Router hijacks URL (needs upstream `basename`/memory-router option); browser-direct `fetch` + CSP inside a corporate portal; bundle size; multi-instance store | CDN dependency (mirror/self-host `cdn.usebruno.com`); no in-portal secret injection; access-control the link |

**Verdict framework — the spike outputs one of:**
1. **Embed (Scenario A)** — extraction is bounded; pursue native component in Beta.
2. **Generate-HTML-link-out (Scenario B)** — embedding too heavy; ship the backend generator + controlled link.
3. **Deep-link-only** — neither docs surface is worth it for Beta; lean on Open-in-Bruno.

## Scope

**In scope — thin vertical slice + spikes:**
- Scaffold **frontend + backend** plugin packages (+ a throwaway dev Backstage app via `@backstage/create-app`).
- **`BrunoEntityProvider`**: discover a collection in a test GitHub repo (**public first, then private**), materialize an API entity, read `bruno.dev/collection-path`.
- **BrunoCard** on the entity Overview tab + **"Open in Bruno"** via `bruno://open`.
- **Spike:** private-repo fetch through the backend with Backstage creds (RISK #1).
- **Spike:** embed a Collection Docs viewer in a tab loading a fetched collection; assess cross-origin / bundling / CSP (RISK #2, Scenario A).
- **Spike:** generate-HTML-and-link-out fallback reusing the docs pipeline (Scenario B).
- Capture **effort / feasibility notes per Beta PRD feature** as we touch them.

**Out of scope — defer to Beta / BRU-824:**
Click-to-link UI, plugin database, `CatalogProcessor` annotation injection, persist-to-source PR flow, webhook sync, full 4-subpage hub, permission gating, test-runs logging, **server-side multi-protocol execution**, broken-link detection, marketplace distribution, brand shims.

## Roadmap: POC → Beta → GA

The temporal view of the scope above. **Phase 1/2 contents are provisional** — the POC's go / adjust / no-go verdict re-scopes them; nothing past the POC is a commitment ahead of the findings.

| Phase | Goal | Key scope | Exit criteria |
|---|---|---|---|
| **Phase 0 — POC** *(Epic BRU-2982, this doc)* | De-risk before committing to the Beta build. | Scaffold FE+BE plugins + throwaway dev app; `BrunoEntityProvider` discovery (public **then** private); BrunoCard + Open-in-Bruno; **RISK #1** private-fetch spike; **RISK #2** embeddability spike (Scenario A) + **Q6** generate-HTML fallback (Scenario B); per-feature effort notes. | Q1–Q6 answered with evidence; demo slice runs end-to-end for a **public and a private** collection; a written **go / adjust / no-go** recommendation for Beta scope. |
| **Phase 1 — Beta** *(BRU-824)* | Productionize the validated spine in a real Backstage instance. | The docs-experience path the POC greenlit (embed **/** generate-HTML-link-out **/** deep-link-only); the Bruno-desktop `bruno://open` + import-from-URL/clone verb (**Q3** dependency); click-to-link UI; plugin database; `CatalogProcessor` annotation injection; persist-to-source PR flow; webhook sync; full 4-subpage hub; permission gating; test-runs logging; broken-link detection. | Plugin usable against **private** repos in a real instance; docs experience shipped per the verdict; core PRD features landed. |
| **Phase 2 — GA / Post-Beta** | Distribution + heavier features. | Marketplace/registry distribution; brand shims; **server-side multi-protocol execution**; scale + hardening. | Published to the Backstage marketplace; adopted by external orgs. |

*Deferred-item mapping: everything in the "Out of scope" list above lands in exactly one later phase — marketplace distribution, brand shims, and server-side multi-protocol execution → **GA**; all others → **Beta**.*

## Workstreams (sequenced by risk)

**Sequencing rule:** do the two Beta-killers *first*; the proven-pattern slice follows.

- **WS0 — Scaffold + test env.** FE + BE plugin packages + a throwaway dev Backstage app (`@backstage/create-app`). **The POC stands up its own test environment:** a **private** test GitHub repo containing a `bruno.json`, and a local Backstage instance configured with a GitHub App/token integration in `app-config.yaml`. *(Enabler + prerequisite for WS1.)*
- **WS1 — Private-repo fetch spike (RISK #1, FIRST).** Backend uses `ScmIntegrations`/`UrlReader` to fetch `bruno.json` from a private repo; prove no creds reach the browser, egress is only Backstage→GitHub. *Files: `plugins/bruno-backend/src/service/router.ts`, collection-fetch service.*
- **WS2 — Embeddability spike (RISK #2, FIRST).** Stand up **both** Scenario A (native component in a tab) and Scenario B (backend `generateCollectionHtml()` + controlled link), load the WS1-fetched private collection, and record the verdict. *Reuse: `@usebruno/converters` `brunoToOpenCollection`; the pipeline in `bruno-app/.../GenerateDocumentation/index.js` as the extraction source; `bruno-api-docs` standalone bundle.*
- **WS3 — Discovery (low-risk, follows).** `BrunoEntityProvider` → API entity, public then private repo. *Files: `plugins/bruno-backend/src/provider/BrunoEntityProvider.ts`, annotation constant `bruno.dev/collection-path`.*
- **WS4 — Card + Open in Bruno (low-risk, follows).** `BrunoCard` (name, request count, source link) + an "Open in Bruno" action. **Decision: the POC does NOT build the Bruno-desktop changes** — it wires the `bruno://open` action, validates the path as far as today's desktop allows, and **documents the gap** (verb parsing + collection-from-URL import) as a Beta dependency. For the demo, "Open in Bruno" uses the existing **git-clone-and-scan** path (or a manual open) as a stand-in so the slice runs end-to-end. *Files: `plugins/bruno/src/components/BrunoCard/`; gap documented against `bruno-electron/src/utils/deeplink.js` + a future collection-import-from-URL/clone action.*

**Repo setup (recommendation):** the Backstage plugin lives in a **new standalone repo** (`usebruno/bruno-backstage`, mirroring `usebruno/bruno-vscode`) with FE + BE packages + dev app, isolating Backstage's heavy dep tree. Any Bruno-desktop changes (Q3 verb) land in the `bruno` repo. Docs-generation extraction (Q6) lands as a small reusable module (candidate: a new `@usebruno/docs-generator`, or inlined in the backend plugin) drawing on `@usebruno/converters`.

## Integrating the plugin into a Backstage instance

*How the plugin plugs into a host Backstage app — the wiring the POC validates and the Beta ships. Planning reference; nothing here is built yet. Package/symbol names are the intended idiom, not final.*

**Package layout (two plugins + config).** A Backstage integration is the standard dual-package pattern, added to a host app's `packages/app` (frontend) and `packages/backend` (backend):
- **Frontend plugin** `@usebruno/backstage-plugin` (`plugins/bruno`) — `BrunoCard`, the "Open in Bruno" action, and (if Scenario A wins) a Collection Docs tab.
- **Backend plugin** `@usebruno/backstage-plugin-backend` (`plugins/bruno-backend`) — the collection-fetch service and the `BrunoEntityProvider`.

**Backend wiring (new backend system).** Two units, both added in the host app's `packages/backend/src/index.ts` via `backend.add(import(...))`:
1. **Collection-fetch plugin** — `createBackendPlugin` exposing an HTTP route (`src/service/router.ts`) that resolves GitHub creds from `app-config` through `coreServices` (`UrlReaderService` / `ScmIntegrations`) and fetches `bruno.json` **server-side** (RISK #1 / Q4). The token never reaches the browser.
2. **Catalog module** — the `BrunoEntityProvider` is **not** added directly; it registers through a catalog backend module: `createBackendModule` depending on `catalogProcessingExtensionPoint`, calling `catalog.addEntityProvider(new BrunoEntityProvider(...))` at init. *Constraint: providers can only be added at startup — the set is fixed once the catalog starts.*

**Frontend wiring.** Depends on which frontend system the host app runs:
- **New frontend system** (target for Beta): the plugin is `createFrontendPlugin(...)` and contributes extensions — `EntityCardBlueprint` (from `@backstage/plugin-catalog-react/alpha`) for `BrunoCard`, and `EntityContentBlueprint` for the Collection Docs tab. Installed by adding the plugin to `packages/app/src/App.tsx`; extensions auto-attach to the entity page (no manual `EntityPage` edits). Avoid `convertLegacyEntityCardExtension` — use the blueprint directly.
- **Legacy frontend system** (likely what a throwaway `@backstage/create-app` scaffolds today): mount `<BrunoCard>` and an `<EntityLayout.Route>` docs tab by hand in `packages/app/src/components/catalog/EntityPage.tsx`. The POC can use this direct-mount path; the section above is the Beta path.

**Config (`app-config.yaml`).** Two blocks:
- `integrations.github` (a token or GitHub App) — **the credential source the backend fetch uses**; this is the auth path RISK #1 exercises. Nothing plugin-specific here; it's Backstage's standard SCM integration.
- A `bruno:` block — which repo(s)/locations the provider scans for `bruno.json`, plus a refresh schedule.

**How a Bruno entity comes to exist.** The POC path is **provider-materialized**: `BrunoEntityProvider` scans the configured repo, finds `bruno.json`, and emits an `API`-kind entity carrying the `bruno.dev/collection-path` annotation — no hand-written `catalog-info.yaml`. (The Beta alternative — annotating a pre-existing entity via a `CatalogProcessor` — is explicitly out of scope; see Scope.)

**Two auth stories, restated at the wiring layer (don't conflate):**
- **Render inside / from Backstage** → the *backend plugin* fetches with *Backstage's* `integrations.github` creds; browser and desktop never see them.
- **Open in Bruno desktop** → the *desktop* uses its *own* Git access to the private repo; Backstage only hands off a `bruno://` URL.

**Installing into a real (Beta) instance — summary.** `yarn add` the two packages → add the two `backend.add(...)` lines → install the frontend plugin/extension (or mount the card on legacy) → set `integrations.github` + the `bruno:` config. Marketplace/registry distribution and brand shims are **out of scope** (deferred to Beta).

## Recommended tech stack

Consolidates the choices implied across this doc plus the standard Backstage stack. *Package/symbol names are the intended idiom, not final.*

| Layer | Recommendation | Why / notes |
|---|---|---|
| **Language / build** | TypeScript · Node LTS · Yarn workspaces + Backstage CLI | Backstage's native monorepo + bundling toolchain; matches `@backstage/create-app` output. |
| **Backstage backend** | New backend system (`@backstage/backend-defaults`, `@backstage/backend-plugin-api`) — `createBackendPlugin` / `createBackendModule`; catalog via `catalogProcessingExtensionPoint` + `EntityProvider`; `UrlReaderService` / `ScmIntegrations` | The provider registers through a catalog module; the fetch service resolves GitHub creds server-side (**RISK #1 / Q4**). |
| **Backstage frontend** | New frontend system (`@backstage/frontend-plugin-api`, `createFrontendPlugin`) — `EntityCardBlueprint` / `EntityContentBlueprint` (`@backstage/plugin-catalog-react/alpha`); React 18 + MUI via `@backstage/core-components` | Extensions auto-attach to the entity page. Legacy `EntityPage.tsx` mount is the POC fallback if the dev app is on the old system. |
| **Bruno reuse** | `@usebruno/converters` (`brunoToOpenCollection`, zero-DOM); `js-yaml` + `jsesc`; the `bruno-api-docs` standalone bundle | Docs-generation pipeline (**Q6**). **Self-host/mirror the bundle** to remove `cdn.usebruno.com` egress. |
| **Docs renderer** | Candidate `@opencollection/docs` (Scenario A — needs extraction/patching) **or** a new `@usebruno/docs-generator` (Scenario B) | Chosen by the **embeddability verdict**; carry both until the POC decides. |
| **Desktop dependency** | Bruno Electron `bruno://` protocol + import-from-URL/clone (PR #3000 / issue #2970) | **Beta dependency, not built in the POC** — see Q3 gap. |
| **Testing** | Jest + `@backstage/test-utils`; supertest for the backend router; Playwright for the demo-slice e2e | Playwright is preinstalled in the dev environment. |
| **Config / secrets** | `app-config.yaml` `integrations.github` (token or GitHub App) | The only credential source; **no secrets reach the browser**. |
| **Distribution (GA)** | npm packages under `@usebruno/*`; Backstage marketplace/registry | GA phase only. |

## Deliverables

1. **Running demo slice** — discover a GitHub collection (incl. a **private** repo), BrunoCard on an entity, Open in Bruno desktop.
2. **Findings + decisions doc** answering Q1–Q6 with evidence, including: the private-repo fetch approach; the **embeddability verdict** (embed vs generate-HTML-link-out vs deep-link-only); `bruno://` verb readiness + Bruno-desktop dependencies; a rough **effort estimate per Beta feature**.
3. **Recommended Beta scope** — what to include in BRU-824, what to defer, based on what the POC proved.

## Success criteria (POC done when)

- The demo slice runs **end to end for both a public and a private** GitHub collection.
- **Each of Q1–Q6 has a documented answer with evidence.**
- A **go / adjust / no-go** recommendation for Beta scope is written and shared.

## Verification (how we prove each spike)

- **WS1:** fetch a known private repo's `bruno.json` from the backend; assert the browser network log never carries the GitHub token, and the only outbound call is Backstage→GitHub. Negative test: unauthorized user / missing integration → clean failure.
- **WS2 Scenario A:** open the entity tab, confirm the fetched private collection renders; record CSP/console errors, bundle size, and router/URL interference. **Scenario B:** hit the generated link, confirm self-contained render behind Backstage access control (mirror the CDN bundle to remove egress); confirm an unauthenticated user is blocked.
- **WS3:** point the provider at the public repo, then the private repo; confirm the API entity appears with correct name/request-count and the `bruno.dev/collection-path` annotation.
- **WS4:** click Open in Bruno; confirm the desktop opens the collection from its GitHub location (requires the Q3 verb). Document exactly what was missing and what was built.

## Findings appendix (evidence captured during scoping)

**`bruno://` deep-link (Q3):** Exists, OAuth2-only. Registration in `bruno-electron/src/index.js` (`setAsDefaultProtocolClient('bruno')`, `open-url`, `second-instance`); routing in `src/utils/deeplink.js` (`handleAppProtocolUrl` → only `/oauth2/callback`). **Missing:** `open`/`clone` verbs.

**Import-from-URL (Q3):** API-spec-only (`renderer:fetch-api-spec`, `fetchAndValidateApiSpecFromUrl`). Git clone+scan exists (`renderer:clone-git-repository`, `renderer:scan-for-bruno-files`). **Missing:** open/import a Bruno collection directly from a URL.

**Docs-generation portability (Q6):** Pipeline in `bruno-app/.../GenerateDocumentation/index.js`; core is portable — `brunoToOpenCollection` (`bruno-converters`, zero-DOM), `js-yaml`, `jsesc`, string template. Browser-bound only at the Redux/`file-saver`/toast edges. Output self-contained but references `cdn.usebruno.com/api-docs/*`. **Est. 1–2 days to extract.**

**OpenCollection renderer embeddability (Q5, candidate renderer):** `<OpenCollection>` default export; own Redux store per instance; **`HashRouter` (no `basename`)**; requests **browser-direct `fetch`, no proxy hook**. Extraction/patching needed if Scenario A is chosen.

## Open questions for you (scope forks the findings surfaced)

- **Does this POC *build* the Bruno-desktop `bruno://open` + collection-from-URL changes (Q3), or only validate the path and document the gap?** The requirement doc treats Open-in-Bruno as "low-risk proven-pattern work," but the code shows it needs real desktop changes — this materially changes POC size.
- **Test environment:** is there an existing private test GitHub repo + a Backstage instance with Git integration creds, or does the POC stand these up?
- **Deliverable home:** is this plan file the working findings doc, or should the findings + decisions doc be a separate artifact?
