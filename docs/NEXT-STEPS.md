# Bruno for Backstage — Next Phase (Auth · Runtime Connect · Docs Column)

> Companion to [`POC-PLAN.md`](./POC-PLAN.md), [`POC-DECISIONS.md`](./POC-DECISIONS.md), and [`POC-GAPS.md`](./POC-GAPS.md). This doc scopes the **next phase of the POC** — moving collections from static `app-config.yaml` sources to a **runtime, user-driven** connect flow, on top of real authentication. It records the approach, the locked decisions, the exact wiring, and the risks/blockers, *before* anyone builds it.

**Status:** 🟠 Scoped, not yet built — awaiting go-ahead to implement · **Last updated:** 2026-08-05

---

## 1. Overview

The POC spine works end-to-end: `BrunoEntityProvider` scans `bruno.sources[]`, materializes each as a `kind: API` entity, and the frontend renders a `BrunoCard` + a native Collection Docs viewer, with in-portal Try-it-out through the Backstage proxy. Everything is keyed on a single identifier — `source.id` — which is the annotation value, the backend cache key, and the URL path param.

This next phase adds three capabilities:

1. **Authentication (app-side test harness).** GitHub + Google login in the host app, purely so we can exercise the "user *has* GitHub creds" vs "user *doesn't*" branches of the connect flow.
2. **Runtime connect (in the plugin).** On *any* API entity page, a user pastes a GitHub URL into the Bruno card to connect a Bruno collection. Public → connect directly; private → use the user's GitHub credentials from Backstage.
3. **Docs column (in the plugin).** Once connected, a right-column card renders the connected collection's folders + requests.

This is the **one and only POC** — not a separate effort and not a hand-off to a Beta. The work below is POC work; nothing proceeds until explicitly greenlit.

---

## 2. ⚠️ Placement principle (governs everything below)

> **Auth wiring lives in the app; every Bruno feature lives in the plugin.**

| Where | What | Why |
|---|---|---|
| **App** — `packages/app`, `packages/backend`, `app-config.yaml` | GitHub + Google auth providers, the `SignInPage`, provider config | **Test scaffolding only.** A real host Backstage supplies its own auth; we stand up a representative one so we can log in (and log out) of GitHub on demand. **No Bruno feature logic here.** |
| **Plugin** — `plugins/bruno`, `plugins/bruno-backend` | The connect flow, the persistence/store, the new routes, the card UX, the docs column | All feature implementation. The plugin only **consumes** host-provided auth (e.g. `githubAuthApiRef` on the frontend); it never configures auth providers. Keeps the plugin self-contained and distributable. |

**Consequence:** the plugin's dependency on a host is *documented*, not coded — *"the host must configure a GitHub auth provider with `repo` scope for private-repo connect to work."* The app changes in §4 satisfy that requirement locally, for testing.

---

## 3. Decisions locked with the requester

| # | Decision | Rationale |
|---|----------|-----------|
| N1 | **Persistence = backend database** (`coreServices.database`) mapping `entityRef → githubUrl`, **inside `plugins/bruno-backend`**. | The provider owns its entities via full-mutation and can't annotate arbitrary entities; there is no store today. A DB keyed by `entityRef` is the clean home for a runtime connection. Survives restarts, shared across users. |
| N2 | **Private-repo creds = service token first, then user OAuth fallback.** Try `integrations.github` PAT via `UrlReader`; if the repo isn't visible, fall back to the caller's GitHub OAuth token (`repo` scope). | Best coverage. Org-shared repos work with zero user friction; user-owned private repos work via the user's own token. Directly answers the "use the user's GitHub credentials from Backstage" ask. |
| N3 | **Sign-in policy = any authenticated GitHub/Google user** (`dangerouslyAllowSignInWithoutUserInCatalog`). | No catalog `User` entity is required — least friction for the test harness. Must tighten for production (see R8). |

---

## 4. Feature 1 — Authentication (APP-SIDE test harness)

**Scope:** `packages/app`, `packages/backend`, `app-config.yaml`. **Nothing in the plugin.** Purpose: simulate a signed-in user with / without GitHub creds so the §5 private-repo branches can be exercised locally.

