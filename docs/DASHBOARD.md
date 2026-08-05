# Bruno for Backstage — Collections Dashboard (separate plan)

> A **standalone plan**, kept separate from [`NEXT-STEPS.md`](./NEXT-STEPS.md). Scopes a top-level **Bruno dashboard page** in Backstage that lists all collections for the user / org. Grounded in the current implementation: what it can show *today* vs. what unlocks after the runtime-connect work.

**Status:** 💡 Idea / scoping — not yet built. Some capabilities depend on [`NEXT-STEPS.md`](./NEXT-STEPS.md) (auth + the connections DB). · **Last updated:** 2026-08-05

---

## 1. What it is

A dedicated, Bruno-branded **page** (its own sidebar entry, e.g. `/bruno`) that shows every Bruno collection in one place — as a grid/list with aggregate stats, search/filter, and quick actions — scoped to the **user** ("mine") or the **org** ("all").

This is distinct from an entity card or the API Docs tab (which are per-entity). It's a home surface for "show me everything Bruno."

---

## 2. Why not just use `/api-docs`?

Backstage already lists the config-materialized collections as `kind: API` entities under **APIs** (`/api-docs`). A dedicated dashboard earns its place by being **Bruno-specific and richer**:

- Aggregate stat tiles (total collections/requests, method breakdown) that the generic catalog list doesn't compute.
- Bruno actions inline (Open-in-Bruno, jump to Try-it-out, copy source URL).
- **My vs org** scoping via `connected_by` (post-NEXT-STEPS).
- Eventually surfaces **runtime-connected** collections — including ones attached to *non-Bruno* API entities — which won't read as "Bruno" in the plain catalog.

If the value-add stays thin, the fallback is a saved/filtered `/api-docs` view instead of a new page. Decide this before building.

---

## 3. ⚠️ Placement principle (same as the rest of the plugin)

All dashboard code lives in the **plugin**, not the app:
- **Frontend page** — `PageBlueprint` extension in `plugins/bruno` (e.g. `src/components/Dashboard/`), plus a sidebar entry via `NavItemBlueprint`. Both auto-attach; the app already includes `brunoPlugin`, so **no `packages/app` edits**.
- **Backend** — any aggregate endpoint lives in `plugins/bruno-backend`.

---

## 4. What we can show **today** (from current endpoints)

The backend already exposes `GET /collections` (`{ id, name, requestCount, source, sourceUrl }`) and `GET /collections/:id` (full `NormalizedCollection` — environments + item tree). From just these:

| Widget | Source | Notes |
|---|---|---|
| **Collection grid/list** | `GET /collections` | Card per collection: name, request count, source badge (`local`/`url`), source link, Open-in-Bruno, "View docs" (deep-link to the entity's API Docs tab). |
| **Aggregate stat tiles** | `GET /collections` (+ per-id for depth) | Total collections, total requests, # by source type, # of environments. |
| **Method breakdown** | walk items in `GET /collections/:id` | Count of GET/POST/PUT/… — best computed in a backend summary (see §6) to avoid N frontend calls. |
| **Search & filter** | client-side over the list | By name, method, source type, (later) tag/owner. |
| **Failed-source surfacing** | *needs a small backend change* | Today failed sources are **silently dropped** (`collectionService.loadSource` catches + returns `undefined`). The dashboard is the right place to show "N loaded, M failed" — surface errors from the service. |

A **read-only org-wide dashboard is fully feasible with the current backend.**

---

## 5. What unlocks **after** [`NEXT-STEPS.md`](./NEXT-STEPS.md)

Depends on auth + the `bruno_connections` DB from the next phase:

- **User vs org scoping** — the table stamps `connected_by`, so **"My collections"** (connected by me) vs **"All org collections"** becomes real. Config-materialized collections are org-wide.
- **Runtime-connected collections** — collections a user attached by URL appear here, not just config-materialized ones.
- **Recently connected / updated** — from the table's `updated_at`.
- **Per-user empty state** — "You haven't connected any collections yet — go to an API and paste a GitHub URL."

---

## 6. Net-new backend work

- **Aggregate/summary endpoint** — `GET /dashboard` (or extend `GET /collections`) returning per-collection `{ methodCounts, itemCount, envCount, source, ok/error }`, computed server-side and cached. Avoids the page fanning out N `GET /collections/:id` calls.
- **Error surfacing** — expose failed-source info instead of dropping it silently.
- **(Post-NEXT-STEPS)** union config-materialized collections with DB-stored connections, filtered by `connected_by` when "mine" is selected.

---

## 7. Dependencies & risks

| # | Item | Note |
|---|---|---|
| D1 | **User/org scoping depends on NEXT-STEPS** | Without auth + the connections DB, the dashboard is org-wide only. Ship a today-feasible v1, enrich later. |
| D2 | **Aggregates over many collections** | Compute + cache server-side; don't fan out per-collection calls from the browser. |
| D3 | **Overlap with `/api-docs`** | Justify the dedicated page (§2) or fall back to a filtered catalog view. |
| D4 | **Nav real estate** | One more sidebar item; keep it behind a clear Bruno icon/label. |

---

## 8. Rough phasing

- **DP1 — Read-only org dashboard [PLUGIN] · S–M.** `PageBlueprint` page + `NavItemBlueprint`; grid from `GET /collections`; stat tiles; client-side search/filter; deep-links to entity API Docs. *No backend change strictly required.*
- **DP2 — Backend summary + errors [PLUGIN] · S.** `GET /dashboard` aggregate (method breakdown, counts) + failed-source surfacing.
- **DP3 — User/org scoping [PLUGIN, needs NEXT-STEPS] · M.** "Mine vs org" toggle via `connected_by`; include runtime-connected collections; recent activity.

Effort: **S** ≈ <1 day · **M** ≈ 1–3 days · **L** ≈ >3 days (rough).

---

## 9. Verification

- **DP1** — open the Bruno sidebar entry → dashboard lists all current collections with correct names/request counts; search/filter works; clicking a collection lands on its API Docs tab.
- **DP2** — stat tiles + method breakdown match a hand-count for a known collection; a deliberately broken source shows as "failed," not missing.
- **DP3** — signed in, "Mine" shows only collections I connected; "Org" shows all; a newly connected collection appears without a restart.
