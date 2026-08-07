# Bruno for Backstage — POC Gaps Register

> Companion to [`POC-PLAN.md`](./POC-PLAN.md) (scope, Q1–Q6, roadmap) and [`POC-DECISIONS.md`](./POC-DECISIONS.md) (decisions, evidence, GO verdict). This doc is the **single catalogue of every known gap** in the POC as it stands, so remaining work is captured in one scannable place before anyone picks it up.

**Status:** POC functionally complete, verdict = 🟢 GO ([`POC-DECISIONS.md §8`](./POC-DECISIONS.md)). This register lists what is *not* done. · **Last updated:** 2026-08-05

**This is a register, not a re-scoping.** It records gaps and their evidence; it does not resolve them. **The POC is still active — no Beta work proceeds until explicitly authorized.** Every gap below is an *open POC item*; the tags indicate priority, not phase hand-off.

### Priority legend

| Tag | Meaning |
|-----|---------|
| 🟡 **Blocks sign-off** | Needed to fully close Phase 0 against its own success criteria. |
| 🔵 **Enhancement** | An open POC item that improves fidelity/coverage. Previously *noted* as a Beta-hardening candidate in [`POC-DECISIONS.md §5`](./POC-DECISIONS.md), but **not** auto-deferred — addressable within the POC at the user's direction. |
| ⚪ **Optional** | Nice-to-have / hygiene; not required by any stated criterion. |

Effort: **S** ≈ <1 day · **M** ≈ 1–3 days · **L** ≈ >3 days (rough, POC-informed).

---

## 1. Summary

| ID | Area | Gap | Priority | Effort |
|----|------|-----|----------|--------|
| **G1** | Backend fetch | Remote (private/URL) repo path never run live | 🟡 Blocks sign-off | S (public) / M (private, needs creds) |
| **G2** | Git | All POC work is uncommitted | 🟡 Blocks sign-off | S |
| **G3** | Try-it-out | Auth never applied to outgoing requests | 🔵 Enhancement | M |
| **G4** | Try-it-out | `multipartForm` body not implemented | 🔵 Enhancement | S |
| **G5** | Try-it-out | `graphql` body not implemented | 🔵 Enhancement | S |
| **G6** | Try-it-out | Template vars resolve against first environment only | 🔵 Enhancement | S |
| **G7** | Desktop | `bruno://open` verb unsupported by Bruno desktop | 🔵 Enhancement | M–L (external repo) |
| **G8** | Proxy/CORS | Proxy host map hardcoded + duplicated with config | ⚪ Optional | S |
| **G9** | Sample data | Only 1 of 22 bruno-tests collections represented | ⚪ Optional | S |
| **G10** | Testing | Zero automated tests | 🔵 Enhancement | M |

---

## 2. POC-scope gaps

These are the gaps that, strictly, leave a Phase-0 success criterion not-fully-met.

### G1 — Remote (private/URL) repo path never run live 🟡

- **Expected:** POC success criterion — *"the demo slice runs end to end for both a public **and** a private GitHub collection"* ([`POC-PLAN.md` §Success criteria](./POC-PLAN.md)). This exercises **RISK #1 / Q4** — server-side fetch with Backstage creds, no token to the browser.
- **Current:** All 3 active `bruno.sources` are `type: local` (`app-config.yaml`). The remote `url` source is present but **commented out** (`app-config.yaml`, ~lines 107–113) and has never been exercised at runtime. The code path itself is complete and live, **not** a stub: `readUrlTree()` calls `UrlReaderService.readTree()` (`plugins/bruno-backend/src/service/collectionService.ts:305–324`), and `loadSource()` already dispatches on `source.type` (`collectionService.ts:147–159`). The `integrations.github` block (`app-config.yaml`, ~lines 50–59) is **tokenless by default** (`GITHUB_TOKEN` is commented out in `.env`), so public repos read anonymously; **private-repo reads use the requesting user's GitHub OAuth token**.
- **To close:**
  - *Public half (no creds, fully autonomous):* uncomment the `url` source pointing at a public repo (e.g. `https://github.com/usebruno/bruno/tree/main/packages/bruno-tests/collection/echo`), boot, confirm a 4th `kind: API` entity materializes and renders. Exercises the **identical** UrlReader code path.
  - *Private half (needs a real private repo):* point the `url` source at a private repo, sign in via the GitHub auth provider so the plugin sends the user's OAuth token (`x-bruno-github-token`), and verify — via the browser network log — that the **service/App credential** never crosses to the client and the only egress is Backstage→GitHub. (The user's own token is client-obtained by design; the token-never-crosses assertion applies to the service/App credential.)