**"Adapters vs Backstage APIs":** use **Backstage's provided auth-backend provider modules** — they *are* the adapters. No hand-rolled OAuth. The only custom bits are the sign-in resolver choice and requesting GitHub `repo` scope so the plugin can reuse the user's token.

**Backend** — `packages/backend/src/index.ts`:
- `backend.add(import('@backstage/plugin-auth-backend-module-github-provider'))` — **already installed** (`^0.5.5`), just unwired.
- Install + add `@backstage/plugin-auth-backend-module-google-provider` — **not yet installed**.
- Keep the guest provider for local dev.

**Config** — `app-config.yaml`:
```yaml
auth:
  environment: development
  providers:
    guest: {}
    github:
      development:
        clientId: ${AUTH_GITHUB_CLIENT_ID}
        clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}
        additionalScopes: [repo]   # so the plugin can reuse the user token for private repos
        signIn:
          resolvers:
            - resolver: usernameMatchingUserEntityName
              dangerouslyAllowSignInWithoutUserInCatalog: true
    google:
      development:
        clientId: ${AUTH_GOOGLE_CLIENT_ID}
        clientSecret: ${AUTH_GOOGLE_CLIENT_SECRET}
        signIn:
          resolvers:
            - resolver: emailLocalPartMatchingUserEntityName
              dangerouslyAllowSignInWithoutUserInCatalog: true
```
> Note: `integrations.github` (the `${GITHUB_TOKEN}` service PAT) is **separate** from `auth.providers.github` (user login). The former powers server-side `UrlReader` fetches; the latter creates user sessions. Both are needed — for different jobs.

**Frontend** — the new frontend system (`@backstage/frontend-defaults`) needs a **`SignInPage` extension** offering GitHub + Google + (dev) Guest, referencing `githubAuthApiRef` / `googleAuthApiRef`; registered in `packages/app/src/App.tsx` `features`. New file e.g. `packages/app/src/modules/auth/signInPage.tsx`, mirroring the existing `packages/app/src/modules/nav`.

**Blockers (external, requester-supplied):** a **GitHub OAuth App** and a **Google OAuth 2.0 client** — client id/secret + redirect URIs (GitHub callback `http://localhost:7007/api/auth/github/handler/frame`). This is the only hard blocker for Feature 1.

---

## 5. Feature 2 — Runtime connect (IN THE PLUGIN)

The largest change: it breaks the "config `source.id` is the only identity" coupling. All code is in `plugins/bruno` / `plugins/bruno-backend`.

### 5.1 Backend (`plugins/bruno-backend`)

1. **Persistence layer (new).** Add `coreServices.database` to `src/plugin.ts` deps; create `src/store/connectionStore.ts` with a migration for `bruno_connections`:
   `{ entity_ref TEXT PK, github_url TEXT, collection_id TEXT, connected_by TEXT, updated_at }`.
   Use Backstage's Knex-based `DatabaseService` (`getClient()` + migrations) — the standard plugin-DB pattern. SQLite in dev.
2. **Stable id from URL.** `collection_id = sha256(normalizedUrl)` (short). Reused as the cache key so the existing `getCollection(id)` / `/collections/:id/docs` routes keep working unchanged for connected collections.
3. **New routes** (`src/service/router.ts`), authenticated (drop the `unauthenticated` policy for these):
   - `POST /connections` — `{ entityRef, url, userGithubToken? }` → normalize URL, fetch tree (creds logic below), parse to `NormalizedCollection`, upsert store row + cache, return `{ collectionId, name, requestCount }`.
   - `GET /connections/:entityRef` — stored connection or `404` (card rehydrates on load).
   - `DELETE /connections/:entityRef` — disconnect.
   - Existing `GET /collections/:id` and `/:id/docs` now also serve connected collections (same cache).
4. **Creds logic (service-token-then-user-OAuth).** Generalize `readUrlTree` → `readUrlTreeWithCreds(url, { userToken? })`:
   - **Public / service-visible:** `reader.readTree(url)` (service PAT, existing path). Success → done.
   - **Private + service can't see it (403/404):** if `userGithubToken` was supplied, retry via a token-scoped fetch — a per-request Octokit tree/content call, or a `GithubUrlReader` constructed with the user token — then feed the resulting `FileTree` into the **unchanged** `parseCollection`.
   - Add `httpAuth` + `userInfo` deps to identify the caller (stamp `connected_by`).
