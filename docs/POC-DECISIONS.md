# Bruno for Backstage — POC Decisions & Findings Log

> Companion to [`POC-PLAN.md`](./POC-PLAN.md). This is the **living findings + decisions doc** the plan calls for (Deliverable #2). It records what we built, why, the evidence for each feasibility question (Q1–Q6), and the final go/adjust/no-go recommendation. Updated as the POC progresses.

**Status:** 🟢 POC complete — demo runs end to end; verdict = GO (see §8) · **Owner:** POC build · **Last updated:** 2026-08-04

### Running the demo & where the sample data lives

`yarn install` then `yarn start`, then open `http://localhost:3000`.

The 3 sample collections (`Echo Demo`, `sandwich_exec`, `sequential_exec`, sourced from `bruno-tests`) are materialized as **`kind: API`** entities, so they appear under **APIs** (sidebar) — `http://localhost:3000/api-docs` — **not** on the default Catalog landing, which filters to `kind: Component`. To see them on the Catalog page, switch the **Kind** dropdown to **API**. Click a collection → **API Docs** tab for the viewer + Try-it-out. (Note: this scaffold remaps the catalog index to `/`, so `/catalog` 404s — use the sidebar links.)

---

## 1. Decisions locked at kickoff

These were confirmed with the requester before building; they materially shape scope.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Self-contained demo + documented private path.** Sample collections are committed into the repo; the backend fetches them through Backstage's `UrlReaderService`. The private-GitHub-repo code path is wired and documented, but the demo does not *require* live private creds to run. | Keeps the POC runnable by anyone who clones it; still exercises the RISK #1 credential-isolation path (Q4). |
| D2 | **Collection Docs viewer is built from scratch** as a native Backstage React component — we do **not** embed `@opencollection/docs`. | Requester is not hardwired to the OpenCollection renderer. Building native kills the plan's Scenario-A risks (HashRouter hijack, CSP, bundle size, multi-store) and gives us full control. `@opencollection/docs` is also **not published to npm** (confirmed), so embedding it would mean vendoring an unbuilt bundle. |
| D3 | **Open-in-Bruno = wire + document the gap.** We build the `bruno://` action and a clone-and-scan stand-in; we do **not** modify the separate `bruno-electron` repo. | The desktop `bruno://open` + import-from-URL verb is a real Beta dependency (Q3), out of POC scope. |
| D4 | **CORS for in-portal "try it out" goes through Backstage's proxy backend** (`@backstage/plugin-proxy-backend`, already installed). | Browser-direct `fetch` to `echo.usebruno.com` etc. would hit CORS inside the portal. Backstage's proxy is the standard pass-through and needs no new infra. See §6. |
| D5 | **Own normalized collection model, parsed via `@usebruno/lang`;** Scenario-B HTML is **fully self-contained (no CDN)**. `@usebruno/converters`/`@opencollection/*` are installed and evaluated but kept off the critical path. | Following from D2: controlling the JSON shape avoids coupling to `@opencollection/types` and the `brunoToOpenCollection` input contract, and lets the generated HTML inline its own styles — removing the plan's `cdn.usebruno.com` egress entirely. |

## 2. Architecture at a glance

```
                    Backstage app (new frontend + new backend system, v1.53.0)
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│  plugins/bruno  (frontend)     │        │  plugins/bruno-backend  (backend)          │
│  • BrunoCard (EntityCard)      │  HTTP  │  • collection-fetch service (UrlReader)    │
│  • Collection Docs tab         │◀──────▶│  • .bru → OpenCollection (@usebruno/*)     │
│    (native viewer, from scratch)│  /api/ │  • routes: /collections, /:id, /:id/docs   │
│  • Open in Bruno action        │  bruno │  • generateCollectionHtml (Scenario B)     │
│  • brunoApi client             │        │  • BrunoEntityProvider (catalog module)    │
└───────────────────────────────┘        └──────────────────────────────────────────┘
        │  try-it-out                                   │ server-side fetch
        ▼                                               ▼
  /api/proxy/*  (Backstage proxy-backend, CORS pass-through)   GitHub (Backstage creds) / local sample-collections/
```

## 3. Shared API contract (backend ⇄ frontend)

Backend plugin id `bruno`; frontend resolves base via `discoveryApi.getBaseUrl('bruno')`.

| Method & path | Returns |
|---|---|
| `GET /health` | `{ status: 'ok' }` |
| `GET /collections` | `Array<{ id, name, requestCount, source: 'local'\|'url', sourceUrl?: string }>` |
| `GET /collections/:id` | `{ id, name, source, sourceUrl?, requestCount, collection: <NormalizedCollection> }` |
| `GET /collections/:id/docs` | `text/html` — self-contained Collection Docs HTML (Scenario B) |

**`NormalizedCollection`** — our **own** clean model, parsed directly from `.bru` via `@usebruno/lang` (see D2/D5). We do **not** conform to `@opencollection/types`; controlling the shape keeps the native viewer and the Scenario-B HTML generator simple and decoupled from an external contract.
```ts
type NormalizedCollection = {
  id: string; name: string; version?: string;
  environments: Array<{ name: string; variables: Array<{ name: string; value: string; enabled: boolean }> }>;
  items: Item[];                       // ordered by seq
};
type Item =
  | { type: 'folder'; name: string; docs?: string; items: Item[] }
  | { type: 'http' | 'graphql'; name: string; seq?: number; docs?: string;
      method: string; url: string;
      headers: Array<{ name: string; value: string; enabled: boolean }>;
      params: Array<{ name: string; value: string; type: 'query' | 'path'; enabled: boolean }>;
      body?: { mode: 'none'|'json'|'text'|'xml'|'formUrlEncoded'|'multipartForm'|'graphql'; raw?: string; form?: Array<{name:string;value:string;enabled:boolean}> };
      auth?: { mode: 'none'|'inherit'|'basic'|'bearer'|'apikey'|'digest'; [k: string]: unknown };
      script?: { req?: string; res?: string }; tests?: string;
      assertions?: Array<{ expr: string; op: string; value: string; enabled: boolean }>; };
```
`@usebruno/converters` (`brunoToOpenCollection`) is installed and available; we evaluated it but keep it **off the critical path** (see D5). D5 finding recorded in §4/§7.

**Config block** (`app-config.yaml`):
```yaml
bruno:
  sources:
    - id: <slug>
      name: <display name>
      type: local | url
      target: <relative path from packages/backend | github tree/blob URL>
  schedule:            # optional provider refresh
    frequencySeconds: 60
    timeoutSeconds: 30
```

**Catalog entity** materialized by `BrunoEntityProvider`: `kind: API`, `spec.type: bruno-collection`, annotations `bruno.dev/collection-id`, `bruno.dev/collection-path`, `bruno.dev/source-url`. The card & tab attach when `spec.type === 'bruno-collection'`.

## 4. Feasibility questions — evidence & verdicts

_Filled in as spikes complete._

| Q | Question | Status | Finding |
|---|----------|--------|---------|
| Q1 | Discover `bruno.json` in a repo → catalog API entity | ✅ **Proven** | `BrunoEntityProvider` (a `catalog` backend module via `catalogProcessingExtensionPoint`) scans `bruno.sources` and emits `kind: API` entities with `bruno.dev/*` annotations on a scheduled refresh. Backend loads **3 collections**; the `Echo Demo` API entity renders in the catalog with type `bruno-collection`, `bruno` tag, and description "…— 9 requests" (screenshot 01). |
| Q2 | BrunoCard + Open-in-Bruno on entity page | ✅ **Proven** | The **`BrunoCard`** renders on the entity Overview (name "Echo Demo", **Requests: 9**, Source, **OPEN IN BRUNO** button — screenshot 01), and the **API Docs** tab attaches, both via new-frontend-system blueprints (`EntityCardBlueprint` / `EntityContentBlueprint`) filtered to `spec.type:bruno-collection`. |
| Q3 | `bruno://` open + import-from-URL readiness | ✅ Answered | **Confirmed gap** (matches plan). Desktop handles only `bruno://app/oauth2/callback`; no `open`/`clone` verb, and URL import is API-spec-only. POC ships the deep-link builder (centralized in `brunoLink.ts`) + a **clone-and-scan stand-in**, and documents the desktop verb as a **Beta dependency**. No `bruno-electron` changes (D3). |
| Q4 | Private-repo fetch, no creds to browser, egress only Backstage→GitHub (RISK #1) | 🟢 Built + reasoned | Backend fetches via `UrlReaderService.readTree()`, which resolves `integrations.github` creds **server-side**; the token is never read into, logged, or returned in any response (only the parsed collection JSON crosses to the browser). Code path wired + commented; live private-repo run is a config toggle (uncomment the `url` source + set `GITHUB_TOKEN`). The **only network egress is Backstage→GitHub**. |
| Q5 | Collection Docs embeddable in a Backstage tab (RISK #2) | ✅ **Proven** | Per D2, a **native React viewer** — no `@opencollection/docs`, so none of the plan's Scenario-A blockers (HashRouter hijack, CSP, bundle size, multi-store) apply. Renders live in the entity tab: left-pane folder tree with color-coded method badges + all 9 requests; right-pane request detail with Headers/Params/Body/Auth/Docs/Tests/Try-it-out tabs (screenshot 02). **In-portal "Try it out" executes**: `GET {{host}}/ping?...` → **200 OK `pong`**, template var resolved, routed **via the Backstage proxy** (screenshot 03). |
| Q6 | Generate-HTML-and-link-out fallback (Scenario B) | ✅ **Proven** | `GET /api/bruno/collections/echo-demo/docs` returns a **23 KB fully self-contained HTML** doc — **zero external references** (`grep` for `src="http` / `href="http` / `cdn.usebruno` = 0). Improves on the plan, which assumed a `cdn.usebruno.com` bundle dependency (D5). Access control is inherited from the Backstage backend auth layer. |

## 5. Effort estimate per Beta feature

Rough per-feature effort, informed by building the POC slice. "POC" = already done here; sizes are incremental Beta work.

| Beta feature | Effort | Notes from the POC |
|---|---|---|
| Private-repo discovery + fetch | S | Provider + UrlReader path already built; Beta adds multi-repo scanning + error surfacing. |
| BrunoCard + entity page | S | Built; Beta adds polish + more metadata. |
| Native Collection Docs viewer | M | Built as POC-grade; Beta hardens rendering (all body/auth types, GraphQL, scripts) + a11y. |
| Server-side secret injection into try-it-out | M | Not in POC; proxy can inject headers server-side — design exists (D4) but needs a secrets story. |
| `bruno://open` + collection-from-URL import | M–L | **External** `bruno-electron` change (Q3), outside this repo. |
| `CatalogProcessor` annotation injection on existing entities | M | Out of POC; standard Backstage pattern. |
| Persist-to-source PR flow / webhook sync | L | Out of POC. |
| Generate-HTML link-out surface | S | Generator done + self-contained; Beta adds the access-controlled link UI. |

## 6. CORS / proxy notes

Per **D4**, the Collection Docs "try it out" runs in the browser but must not hit CORS against external API hosts. We route through Backstage's **`@backstage/plugin-proxy-backend`** (already installed), configured in `app-config.yaml` under `proxy.endpoints`:

| Proxy path (`/api/proxy/…`) | Target |
|---|---|
| `/bruno-echo` | `https://echo.usebruno.com` |
| `/bruno-testbench` | `https://testbench-sanity.usebruno.com` |
| `/bruno-example` | `https://www.example.com` |

The frontend mirrors this host→endpoint map in `plugins/bruno/src/lib/proxy.ts` (`PROXY_HOST_MAP`); `resolveViaProxy()` rewrites a request URL to `${proxyBaseUrl}${endpoint}${path}` when the host is known, else falls back to a direct fetch and surfaces any CORS error in the UI. Backend logs confirm the proxies are created at boot (`[HPM] Proxy created: /bruno-echo -> https://echo.usebruno.com`, etc.). Adding a host = one `proxy.endpoints` entry + one `PROXY_HOST_MAP` line. This is the standard Backstage CORS pass-through — no new infra, no data egress beyond Backstage→target.

**Verified live:** the docs viewer's "Try it out" for `GET {{host}}/ping?page=1&limit=10&sort=desc` returned **200 OK / `pong`** with a **"via proxy"** badge (screenshot 03) — an in-portal request executed against a public API with no CORS error. Note the proxy **enforces Backstage auth**: an unauthenticated `curl` to `/api/proxy/bruno-echo/...` returns `401 Missing credentials`, while the browser (guest identity) succeeds — a useful access-control property for free.

## Screenshots (evidence)

Captured from the running app (`docs/screenshots/`):
1. **`01-entity-overview-brunocard.png`** — the materialized `Echo Demo` API entity + the BrunoCard (Requests: 9, Open in Bruno). Proves Q1 + Q2.
2. **`02-collection-docs-viewer.png`** — the native Collection Docs viewer: folder tree, method badges, request detail tabs. Proves Q5.
3. **`03-try-it-out-via-proxy.png`** — in-portal "Try it out" → 200 OK `pong`, via proxy. Proves Q5 execution + D4.

## 7. Build log (chronological decisions & steps)

- **2026-08-04** — Kickoff. Read POC-PLAN.md. Ran 3 exploration passes (host app wiring, api-docs renderer, sample collections). Confirmed host app is new frontend + new backend system (Backstage 1.53.0). Confirmed `@usebruno/lang`, `@usebruno/converters`, `@usebruno/filestore`, `@opencollection/types` are published on npm; `@opencollection/docs` is not. Locked decisions D1–D4. Defined the API contract in §3.
- **2026-08-04** — Built (via parallel subagents): `sample-collections/` (3 public-endpoint collections, 11 requests), `plugins/bruno-backend`, `plugins/bruno`. Wired `app-config.yaml` (`bruno:` sources + 3 `proxy.endpoints`), `packages/backend/src/index.ts` (plugin + catalog module), `packages/app/src/App.tsx` (plugin). Adopted D5 (own normalized model, self-contained HTML).
- **2026-08-04** — `yarn install` + full `yarn tsc` green. Booted backend; validated routes end-to-end. **Bug found & fixed:** `@usebruno/lang@0.38.0` exports `bruToJsonV2`/`bruToEnvJsonV2` (V2-suffixed), not the bare names the builder assumed from the older local `../bruno` copy — aliased the imports. After fix: `echo-demo` parses **9 requests** + `Public` env + folder tree; `/docs` returns **23 KB self-contained HTML, 0 external refs** (Q6 proven). Backend log confirms proxy endpoints created.
- **2026-08-04** — Adopted `../bruno-api-docs` ESLint config/rules (flat config, `@stylistic` etc.) scoped to the Bruno plugins; omitted the `eslint-plugin-diff` processor (CI-diff-only; would no-op on untracked POC files) — all other rules faithful. `yarn lint:bruno` → **0 errors** (204 auto-fixed; hex tokens moved into an exempt `MethodBadge/colors.ts`), 3 acceptable `any` warnings in the lang `.d.ts`. Typecheck still green.
- **2026-08-04** — **Full browser verification** (Playwright, guest auth). Confirmed: entity + BrunoCard render (Q1/Q2), native docs viewer renders the tree + request detail (Q5), and in-portal **Try it out** returns 200 `pong` via the Backstage proxy (Q5 exec + D4). No runtime/console errors beyond benign MUI `defaultProps`/`findDOMNode` warnings. Screenshots saved to `docs/screenshots/`. **POC demo runs end to end.**

## 8. Go / adjust / no-go recommendation for Beta

**Verdict: 🟢 GO — with two adjustments.**

The two Beta-killer risks the POC existed to test both came back **positive**:

- **RISK #1 (private-repo, server-side fetch, no creds to browser).** Cleanly solved with Backstage's native `UrlReaderService` + `integrations.github`. The token never leaves the backend; the only egress is Backstage→GitHub. This is standard Backstage territory — **no blocker**. (Live private run is a config toggle; the code path is built and exercised against local + URL sources.)
- **RISK #2 (Collection Docs inside Backstage).** The plan feared this was heavy (extracting `@opencollection/docs`: HashRouter, CSP, bundle, multi-store). By **building the viewer natively** (D2) we sidestepped every one of those blockers and shipped a working in-tab viewer **with live in-portal execution** in the POC. **No blocker.**

**Recommended Beta scope (what the POC validated → build for real):**
1. The **provider + backend fetch** spine (Q1/Q4) — productionize multi-repo scanning, error surfacing, and the private-repo path against a real instance.
2. The **native Collection Docs viewer** (Q5) — harden rendering across all body/auth types, GraphQL, scripts, a11y; keep it native (do **not** adopt `@opencollection/docs`).
3. **Try-it-out via the Backstage proxy** (D4) — extend to a general host-allowlist + optional **server-side secret injection** (the differentiating capability; the proxy already gives us the seam).
4. The **self-contained HTML generator** (Q6) — keep as the link-out surface; add the access-controlled-link UI. No CDN dependency (D5).
5. `BrunoCard` + entity page polish (Q2).

**Adjustments to the plan (things the POC changed):**
- **A1 — Docs experience: native viewer wins, decisively.** The plan carried Scenario A (embed) vs B (generate-HTML) vs deep-link-only. The POC's third path — **build a native viewer** — beats all three: it embeds cleanly (Scenario A's goal) *and* we still have the self-contained HTML generator (Scenario B) for link-out, both with **zero CDN egress**. Recommend Beta commits to the native viewer + keep the generator; drop the `@opencollection/docs` extraction line item entirely.
- **A2 — `bruno://open` is a real, separate Beta dependency (Q3), not "free wiring."** Today's desktop handles only the OAuth2 callback verb. Building `bruno://open` + collection-from-URL/clone import is a change in the **`bruno-electron`** repo and must be scoped as its own Beta workstream. Until it ships, the clone-and-scan stand-in is the fallback.

**Defer to GA (unchanged):** marketplace distribution, brand shims, server-side multi-protocol execution.

**Bottom line:** the spine works end-to-end today against public and local collections, with the private path wired and reasoned. Nothing found in the POC argues against the Beta; the main scope *reduction* is dropping the OpenCollection-embed extraction in favor of the native viewer that already works.