- **Status today:** 🟢 *Built + reasoned* ([`POC-DECISIONS.md` Q4](./POC-DECISIONS.md)); runtime proof outstanding.

### G2 — All POC work is uncommitted 🟡

- **Expected:** The deliverable (plugins, sample data, findings docs) captured in git.
- **Current:** On top of a single `Initial commit` (`4f47167`):
  - **Untracked:** `plugins/bruno/`, `plugins/bruno-backend/`, `sample-collections/`, `docs/`, `eslint.config.mjs`.
  - **Modified, uncommitted:** `app-config.yaml`, `packages/app/src/App.tsx`, `packages/backend/src/index.ts`, `package.json`, `packages/app/package.json`, `packages/backend/package.json`, `yarn.lock`, `.yarn/releases/yarn-4.13.0.cjs`.
- **To close:** branch + commit (deferred by the user for now).

---

## 3. Try-it-out execution gaps 🔵

Viewer breadth — open POC enhancements. These were *noted* against the native-viewer hardening line in [`POC-DECISIONS.md §5`](./POC-DECISIONS.md), but remain addressable within the POC; recorded here so the specific holes are explicit. All live in the frontend plugin.

### G3 — Auth never applied to outgoing requests 🔵

- **Expected:** A request with `auth.mode` of `basic`/`bearer`/`apikey`/`digest` sends the corresponding credentials/headers.
- **Current:** Auth modes are typed (`plugins/bruno/src/api/types.ts:54–60`) and rendered **read-only** in the UI (`plugins/bruno/src/components/CollectionDocs/RequestDetail.tsx:171–186`), but the executor never reads `item.auth` — `send()` (`plugins/bruno/src/components/CollectionDocs/TryItOut.tsx:40–83`) builds the request without any auth application. So try-it-out against an authenticated endpoint sends **no credentials**.

### G4 — `multipartForm` body not implemented 🔵

- **Current:** `multipartForm` is a declared body mode (`plugins/bruno/src/api/types.ts:45`) but has **no serialization branch** in `plugins/bruno/src/components/CollectionDocs/template.ts` (which handles `json`/`text`/`xml`/`formUrlEncoded`). A multipart request would send no body.

### G5 — `graphql` body not implemented 🔵

- **Current:** `graphql` is a declared body mode (`plugins/bruno/src/api/types.ts:46`) and graphql-type requests are recognized, but they are executed as **generic HTTP** with no GraphQL-specific payload (no `{ query, variables }` construction) in `template.ts`.

### G6 — Template vars resolve against the first environment only 🔵

- **Current:** `buildVarMap` filters to `environments?.[0]` (`plugins/bruno/src/components/CollectionDocs/template.ts:10`), i.e. only the first environment's variables are available; there is **no environment switcher** in the viewer. This is **by design for the POC** (see the spec note at `template.ts:5`) — flagged here so the limitation is visible. Substitution itself is complete across url/headers/params/body.

---

## 4. Desktop / deep-link gaps

### G7 — `bruno://open` verb unsupported by Bruno desktop 🔵

- **Expected:** Clicking **Open in Bruno** launches the desktop app on the collection.
- **Current:** The deep-link builder is complete — `buildBrunoDeepLink()` emits `bruno://open?url=<encoded>` (`plugins/bruno/src/lib/brunoLink.ts:31–34`) — but **Bruno desktop only handles `bruno://app/oauth2/callback`** today; the `open`/`clone` verb does not exist. This is the **Q3 dependency** on the separate `bruno-electron` repo ([`POC-DECISIONS.md` D3 / A2, Q3](./POC-DECISIONS.md)). The POC decision (D3) was to **wire the link + document the gap**, not modify `bruno-electron`. Closing it fully requires a change in that external repo.
- **Mitigation in place:** a fully-implemented **clone-and-scan stand-in** — `toCloneUrl()` / `buildCloneInstruction()` (`plugins/bruno/src/lib/brunoLink.ts:40–60`), surfaced via a dropdown that copies a `git clone` instruction (`plugins/bruno/src/components/OpenInBruno/OpenInBruno.tsx:45–54`).