5. **User token handling.** The frontend obtains it and passes it in the `POST /connections` body over the authenticated Backstage call; the backend uses it only for that one fetch and **never persists it**.

> **🔍 Investigate first (prior art) — how the Bruno app fetches a collection from a GitHub repo link.** Before finalizing `readUrlTreeWithCreds`, study the desktop app's own git-fetch path in **`~/packages/bruno`** (the Bruno source — desktop/electron + `bruno-app`). Known entry points from earlier scoping: the **clone-and-scan** IPC `renderer:clone-git-repository` + `renderer:scan-for-bruno-files`, and the URL-import path `renderer:fetch-api-spec` (API-spec-only today). Questions to answer: (a) does it **git-clone** the repo or hit the **GitHub API/raw** — and how does that compare to Backstage's `UrlReader.readTree()`? (b) how does it **authenticate** to private repos (token source, scope)? (c) how does it **locate `bruno.json`** and walk `.bru` files (monorepo/sub-path handling)? (d) is there a reusable module or normalization we should mirror rather than reinvent? Feed the findings back into the creds logic (item 4) and the `bruno.json` path-verification used by linking ([`NEXT-STEPS-2.md §6`](./NEXT-STEPS-2.md)). Goal: align our server-side fetch with how Bruno itself does it, and reuse where sensible.

### 5.2 Frontend (`plugins/bruno`)

1. **Broaden the attach filter** (`src/extensions.tsx`) so the Bruno card renders on **any `kind: API`** entity, not just `spec.type: bruno-collection` (existing provider-materialized entities still match).
2. **Card states** (`src/components/BrunoCard/BrunoCard.tsx`) — replace the current hard annotation-error with:
   - **Not connected** → a "Connect a Bruno collection" input (GitHub URL field + Connect button).
   - **Connecting** → resolve public/private; on private-not-visible, request the user's token via `githubAuthApiRef.getAccessToken(['repo'])` (this **is** the "prompt to connect GitHub" flow — it opens the OAuth popup if GitHub isn't connected), then retry the connect call with the token.
   - **Connected** → name, request count, source link, Open-in-Bruno, and a Disconnect action.
   - On mount → `GET /connections/:entityRef` to rehydrate.
3. **API client** (`src/api/`) — add `connect(entityRef, url, token?)`, `getConnection(entityRef)`, `disconnect(entityRef)`.

### 5.3 Private-repo flow (the explicit ask, answered)

| Situation | Flow |
|---|---|
| **Public repo** | Connect directly via the service reader. No login needed. |
| **Private repo, GitHub connected** | `githubAuthApiRef.getAccessToken(['repo'])` returns the token silently; backend fetches with it. |
| **Private repo, GitHub *not* connected** | The same `getAccessToken(['repo'])` call opens the GitHub OAuth consent popup. Approve → continue. Decline → the card shows *"GitHub access needed for private repos — Connect GitHub."* |

**Scope, stated up front:** classic OAuth **`repo` scope grants full private read/write** — there is no read-only-private classic scope. This is flagged for security review (R2); a fine-grained PAT is a later alternative.

---

## 6. Feature 3 — Docs column (IN THE PLUGIN, right side of the API page)

- **Condition for display:** the entity has a stored connection (§5). No connection → no docs card.
- **New right-column `EntityCard`** via `EntityCardBlueprint`, e.g. `plugins/bruno/src/components/CollectionTree/`. On mount it reads the connection, calls `getCollection(collectionId)`, and renders a **compact folder + request tree** — folder names, method badges, request names.
- **Reuse, don't rebuild:** draw on the existing tree/badge components from `plugins/bruno/src/components/CollectionDocs/` (the native viewer already built in the POC).
- The full **"API Docs" tab** stays as-is for the detailed viewer + Try-it-out; this card is the at-a-glance summary the ask describes.
- **Placement note (R7):** in the new frontend system, card column/order is largely auto-arranged; forcing the right column may need entity-page layout config or card `area`/ordering hints. Low-risk.

---

## 7. Feature 4 — Bruno in the entity **Links** card (IN THE PLUGIN)

