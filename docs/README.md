# Bruno for Backstage — POC Documentation

> Entry point for the **Bruno for Backstage** feasibility POC. This page narrates what has happened so far and links every companion doc and the key code it refers to. Start here.

**Status:** 🟢 POC active — spine runs end-to-end (local + public sources); the **runtime-connect next phase (NEXT-STEPS.md P1–P5) is now built + committed** on `feat/next-steps-runtime-connect` and security-reviewed. Verdict = **GO** for a future Beta, but **Beta is not authorized yet — the POC is still ongoing.** · **Last updated:** 2026-08-05

---

## What this POC is

A time-boxed feasibility spike (Epic **BRU-2982**) to de-risk a larger "Bruno for Backstage" plugin (Beta **BRU-824**) *before* committing to it. It answers two Beta-killer questions and produces a go / adjust / no-go recommendation:

1. **RISK #1** — Can Backstage fetch collections from a **private GitHub repo** server-side, with no *service/App* credentials ever reaching the browser? (The requesting user's own GitHub OAuth token *is* client-obtained by design and passed through for a single backend fetch.)
2. **RISK #2** — Can a **Collection Docs** experience live *inside* Backstage (vs. only linking out)?

Both came back positive. Details and evidence are in the docs below.

---

## The documents (read in this order)

| Doc | What it is | When to read it |
|-----|-----------|-----------------|
| **[POC-PLAN.md](./POC-PLAN.md)** | The plan: context, scope, the six feasibility questions (Q1–Q6), the two docs-experience scenarios, roadmap (POC → Beta → GA), tech stack, deliverables, success criteria. | To understand *why* the POC exists and *what* it set out to prove. |
| **[POC-DECISIONS.md](./POC-DECISIONS.md)** | The living findings + decisions log: decisions D1–D5, architecture, the shared backend⇄frontend API contract, the Q1–Q6 evidence table, per-feature effort estimates, CORS/proxy notes, and the **GO verdict** (§8). | To understand *what was built and decided*, and the evidence behind the verdict. |
| **[POC-GAPS.md](./POC-GAPS.md)** | The gaps register: every open item (G1–G10) with current-vs-expected state, `file:line` evidence, priority tag, and rough effort. | To understand *what is still open* and what to pick up next. |
| **[NEXT-STEPS.md](./NEXT-STEPS.md)** | The next-phase scoping: app-side auth test-harness, runtime URL→API connect flow (public + private), and the docs-column card. Locked decisions, exact wiring, risks/blockers, phased plan. | To understand *what's planned next* and how it's designed before it's built. |
| **[NEXT-STEPS-2.md](./NEXT-STEPS-2.md)** | Second-iteration plan (mockup-informed): the dedicated **Bruno page** — Collections dashboard + Link API console — and the **catalog-processor annotation-injection** linking model. Excludes north-star items (org-crawl, match-ranking, request-search) and the Test Runs / Setup tabs. | To understand the Bruno-page design and the improved linking mechanism. |
| **[DASHBOARD.md](./DASHBOARD.md)** | A *separate* plan: a top-level Bruno dashboard page listing all collections for the user/org — what's buildable today vs. what depends on NEXT-STEPS. **Largely absorbed into NEXT-STEPS-2.** | To see the original standalone dashboard exploration. |
| **[execution/](./execution)** | Per-phase execution plans (P2–P6) that drove the runtime-connect build via a plan → execute → review pipeline, plus **[P6-security-review.md](./execution/P6-security-review.md)** (the credential-surface audit). | To see how each NEXT-STEPS phase was planned/reviewed, and the security findings. |
| **[screenshots/](./screenshots)** | Evidence captures from the running app (entity + BrunoCard, docs viewer, try-it-out via proxy). | Referenced from `POC-DECISIONS.md §Screenshots`. |

---

## What has happened so far (chronological)

1. **Framed the POC.** Read the requirement, reframed an earlier speculative plan around the actual POC ask, and wrote **[POC-PLAN.md](./POC-PLAN.md)** — locking scope to a thin vertical slice plus the two risk spikes, and defining Q1–Q6.