---

## 5. Proxy / CORS gaps

### G8 — Proxy host map hardcoded + duplicated with config ⚪

- **Current:** In-portal try-it-out routes known hosts through the Backstage proxy via `PROXY_HOST_MAP` (`plugins/bruno/src/lib/proxy.ts:26–30`), which must be kept **manually in sync** with `proxy.endpoints` in `app-config.yaml` (see [`POC-DECISIONS.md §6`](./POC-DECISIONS.md)). Consequences:
  - Adding a target host = edits in **two** places (frontend map + config).
  - **Unmapped hosts** fall back to a direct browser `fetch` (`plugins/bruno/src/components/CollectionDocs/TryItOut.tsx:73–79`) and will hit CORS inside a portal.
  - No mechanism to derive the allowlist from config at runtime.
- **Note:** Fine for the 3-host demo; becomes friction at Beta scale. Beta item *"Try-it-out via proxy → general host-allowlist"* ([`POC-DECISIONS.md §8`](./POC-DECISIONS.md)) subsumes this.

---

## 6. Sample data gaps

### G9 — Only 1 of 22 bruno-tests collections represented ⚪

- **Current:** Of the 3 sample collections, only **`echo-demo`** is a genuine `bruno-tests` collection (upstream `echo`). `sandwich-exec` and `sequential-exec` are **hand-made, hyphen-named replicas** (upstream uses `sandwich_exec` / `sequential_exec`). The upstream `packages/bruno-tests/collection` has **22** collections; 21 are unrepresented — including `auth`, `graphql`, `multipart`, `scripting`, `asserts`, `environments`, `response-parsing`, etc.
- **Why it matters:** several of the missing collections (`auth`, `graphql`, `multipart`) would directly exercise **G3–G5**, making those gaps demonstrable rather than theoretical.
- **Constraint:** any added collection must target **public hosts only** (current set: `example.com`, `echo.usebruno.com`, `testbench-sanity.usebruno.com`) so the demo stays credential-free and each new host needs a matching proxy endpoint (see G8).

---

## 7. Testing gaps

### G10 — Zero automated tests 🔵 (open POC enhancement)

- **Current:** No `*.test.ts(x)` / `*.spec.ts(x)` files in **either** plugin (`plugins/bruno`, `plugins/bruno-backend`). The stack recommended in [`POC-PLAN.md`](./POC-PLAN.md) (Jest + `@backstage/test-utils`, supertest for the router, Playwright for e2e) is unused. POC verification was **manual / ad-hoc Playwright** scripts kept in the session scratchpad, not committed.
- **Would-be coverage:** `collectionService` parsing / tree-walking / `.bru`→`NormalizedCollection`; `BrunoEntityProvider` schedule + mutation; router endpoints (404, HTML gen, JSON); frontend `template.ts` / `proxy.ts` / `brunoLink.ts` units.

---

## 8. Priority note

**The POC is still active. No Beta work starts until explicitly authorized** — the tags below are priorities *within* the POC, not a hand-off to a next phase.

- **Blocks Phase-0 sign-off:** **G1** (an explicit success criterion is unmet at runtime). **G2** matters for capturing the deliverable, but is git hygiene, not a functional criterion.
- **Open enhancements** (fidelity/coverage, addressable in the POC at the user's call): **G3, G4, G5, G6, G7, G10**. Several were *noted* as Beta-hardening candidates in [`POC-DECISIONS.md §5`](./POC-DECISIONS.md), but none is auto-deferred. **G7** is the one whose full fix lives outside this repo (`bruno-electron`).
- **Optional / hygiene:** **G8** (proxy ergonomics), **G9** (demo breadth).

Nothing in this register changes the 🟢 **GO** verdict ([`POC-DECISIONS.md §8`](./POC-DECISIONS.md)); the two headline risks (RISK #1 private fetch, RISK #2 in-Backstage docs) are both resolved. The one item touching a stated POC criterion is **G1**, and its code path is built — only the live remote run is outstanding.