Backstage's standard **`EntityLinksCard`** (already on the entity Overview page by default) renders whatever is in `entity.metadata.links[]` (`{ url, title, icon }`). We surface Bruno there — **no custom UI, just populate `metadata.links`** so a "Bruno" entry appears in the existing Links card.

- **What to add:** an **"Open in Bruno"** link (`bruno://open?url=…`, built by `plugins/bruno/src/lib/brunoLink.ts`) and a **"Bruno collection (source)"** link (the GitHub `sourceUrl`). Icons e.g. `code` / `github`.
- **Provider-materialized entities** — add the entries directly in `BrunoEntityProvider.buildEntity` (`plugins/bruno-backend/src/provider/BrunoEntityProvider.ts`), alongside the annotations it already emits. Trivial, no new machinery.
- **Runtime-connected entities** — the entity is externally-owned, so the same **link/annotation processor** from [`NEXT-STEPS-2.md §4`](./NEXT-STEPS-2.md) that injects `bruno.dev/collection-path` also appends the Bruno `metadata.links` during catalog refresh. (Without that processor, only provider-materialized entities get the Links entry — the runtime case depends on NEXT-STEPS-2.)
- **No blueprint needed:** this is *data on the entity*, not a component — the default Links card renders it.
- **Desktop caveat:** "Open in Bruno" uses the `bruno://open` verb the desktop doesn't implement yet (Q3 / G7); the link is still a useful source pointer and future-proofs the verb once it lands.

---

## 8. Current-state facts (why this is non-trivial)

Evidence from the code, so the coupling is explicit before we touch it.

**Auth** (Backstage `1.53.0`, new frontend system):
- `packages/app/src/App.tsx` — `createApp` from `@backstage/frontend-defaults`; **no `SignInPage`** → guest default.
- `packages/backend/src/index.ts:29–33` — only `plugin-auth-backend` + guest-provider wired.
- GitHub auth-backend module already installed (`^0.5.5`, unwired); Google module not installed.
- `app-config.yaml:129–133` — `auth.providers.guest: {}` only. `integrations.github` (`:50–59`) is a **service PAT**, not user login.

**Card / entity flow (plugin):**
- `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx:65–70` — hard-errors if `bruno.dev/collection-id` is missing.
- `plugins/bruno/src/extensions.tsx:13–15` — `isBrunoCollection` gates card + tab on `kind: API && spec.type === 'bruno-collection'`.
- `plugins/bruno-backend/src/provider/BrunoEntityProvider.ts` — `type: 'full'` mutation; **cannot annotate arbitrary externally-owned entities**.
- Identity is single-keyed: `source.id` = annotation = cache key = URL param. `sourceUrl` is descriptive only, never used for lookup.

**Backend fetch (plugin):**
- `plugins/bruno-backend/src/service/router.ts` — routes accept only a pre-configured `:id`; **no arbitrary-URL route**.
- `plugins/bruno-backend/src/service/collectionService.ts:305–324` — `readUrlTree` uses `coreServices.urlReader` with the **static service token only**. `FileTree → parseCollection` (`:331+`) is **source-agnostic and reusable**.
- `plugins/bruno-backend/src/plugin.ts:19–24` — deps are `httpRouter/logger/config/reader` only. `httpAuth`, `userInfo`, `auth`, `database` all exist in `@backstage/backend-plugin-api@1.9.3`, just unwired.

---

## 9. Risks & blockers

| # | Risk / blocker | Impact | Mitigation |
|---|---|---|---|
| R1 | **OAuth app credentials** (GitHub + Google) are external setup | Blocks Feature 1 harness | Requester provides client id/secret via env vars. Only true hard blocker. |
| R2 | **`repo` scope is broad** (full private read/write) | Security posture | Document explicitly; run `/security-review`; offer fine-grained-PAT later. |
| R3 | **New DB dependency** in `plugins/bruno-backend` | First stateful piece of the plugin | Standard Backstage plugin-DB pattern (Knex + migrations); SQLite in dev. |
| R4 | **User OAuth token is browser-side** by nature | Nuance vs RISK #1 | RISK #1 (the *service* token never reaches the browser) still holds. The user's *own* token is client-obtained by design; the backend never persists it. |
| R5 | **Provider full-mutation ownership** can't annotate arbitrary entities | Why we store, not annotate | Connection lives in the plugin DB keyed by `entityRef`; card reads the store, not annotations. |
| R6 | **Filter broadening** attaches the card to unrelated API entities | UX noise | Unconnected state is a lightweight connect prompt — acceptable; can later gate on a soft opt-in annotation. |
| R7 | **New-frontend card placement** (right column) not fully declarative | Cosmetic | Accept auto-placement first; add layout config if needed. |
| R8 | **`dangerouslyAllowSignInWithoutUserInCatalog`** | Any GitHub/Google user can log in | Intended for the test harness; must tighten for production. |
| R9 | Collection-embedded secrets already returned in responses (`mapAuth`) | Pre-existing | Out of scope here; recorded so it isn't forgotten. |