2. **Locked kickoff decisions (D1–D5).** Recorded in **[POC-DECISIONS.md §1](./POC-DECISIONS.md)**:
   - **D1** — self-contained demo (committed sample collections) + a documented private path.
   - **D2** — build the Collection Docs viewer **natively** from scratch (do *not* embed `@opencollection/docs`, which isn't even published to npm).
   - **D3** — wire **Open-in-Bruno** and document the desktop gap; do not modify `bruno-electron`.
   - **D4** — handle in-portal "try it out" CORS via **Backstage's proxy backend**.
   - **D5** — use our **own normalized collection model** (parsed via `@usebruno/lang`) and make the generated docs HTML fully self-contained (zero CDN egress).

3. **Built the two plugins + sample data.**
   - **Backend** — `plugins/bruno-backend/` — collection-fetch service (`src/service/collectionService.ts`, with both local and `UrlReader`/GitHub paths), HTTP routes (`src/service/router.ts`), self-contained HTML generator (`src/service/generateCollectionHtml.ts`), and the `BrunoEntityProvider` catalog module (`src/provider/`, `src/module.ts`).
   - **Frontend** — `plugins/bruno/` — the `BrunoCard`, the native Collection Docs viewer + Try-it-out (`src/components/CollectionDocs/`), Open-in-Bruno (`src/lib/brunoLink.ts`), and the proxy resolver (`src/lib/proxy.ts`).
   - **Sample data** — `sample-collections/` (`echo-demo`, `sandwich-exec`, `sequential-exec`), all targeting **public** hosts.
   - **Wiring** — `app-config.yaml` (`bruno:` sources + `proxy.endpoints`), `packages/backend/src/index.ts`, `packages/app/src/App.tsx`.

4. **Got it green and verified.** `yarn install` + typecheck clean; fixed a `@usebruno/lang` V2-export bug; ported the ESLint flat config from `../bruno-api-docs` (`eslint.config.mjs`); ran full browser verification (Playwright, guest auth). Captured **[screenshots/](./screenshots)** proving Q1/Q2 (entity + card), Q5 (native viewer), and Q5-exec + D4 (try-it-out → 200 via proxy).

5. **Resolved a "no demo data" confusion.** The collections materialize as `kind: API` entities, so they appear under **APIs** (`/api-docs`), not the default Catalog landing. Documented at the top of **[POC-DECISIONS.md](./POC-DECISIONS.md)**.

6. **Reached the verdict.** All Q1–Q6 answered with evidence; **GO** recommendation with two adjustments (native viewer wins; `bruno://open` is a real external dependency). See **[POC-DECISIONS.md §8](./POC-DECISIONS.md)**.

7. **Catalogued the gaps.** Wrote **[POC-GAPS.md](./POC-GAPS.md)** — a fresh 3-part exploration of the frontend, backend, and sample/repo state, distilled into 10 open items (G1–G10) with evidence and priorities. Reframed away from "Beta-scope" because **the POC is still active**.

8. **Scoped the next phase.** Wrote **[NEXT-STEPS.md](./NEXT-STEPS.md)** — the design for moving collections from static config to a **runtime, user-driven connect flow**: an app-side GitHub/Google auth test-harness, a paste-a-URL → connect flow (public anonymously; private via the user's GitHub OAuth token — a host GitHub App/PAT optional), and a docs-column card. Locked three decisions (DB persistence, service-then-user creds, any-authenticated-user), with risks/blockers and a phased plan. **Scoped, not yet built.**

---

## Where things stand

**Working today:** discovery → `kind: API` entity → BrunoCard → native Collection Docs viewer → in-portal Try-it-out (GET/POST, json/text/xml/form-url-encoded) routed through the Backstage proxy → self-contained docs HTML. Runs against local and public sources with no credentials.

**Top open items** (full list in **[POC-GAPS.md](./POC-GAPS.md)**):
- **G1** 🟡 — the remote (private/URL) repo path is built but never run live; this touches a stated POC success criterion.
- **G2** 🟡 — all POC work is still uncommitted.
- **G3–G7, G10** 🔵 — open enhancements (auth/multipart/graphql execution, single-env vars, the `bruno://open` desktop verb, tests).
- **G8, G9** ⚪ — optional (proxy-map duplication, broader sample coverage).

> **Beta is not authorized.** Everything above is tracked as open **POC** work; no productionization/Beta workstream starts until explicitly greenlit.

---

## Running the demo

`yarn install`, then `yarn start`, then open `http://localhost:3000` → sign in as guest → **APIs** (`/api-docs`) → pick a collection → **API Docs** tab. Full note (including why `/catalog` 404s in this scaffold) is at the top of **[POC-DECISIONS.md](./POC-DECISIONS.md)**.