---

## 10. Phased implementation (sequenced by risk)

- **P1 — Auth test harness [APP] · S–M.** Install Google module; wire both backend modules; add `auth.providers` config + `SignInPage` extension; verify GitHub + Google login and guest fallback. *`packages/backend/src/index.ts`, `app-config.yaml`, `packages/app/src/App.tsx`, new `packages/app/src/modules/auth/`.*
- **P2 — Backend connect + store [PLUGIN] · M–L.** *Start by investigating the Bruno app's own git-fetch path (see §5.1 "Investigate first").* Then: DB migration + `connectionStore`; add `database/httpAuth/userInfo` deps; `readUrlTreeWithCreds`; `POST/GET/DELETE /connections`. *`plugins/bruno-backend/src/plugin.ts`, `src/store/`, `src/service/collectionService.ts`, `src/service/router.ts`.*
- **P3 — Card connect UX [PLUGIN] · M.** Broaden filter; connect/connecting/connected states; token via `githubAuthApiRef`; client methods. *`plugins/bruno/src/extensions.tsx`, `src/components/BrunoCard/`, `src/api/`.*
- **P4 — Docs column card [PLUGIN] · S–M.** New right-column card reusing `CollectionDocs` tree components, gated on connection. *`plugins/bruno/src/extensions.tsx`, new `src/components/CollectionTree/`.*
- **P5 — Links-card entries [PLUGIN] · S.** Add Bruno `metadata.links` (Open-in-Bruno + source) in `BrunoEntityProvider.buildEntity`; runtime-connected entities get them via the NEXT-STEPS-2 processor. *`plugins/bruno-backend/src/provider/BrunoEntityProvider.ts`, `plugins/bruno/src/lib/brunoLink.ts`.*
- **P6 — Docs + security review · S.** This doc + `docs/README.md` cross-link; `/security-review` on the `repo`-scope + user-token path.

Effort: **S** ≈ <1 day · **M** ≈ 1–3 days · **L** ≈ >3 days (rough).

---

## 11. Verification (how we prove each piece)

- **Auth harness** — boot; sign in with GitHub, then Google, then guest; confirm session + avatar; confirm no secrets in the browser network log beyond the standard OAuth handshake.
- **Connect (public)** — on an arbitrary `kind: API` page, paste a public Bruno collection URL → card shows name + request count; reload → rehydrates from the plugin store; DB row present.
- **Connect (private)** — with GitHub connected, paste a private repo URL → `getAccessToken(['repo'])` returns silently → backend fetches via the user token → success. Disconnect GitHub → same paste triggers the OAuth popup; decline → clean "GitHub access needed" prompt. Confirm the service-token-first path works when the org PAT *can* see the repo (no user token used).
- **Docs column** — connected entity shows the right-column tree with folders + method-badged requests; unconnected entity shows no docs card.
- **Links card** — a connected/materialized entity's standard **Links** card shows "Open in Bruno" + "Bruno collection (source)"; the URLs resolve correctly; an unconnected entity shows no Bruno links.
- **Regression** — existing config-materialized collections (`Echo Demo` etc.) still render card + tab unchanged.
- **Plugin self-containment** — confirm no Bruno feature logic leaked into `packages/app` / `packages/backend` beyond the auth harness wiring.

---

## 12. Open items / future

- **Fine-grained PAT** as a narrower alternative to classic `repo` scope (R2).
- **Production sign-in resolver** — replace `dangerouslyAllowSignInWithoutUserInCatalog` with catalog-backed `User` resolution (R8).
- **Declarative right-column placement** for the docs card if auto-arrangement proves insufficient (R7).
