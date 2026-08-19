# MSCM-P1 — Backend `ScmProvider` seam, GitHub adapter only · **LOCKED**

**Scope:** Introduce a backend `ScmProvider` adapter seam in a new
`plugins/bruno-backend/src/scm/` directory, move today's GitHub-coupled URL
grammar / ref-resolution logic behind it, and dispatch on
`integrations.byUrl(url)?.type`. **Pure refactor, zero behaviour change.**
Implements MULTI-SCM-PLAN.md phase MSCM-P1 (addresses B1 structurally).

**Baseline:** assumes **MSCM-P0 has landed**, so this plan uses the P0 names
(`sourceUrl`, `x-bruno-scm-token`, `source_url`, `scmTokenFromHeader`).

**Line anchors** were verified against disk at commit `ef10756`. Every P0 edit in
the files P1 touches is an **in-place single-line replacement**, so all anchors
below still hold after P0. (P0's only line-count change is the guarded
`renameColumn` branch in the two store files — which **P1 does not touch**.)

---

## NON-goals

- **No behaviour change of any kind.** Same URLs parsed, same URLs composed, same
  collection ids, same number of outbound API calls, same errors with the same
  messages, same cache keys and TTLs.
- **No change to the Octokit fallback's behaviour.** `readUrlTreeViaOctokit`
  (`collectionService.ts:745`) keeps working **identically**. Replacing it is
  **P2**, and a separate spike is currently testing its replacement — **do not
  pre-empt that spike.** This plan deliberately leaves the function *in
  `collectionService.ts`* (see "Why the tree-fetch path does not move").
- **No new provider.** GitHub adapter only. GitLab/Bitbucket are **P5**.
- **No frontend changes.** `plugins/bruno/src/lib/githubUrl.ts` and its
  `repoRootFromCollectionUrl` stay exactly as they are — the frontend `ScmAuth`
  migration is **P3**. P0 already absorbed the only frontend renames.
- **No `credentialConfigFor`.** Deferred to **P2** — see "Interface departures".
- **No collection-id scheme change.** Ids stay `sha256(normalizeUrl(url))[0..16]`.
  Versioned ids + migration are **P4** (B2).
- **No `UrlReaders.default` / synthesized config.** **P2**.
- **No new abstraction beyond the seam itself.** No DI container, no plugin
  registry service, no config-driven adapter loading.
- **No touching `packages/app` or `packages/backend`.** No registration change is
  needed: the seam is constructed inside `createCollectionService`.
- **No app tests.** None exist; none are to be added.

---

## Standing project constraints (apply to this phase)

- Yarn 4. Authoritative gates: **`yarn tsc`** (repo-level, **0 errors**) and
  **`yarn lint:bruno plugins/bruno plugins/bruno-backend`**.
  **`backstage-cli build` is NOT a gate** — it transpiles without full
  type-checking.
- **No app tests exist in this project and none should be added.** Verification =
  the two gates + a live boot / functional check.
- All feature work stays in `plugins/bruno` and `plugins/bruno-backend`;
  `packages/app` / `packages/backend` only for registration/auth-harness wiring
  (**neither is touched here**).
- **Never log or return a user OAuth token from any code path. Never stage
  `.env`.**
- `import type` for type-only imports. Minimal diff, match surrounding style,
  no narration comments, no dead code.
- MUI v4 on the frontend; new-backend-system APIs (`createBackendPlugin`,
  `coreServices`) on the backend.

### Gate baseline you must preserve exactly (measured at `ef10756`)

- `yarn tsc` → **0 errors**.
- `yarn lint:bruno plugins/bruno plugins/bruno-backend` → **6 problems: 1 error,
  5 warnings**:
  - `plugins/bruno-backend/src/service/router.ts:258:16` — `@stylistic/arrow-parens`
    (carried docs-auth work, **deliberately left alone**);
  - `plugins/bruno-backend/src/types/usebruno-converters.d.ts:10:53` and `:10:59`
    — `@typescript-eslint/no-explicit-any`;
  - `plugins/bruno-backend/src/types/usebruno-lang.d.ts:12:47`, `:14:50`, `:16:55`
    — `@typescript-eslint/no-explicit-any`.
- **Do not "fix" any of those and do not introduce new ones. Do not run
  `yarn lint:bruno:fix`.** New files under `src/scm/` must add **zero** new
  errors and **zero** new warnings — in particular, no `any`.

---

## Where the adapter files live — decision + justification

```
plugins/bruno-backend/src/scm/
  types.ts     — ScmProvider, ParsedRepoUrl (types only; no runtime imports)
  github.ts    — createGithubScmProvider(...)
  index.ts     — createScmProviderRegistry(...) + re-exports of types.ts
```

### Why a sibling `src/scm/`, not inside `src/service/`

1. **The seam's growth axis is one file per provider.** P5 adds `gitlab.ts`,
   `bitbucketCloud.ts`, `bitbucketServer.ts`. A dedicated directory makes the
   dependency rule visually enforceable — *"nothing in `scm/` imports from
   `service/`"* is checkable by eye and by one grep (acceptance criterion 6).
   Burying adapters in `service/` makes that rule invisible.
2. **`service/collectionService.ts` is already 1787 lines.** Adding provider
   files beside it worsens the file that most needs decomposition.
3. **It matches the existing top-level layout.** `src/` already separates
   `service/`, `store/`, `provider/`, `processor/` by role. `scm/` is the same
   kind of boundary.

### Import-cycle analysis (this repo has been bitten before — verified, not assumed)

Current local dependency edges, read from disk:

| module | imports from (local) |
|---|---|
| `service/collectionService.ts` | `../types` (types only), `../store/connectionStore` (type only), `../store/collectionsStore` (type only) |
| `provider/BrunoEntityProvider.ts` | **`../service/collectionService`** — `type CollectionService` (`:8-9`) **and values** `readBrunoSources`, `sanitizeName` (`:10-13`); plus `../types` (`:14`) |
| `processor/BrunoLinkProcessor.ts` | **nothing local** — only `@backstage/*` (verified: `:1-13`) |

So today `collectionService.ts` is a **leaf** among local modules (it imports
only pure-type modules), and the single inbound edge is
`BrunoEntityProvider → collectionService`.

**The rule this phase must not break** (stated in the brief): a helper needed by
both a provider and a service belongs in the service (exported) and is imported
by the provider — one dependency direction.

**Resulting DAG after P1:**

```
        ../types  (pure types, imports nothing local)
             ▲
             │
   ┌─────────┴──────────┐
   │                    │
scm/types.ts        service/collectionService.ts ──► scm/index.ts ──► scm/github.ts
   ▲                    ▲                                 │              │
   └────────────────────┼─────────────────────────────────┴──────────────┘
                        │                                        (both ► scm/types.ts)
        provider/BrunoEntityProvider.ts ──► scm/index.ts
```

- `scm/*` imports **only** `@backstage/*` and (if needed) `../types`. It imports
  **nothing** from `service/`, `store/`, `provider/`, or `processor/`.
- `collectionService.ts → scm/index.ts` is a new edge in the **same direction**
  as its existing edges (toward leaves). No cycle.
- `BrunoEntityProvider.ts → scm/index.ts` is a **new second edge from the
  provider**, which already depends on `collectionService`. Both point away from
  the provider. No cycle. **`collectionService` gains no dependency on the
  provider**, so the stated rule holds.

**The trap this avoids, stated explicitly:** `FileTree`
(`collectionService.ts:111-113`) is a **module-private, non-exported** type. If
the Octokit fallback moved into `scm/github.ts`, that file would need `FileTree`,
forcing either `scm/ → service/` (a cycle, since `service/ → scm/`) or a
relocation of `FileTree` into `../types`. **This plan does neither**: the
tree-fetch path stays in `collectionService.ts`, so `FileTree` never crosses the
seam and the cycle never becomes possible. This is the single most important
placement consequence.

### Why the tree-fetch path does not move (and the brief permits this)

The brief says the Octokit fallback "may move behind the seam, but it must keep
working identically." Keeping it put is strictly better here:

- It is the **only** consumer of `FileTree` on the provider-coupled side; moving
  it is what would force the `FileTree` relocation above.
- **P2 replaces it wholesale** with `UrlReaders`/`readTree`. Moving it in P1 and
  deleting it in P2 is churn on a code path an active spike is testing.
- The seam still removes **all** of its provider-coupled *grammar*: after this
  phase `readUrlTreeViaOctokit` calls `provider.parseRepoUrl(url)` instead of
  `parseGithubUrl(url)`, so no GitHub URL grammar is duplicated anywhere.

The residual GitHub coupling left in `collectionService.ts` after P1 is therefore
exactly: the `Octokit` import (`:10`), `readUrlTreeViaOctokit` (`:745-803`), and
`DefaultGithubCredentialsProvider` (`:244-245`) — **all three are P2's scope**,
and all three are named in P2's acceptance criteria. Note this **relaxes**
MULTI-SCM-PLAN.md §MSCM-P1's acceptance wording — see "Corrections".

---

## The adapter interface

### `plugins/bruno-backend/src/scm/types.ts` (new file)

```ts
/** A repo URL decomposed into the parts the collection loader needs. */
export interface ParsedRepoUrl {
  owner: string;
  repo: string;
  /** The explicit ref from the URL, when the grammar carries one. */
  ref?: string;
  /** Path of the collection root within the repo; `''` = repo root. */
  subpath: string;
}

/**
 * Per-provider URL grammar and ref resolution. One implementation per SCM
 * provider; selected by `ScmIntegration.type` (see `createScmProviderRegistry`).
 */
export interface ScmProvider {
  /** The `ScmIntegration.type` this adapter serves, e.g. `'github'`. */
  readonly type: string;

  /**
   * Reduces a URL to the stable identity string that keys the collection cache
   * and seeds the collection id. Must be idempotent.
   */
  normalizeUrl(url: string): string;

  parseRepoUrl(url: string): ParsedRepoUrl;

  /**
   * Rebuilds a fully-qualified collection URL for a root discovered within
   * `normalizedRepoUrl`. `ref` is required: the composed URL is the collection's
   * stored identity, so it must name a concrete ref.
   */
  composeCollectionUrl(
    normalizedRepoUrl: string,
    rootPrefixWithinInput: string,
    ref: string
  ): string;

  /** Reduces a collection URL to its repo-root URL. Must never throw. */
  repoRootFromUrl(url: string): string;

  /**
   * Resolves the repo's default branch. Called only when the URL carries no
   * explicit ref, and only to name a ref in a composed URL.
   */
  resolveDefaultBranch(
    url: string,
    opts?: { userToken?: string }
  ): Promise<string>;
}
```

### Departures from MULTI-SCM-PLAN.md §3 — each justified

§3 proposes: `parseRepoUrl`, `composeCollectionUrl`, `repoRootFromUrl`,
`resolveDefaultBranch`, `credentialConfigFor`.

| change | justification |
|---|---|
| **ADD `normalizeUrl`** | §3 omits it, and it is **the single most important method on the seam.** `normalizeGithubUrl` (`collectionService.ts:203`) does `u.search = ''` (`:207`), which per B1 **destroys the ref** for Bitbucket Server (`?at=`) and Azure (`?version=`). Normalization is therefore irreducibly per-provider, and it is also the input to `collectionIdFromUrl` (`:217`) — i.e. to collection identity. Leaving it off the interface would leave the highest-value provider coupling outside the seam and make P4/P5 re-open it. |
| **ADD `readonly type`** | Needed for the registry's self-check (an adapter registered under the wrong key is a silent bug) and by P4's `v2:<provider>:<hash>` id scheme. One field, already known at construction, zero cost. |
| **DROP `credentialConfigFor`** | It has **no caller in P1** — its only consumer is P2's credential injection. Adding it now means every adapter must stub a method nobody calls, which is **dead code** (a standing constraint) and imposes a compile-time tax on P5's three new adapters. Add it in P2 where it has a caller. **Also: P2 likely does not need it in this shape at all** — see "Corrections" item 1 re. `readTree`'s `token` option. |
| **KEEP `resolveDefaultBranch`** (contra a mid-flight instruction to drop it) | **Verified load-bearing.** `resolveRef` is called once at `collectionService.ts:461`, *after* the tree fetch, and its result is consumed at **exactly one** place: `composeCollectionUrl(normalized, rootPrefix, ref)` (`:479`). That composed URL becomes both the stored `sourceUrl` and — via `collectionIdFromUrl` (`:484`) — the **collection id**. So the ref is an **identity input, not a fetch precondition**, and `readTree` resolving a branch internally does not help because it never returns the ref it used. Dropping this method would break URL composition and re-key every discovered collection. |
| **`resolveDefaultBranch`, not `resolveRef`** | Today's `resolveRef` (`:969-995`) does two things: return the explicit ref if the URL has one (`:975-978`), else fetch the default branch (`:979-994`). The first half is **provider-agnostic given `parseRepoUrl`**. So `resolveRef` stays a thin function in `collectionService.ts` that calls `provider.parseRepoUrl` then `provider.resolveDefaultBranch`; only the genuinely provider-specific API call lands on the seam. Smaller interface, smaller diff. |
| **`resolveDefaultBranch` kept separate from `composeCollectionUrl`** (not folded in) | Folding the lookup into `composeCollectionUrl` would be more cohesive but is a **behaviour change**: `resolveRef` is currently hoisted **outside** the `roots.map(...)` at `:461`, so a discover of N roots makes **one** default-branch call. Calling it inside `composeCollectionUrl` would make **N**. Keeping them separate preserves the 1-call-per-discover behaviour exactly. |
| **Provider deps captured at construction, not passed per call** | §3's sketch implies `resolveDefaultBranch(url, auth)`. GitHub's implementation needs `ScmIntegrationRegistry` *and* a `GithubCredentialsProvider` *and* `apiBaseUrl` — provider-specific dependencies that must not leak into a shared signature. `createGithubScmProvider({ integrations, githubCredentials })` captures them; the interface stays clean and P5's adapters take whatever *they* need. `userToken` stays a per-call option because it is per-request. |

Final surface: **`type` + 5 methods.**

---

## Dispatch — `integrations.byUrl(url)?.type`, not hostname matching

### `plugins/bruno-backend/src/scm/index.ts` (new file)

```ts
import type { ScmIntegrationRegistry, GithubCredentialsProvider }
  from '@backstage/integration';
import { createGithubScmProvider } from './github';
import type { ScmProvider } from './types';

export type { ScmProvider, ParsedRepoUrl } from './types';

export interface ScmProviderRegistry {
  byUrl(url: string): ScmProvider;
}

export function createScmProviderRegistry(options: {
  integrations: ScmIntegrationRegistry;
  githubCredentials: GithubCredentialsProvider;
}): ScmProviderRegistry {
  const { integrations, githubCredentials } = options;
  const github = createGithubScmProvider({ integrations, githubCredentials });
  const byType = new Map<string, ScmProvider>([[github.type, github]]);

  return {
    byUrl(url: string): ScmProvider {
      const type = integrations.byUrl(url)?.type;
      // An unconfigured host yields no integration. Today every URL is parsed
      // GitHub-shaped, so falling back to the GitHub adapter keeps that exact
      // behaviour; P5 turns an unknown provider into an explicit error.
      return (type && byType.get(type)) ?? github;
    }
  };
}
```

### Why the fallback is mandatory for zero behaviour change (verified)

`ScmIntegration.type: string` is confirmed at
`node_modules/@backstage/integration/dist/index.d.ts:16`; `byUrl` at `:76` /
`:1896`.

- **`github.com` always resolves.**
  `readGithubIntegrationConfigs` (`node_modules/@backstage/integration/dist/github/config.esm.js:40-50`)
  **unconditionally appends a default `github.com` entry** when config lacks one.
  So `integrations.byUrl('https://github.com/…')` is **never** `undefined`,
  regardless of `app-config.yaml`.
- **An unconfigured host resolves to `undefined`.** For e.g.
  `https://git.example.com/o/r`, `byUrl()` returns `undefined` — but **today**
  `normalizeGithubUrl` / `parseGithubUrl` happily parse it GitHub-shaped and the
  request proceeds. Throwing on `undefined` would therefore be a **real
  behaviour change** (a previously-working self-hosted-GitHub-Enterprise URL that
  the host forgot to list under `integrations` would start failing).

Hence: `?? github`. This is the single most important zero-behaviour-change
detail in this phase. Keep the comment — it is load-bearing, not narration.

---

## `plugins/bruno-backend/src/scm/github.ts` (new file)

Bodies are **moved verbatim** from `collectionService.ts`. Do not "improve" them —
byte-equivalent logic is what makes this a zero-behaviour-change refactor.

```ts
import { Octokit } from '@octokit/rest';
import type { GithubCredentialsProvider, ScmIntegrationRegistry }
  from '@backstage/integration';
import type { ParsedRepoUrl, ScmProvider } from './types';

export function createGithubScmProvider(options: {
  integrations: ScmIntegrationRegistry;
  githubCredentials: GithubCredentialsProvider;
}): ScmProvider {
  const { integrations, githubCredentials } = options;

  function parseRepoUrl(url: string): ParsedRepoUrl {
    // verbatim from collectionService.ts:722-738
  }

  return {
    type: 'github',

    normalizeUrl(url) {
      // verbatim from collectionService.ts:203-213 (keeps `u.search = ''`)
    },

    parseRepoUrl,

    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      // verbatim from collectionService.ts:944-959; its internal
      // `parseGithubUrl(normalizedRepoUrl)` call (:950) becomes `parseRepoUrl(...)`
      // and it needs the local `joinPosix` helper — see note below.
    },

    repoRootFromUrl(url) {
      // verbatim from BrunoEntityProvider.ts:146-157
    },

    async resolveDefaultBranch(url, opts) {
      // from collectionService.ts:979-994 — the default-branch half ONLY.
      // Keep the `|| undefined` on the credential token (:984) and the
      // apiBaseUrl fallback; switch `integrations.github.byUrl(url)` (:991) to
      // the same expression (still valid — this adapter IS the github one).
      // The token is never logged.
    }
  };
}
```

### Two helper details that will otherwise bite

1. **`joinPosix`** (`collectionService.ts:1785`) is module-private and is used by
   `composeCollectionUrl` (`:951`). `scm/github.ts` needs it. **Do not import it
   from `collectionService`** — that creates the `scm/ → service/` edge this
   plan exists to prevent. It is a 1-line pure-string helper; **duplicate it as a
   module-private function in `scm/github.ts`.** (Duplication of a trivial pure
   helper is the correct trade against a cycle; the alternative — moving it to
   `../types` — puts runtime code in a types module.) Verify its exact body at
   `collectionService.ts:1785` and copy it.
2. **`ParsedGithubUrl`** (`collectionService.ts:714-719`) is replaced by
   `ParsedRepoUrl` in `scm/types.ts` with **identical members**
   (`owner`, `repo`, `ref?`, `subpath`). Delete the old type. The field names
   `owner`/`repo` are GitHub/Gitea-shaped and will not fit GitLab nested groups
   or Bitbucket `workspace`+`project` — **that is P5's problem, not P1's**;
   widening the shape now would be speculative and would change no behaviour.

---

## Complete call-site inventory

### A. Logic MOVED out of `collectionService.ts` (5 units)

| unit | current anchor | destination |
|---|---|---|
| `normalizeGithubUrl` | `collectionService.ts:197-213` (jsdoc `:197-202`, body `:203-213`) | `scm/github.ts` → `normalizeUrl` |
| `ParsedGithubUrl` type | `collectionService.ts:714-719` | `scm/types.ts` → `ParsedRepoUrl` |
| `parseGithubUrl` | `collectionService.ts:721-738` | `scm/github.ts` → `parseRepoUrl` |
| `composeCollectionUrl` | `collectionService.ts:938-959` (jsdoc `:938-943`, body `:944-959`) | `scm/github.ts` → `composeCollectionUrl` |
| `resolveRef`'s default-branch half | `collectionService.ts:979-994` | `scm/github.ts` → `resolveDefaultBranch` |
| `repoRootFromCollectionUrl` (backend copy) | `BrunoEntityProvider.ts:144-157` | `scm/github.ts` → `repoRootFromUrl` |

### B. `normalizeGithubUrl` — **4 sites** (1 decl + 3 calls), all in `collectionService.ts`

| file:line | current | after |
|---|---|---|
| `collectionService.ts:203` | `export function normalizeGithubUrl(url: string): string {` | **deleted** (moved) |
| `collectionService.ts:217` | `const normalized = normalizeGithubUrl(url);` (inside `collectionIdFromUrl`) | `providers.byUrl(url).normalizeUrl(url)` — **see C** |
| `collectionService.ts:310` | `const normalized = normalizeGithubUrl(input.url);` (`connectFromUrl`) | `providers.byUrl(input.url).normalizeUrl(input.url)` |
| `collectionService.ts:449` | `const normalized = normalizeGithubUrl(input.url);` (`discoverCollections`) | `providers.byUrl(input.url).normalizeUrl(input.url)` |

**No external importer.** Verified: `router.ts:12` imports only
`collectionIdFromUrl`; no other file imports `normalizeGithubUrl`. It is
module-`export`ed but **not** re-exported from `plugins/bruno-backend/src/index.ts`
(read in full: it exports `createCollectionService` at `:19`, not the helpers).

### C. `collectionIdFromUrl` — the one signature problem, and its resolution

`collectionIdFromUrl` (`:216-219`) is a **module-level `export function`** with
**no access to a registry** (the registry is created inside
`createCollectionService`). It has **2 call sites**:

| file:line | caller |
|---|---|
| `plugins/bruno-backend/src/service/router.ts:87` | `POST /collections/import` handler (imported at `router.ts:12`) |
| `plugins/bruno-backend/src/service/collectionService.ts:484` | `discoverCollections` |
| `plugins/bruno-backend/src/service/collectionService.ts:311` | `connectFromUrl` — **note: this one passes the ALREADY-normalized URL** |

Three options, and the choice matters:

- ✅ **Chosen — keep `collectionIdFromUrl(url)` module-level and provider-agnostic
  by having it hash the URL it is given, with normalization moved to the
  callers.** Today `:217` normalizes internally, and `:311` passes an
  already-normalized string — so `:311` normalizes **twice**, which is a no-op
  only because `normalizeGithubUrl` is idempotent. Making the function
  hash-only would change `router.ts:87`'s behaviour (it passes a **raw** body
  URL and relies on the internal normalize). **Rejected: behaviour change.**
- ✅✅ **Chosen instead — keep `collectionIdFromUrl` exactly as it is, and give it
  a module-level default provider for normalization.** Concretely: keep the
  signature `collectionIdFromUrl(url: string): string` and have it call a
  module-level `defaultScmProviders.byUrl(url).normalizeUrl(url)`, where
  `defaultScmProviders` is a lazily-created registry built from the **same**
  `ScmIntegrations` the service uses.

  **Problem:** a module-level registry needs `Config` to build `ScmIntegrations`,
  which a module-level function does not have. **Rejected: needs a global.**
- ✅✅✅ **ADOPTED — leave `collectionIdFromUrl` and its internal normalization
  call GitHub-agnostic by construction: move `normalizeUrl` dispatch into the
  registry, and give `collectionIdFromUrl` an optional second parameter.**

```ts
/** Derives the stable cache key / collection id from a collection URL. */
export function collectionIdFromUrl(
  url: string,
  provider?: Pick<ScmProvider, 'normalizeUrl'>
): string {
  const normalized = provider ? provider.normalizeUrl(url) : normalizeUrlFallback(url);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
```

  …where `normalizeUrlFallback` is the **GitHub normalization moved into
  `scm/github.ts` and re-exported as a pure function** (`githubNormalizeUrl`),
  imported directly by `collectionService.ts`. This keeps `router.ts:87`
  byte-identical in behaviour (it calls the 1-arg form → GitHub normalization,
  exactly as today), lets `:484` pass the resolved provider, and adds **no
  global**.

  **`router.ts` therefore needs NO edit in this phase** — its call at `:87`
  still type-checks and behaves identically. That preserves this phase's
  "backend-only, no route touched" property.

> **Implementer note:** this is the one place where a genuinely provider-neutral
> design is blocked by `collectionIdFromUrl` being module-level rather than a
> service method. **Do not restructure it here** — B2/P4 replaces this function
> with a versioned, provider-scoped id (`v2:<provider>:<hash>`) and a migration,
> at which point it becomes a service method naturally. Adding the optional
> parameter is the minimal seam-compatible change.

### D. `parseGithubUrl` — **4 sites** (1 decl + 3 calls), all in `collectionService.ts`

| file:line | context | after |
|---|---|---|
| `collectionService.ts:722` | declaration | **deleted** (moved to `scm/github.ts`) |
| `collectionService.ts:751` | `readUrlTreeViaOctokit` — `const { owner, repo, ref: parsedRef, subpath } = parseGithubUrl(url);` | `= provider.parseRepoUrl(url);` — **`readUrlTreeViaOctokit` gains a `provider: ScmProvider` parameter** |
| `collectionService.ts:950` | inside `composeCollectionUrl` | **moves with it** into `scm/github.ts`; becomes the adapter's own `parseRepoUrl` |
| `collectionService.ts:975` | inside `resolveRef` | stays in `collectionService.ts`'s thinned `resolveRef`; becomes `provider.parseRepoUrl(url)` |

### E. `integrations.github.byUrl(...)` — **2 sites**

| file:line | context | after |
|---|---|---|
| `collectionService.ts:753` | `readUrlTreeViaOctokit`'s `apiBaseUrl` | **stays** (P2 scope). Still GitHub-specific and still correct — it is only reached via the GitHub Octokit path. |
| `collectionService.ts:991` | `resolveRef`'s `apiBaseUrl` | **moves** into `scm/github.ts`'s `resolveDefaultBranch`, unchanged. |

> The brief asks to dispatch on `integrations.byUrl(url)?.type` **rather than
> hostname matching**. Both remaining/moved uses of `integrations.github.byUrl`
> are **not** hostname matching — they are a typed accessor for `apiBaseUrl`
> inside code that is already GitHub-only by construction. They are correct and
> stay. The *dispatch* is `integrations.byUrl(url)?.type` in
> `scm/index.ts`. There is **no** hostname string matching in the backend today
> (verified: the `hostname.includes('github')` check B1 mentions lives in the
> **frontend** `useCollectionPicker.ts` — **P3**).

### F. Signature changes — complete list

| function | file | before | after | call sites to update |
|---|---|---|---|---|
| `resolveRef` | `collectionService.ts:969` | `(integrations, credentials, url, userToken?)` | `(provider: ScmProvider, url: string, userToken?: string)` | **1** — `collectionService.ts:461` |
| `readUrlTreeViaOctokit` | `collectionService.ts:745` | `(integrations, url, userToken, logger)` | `(integrations, provider, url, userToken, logger)` | **1** — `collectionService.ts:703` (inside `readUrlTreeWithCreds`) |
| `readUrlTreeWithCreds` | `collectionService.ts:691` | `(reader, integrations, url, logger, opts?)` | `(reader, integrations, provider, url, logger, opts?)` | **2** — `collectionService.ts:312` (`connectFromUrl`), `:454` (`discoverCollections`) |
| `collectionIdFromUrl` | `collectionService.ts:216` | `(url)` | `(url, provider?)` — **backward compatible** | **0 forced.** Optionally pass the provider at `:484`. `router.ts:87` unchanged. |
| `composeCollectionUrl` | `collectionService.ts:944` | free function | adapter method | **1** — `collectionService.ts:479` → `provider.composeCollectionUrl(...)` |

**Total call sites to update for signature changes: 5** (`:461`, `:703`, `:312`,
`:454`, `:479`), plus the 3 `normalizeUrl` sites (`:217` via the fallback,
`:310`, `:449`), plus `:751`. **Enumerated above; none omitted.**

### G. `BrunoEntityProvider.ts` — **3 edits**

| file:line | current | after |
|---|---|---|
| `BrunoEntityProvider.ts:144-157` | `function repoRootFromCollectionUrl(url)` + its jsdoc (incl. the stale `plugins/bruno/src/lib/githubUrl.ts` reference at `:145`) | **deleted** — moved to `scm/github.ts` as `repoRootFromUrl` |
| `BrunoEntityProvider.ts:138-142` | `brunoDeepLink(sourceUrl)` calls the local `repoRootFromCollectionUrl(sourceUrl)` (`:140`) | calls `providers.byUrl(sourceUrl).repoRootFromUrl(sourceUrl)`; `brunoDeepLink` takes the registry (or the resolved provider) as a parameter |
| `BrunoEntityProvider.ts:1-14` (imports) | — | add `import { createScmProviderRegistry } from '../scm';` (value) and `import type { ScmProviderRegistry } from '../scm';` if the registry is threaded as a field |

**Construction:** `BrunoEntityProvider`'s constructor already receives `config`
(`:31`). Build the registry there — `ScmIntegrations.fromConfig(config)` plus
`DefaultGithubCredentialsProvider.fromIntegrations(...)`, mirroring
`collectionService.ts:240-245` — or, simpler and preferred, **only the
`repoRootFromUrl` capability is needed here** and it requires no credentials, so
constructing the registry with the same two lines is cheap and keeps one code
path. Do **not** pass the registry down from `createCollectionService` — that
would mean exporting it from the service and is an unnecessary new coupling.

**Keep `brunoDeepLink`'s output byte-identical** — it feeds an `EntityLink.url`
at `:100`, and `repoRootFromUrl`'s body is being moved verbatim.

**Note the pre-existing 3-way duplication** this phase reduces to 2:
`BrunoEntityProvider.ts:146` (backend — **removed here**),
`plugins/bruno/src/lib/githubUrl.ts:3` (frontend — **stays, P3**), and the
comments at `BrunoEntityProvider.ts:135-137` / `:145` that document the mirroring.
Update the `:135-137` comment only if it still refers to the deleted function.

### H. `createCollectionService` — registry construction

`collectionService.ts:240-245` already builds both dependencies:

```ts
const integrations = ScmIntegrations.fromConfig(config);        // :240
const githubCredentials
  = DefaultGithubCredentialsProvider.fromIntegrations(integrations);  // :244-245
```

Add immediately after (`~:246`):

```ts
const providers = createScmProviderRegistry({ integrations, githubCredentials });
```

Keep `integrations` and `githubCredentials` in scope — `integrations` is still
used by `readUrlTreeWithCreds` (`:314`, `:456`) and `readUrlTreeViaOctokit`
(`:753`). `githubCredentials` becomes used **only** by the registry after
`resolveRef` is thinned; confirm it has no other reference before deciding
whether to inline it (`grep -n githubCredentials`) — if the registry is its only
consumer, inline it into the `createScmProviderRegistry` call and delete `:244-245`
plus its `:241-243` comment, moving that comment to `scm/github.ts` where it now
belongs.

### I. Thinned `resolveRef` (stays in `collectionService.ts`)

```ts
/**
 * Resolves the git ref for a URL: the explicit ref carried by the URL if
 * present, otherwise the repo's default branch via the provider adapter.
 * The token is never logged.
 */
async function resolveRef(
  provider: ScmProvider,
  url: string,
  userToken?: string
): Promise<string> {
  const { ref } = provider.parseRepoUrl(url);
  if (ref) {
    return ref;
  }
  return provider.resolveDefaultBranch(url, { userToken });
}
```

Preserves the early-return at `:976-978` exactly, so a URL with an explicit
`/tree/<ref>` still makes **zero** API calls.

---

## Type / re-export surface that changes

**Read both `index.ts` files in full — neither needs an edit, and that is
deliberate.**

- **`plugins/bruno-backend/src/index.ts`** (`:1-46`) exports `brunoPlugin`,
  `brunoCatalogModule`, `BrunoEntityProvider`, `createCollectionService`,
  `createRouter`, `generateOcDocsHtml`, and 21 types from `./types`.
  **None of the moved symbols is re-exported**, so:
  - deleting `normalizeGithubUrl`, `parseGithubUrl`, `ParsedGithubUrl`,
    `composeCollectionUrl` breaks **no published API**;
  - `ScmProvider` / `ParsedRepoUrl` are **internal to the plugin** in this phase.
    **Do NOT add them to `index.ts`.** Publishing an interface before it has a
    second implementation locks a shape P5 will need to widen (`owner`/`repo` →
    workspace/project). Export it when P5 proves the shape.
- **`plugins/bruno/src/index.ts`** — untouched (no frontend change in P1).
- **`collectionIdFromUrl`** keeps its `export` and gains an **optional**
  parameter, so it stays source-compatible for `router.ts:12`/`:87`.

**Net published-API delta for P1: none.**

---

## Route auth modes — untouched, and verified

**This phase edits no route handler.** `router.ts` requires **no change** (see C).
The auth modes below are recorded so the implementer can confirm nothing drifted;
if a `router.ts` edit becomes necessary, **preserve these byte-identically.**

| route | line | auth |
|---|---|---|
| `GET /health` | 64 | *(none — barrier `unauthenticated`, `plugin.ts:77-79`)* |
| `GET /collections` | 69 | `allow: ['user']` |
| `POST /collections/import` | 74 | `allow: ['user']` |
| `GET /collections/imported` | 103 | `allow: ['user', 'service']` |
| `DELETE /collections/imported/:id` | 117 | `allow: ['user']` |
| `GET /collections/:id` | 128 | `allow: ['user']` |
| `GET /collections/:id/docs` | 143 | **no in-handler call** — `user-cookie` policy (`plugin.ts:89-91`). Do not add one. |
| `GET /collections/:id/opencollection.yml` | 170 | `allow: ['user']` |
| `POST /collections/:id/sync` | 180 | `allow: ['user']` |
| `GET /dashboard` | 204 | `allow: ['user', 'service']` |
| `POST /connections` | 211 | `allow: ['user']` |
| `POST /connections/discover` | 239 | `allow: ['user']` |
| `GET /connections` | 255 | `allow: ['user', 'service']` |
| `GET /connections/:entityRef` | 269 | `allow: ['user']` |
| `DELETE /connections/:entityRef` | 287 | `allow: ['user']` |
| `POST /refresh` | 298 | **no credentials call** (POC/demo) — leave as-is |

---

## Ordered execution checklist

1. **Create `plugins/bruno-backend/src/scm/types.ts`** — `ParsedRepoUrl`,
   `ScmProvider` exactly as specified above. Types only; **no runtime imports**.
2. **Create `plugins/bruno-backend/src/scm/github.ts`** —
   `createGithubScmProvider`. Move the six bodies **verbatim** from their anchors
   (§A). Duplicate `joinPosix` from `collectionService.ts:1785` as a
   module-private helper. Also export a standalone
   `githubNormalizeUrl(url: string): string` (the same body) for
   `collectionIdFromUrl`'s fallback (§C).
3. **Create `plugins/bruno-backend/src/scm/index.ts`** —
   `createScmProviderRegistry` + `ScmProviderRegistry`, re-exporting the two
   types. **Include the `?? github` fallback and its comment.**
4. **`yarn tsc`** → expect 0 errors (nothing imports `scm/` yet). This isolates
   any error in the new files from the refactor that follows.
5. **`collectionService.ts` — delete the moved code:** `normalizeGithubUrl`
   (`:197-213`, jsdoc included), `ParsedGithubUrl` (`:714-719`), `parseGithubUrl`
   (`:721-738`), `composeCollectionUrl` (`:938-959`).
6. **`collectionService.ts` — add imports:**
   `import { createScmProviderRegistry } from '../scm';` and
   `import { githubNormalizeUrl } from '../scm/github';` (value imports), plus
   `import type { ScmProvider } from '../scm';`. Use **`import type`** for the
   type-only one.
7. **`collectionService.ts` — construct the registry** at `~:246`, after
   `:244-245` (§H).
8. **`collectionService.ts` — rewrite `collectionIdFromUrl`** (`:216-219`) to the
   optional-parameter form in §C, using `githubNormalizeUrl` as the fallback.
9. **`collectionService.ts` — thin `resolveRef`** to §I (was `:961-995`,
   jsdoc included; keep a jsdoc, drop the GitHub-specific sentences that moved).
10. **`collectionService.ts` — thread the provider through the fetch path:**
    `readUrlTreeWithCreds` (`:691`) and `readUrlTreeViaOctokit` (`:745`) gain a
    `provider` parameter; `:751` becomes `provider.parseRepoUrl(url)`; the
    internal call at `:703` passes it through. **Leave `:753` and the entire
    Octokit body otherwise untouched.**
11. **`collectionService.ts` — update the 5 call sites** (§F): `:310`, `:312`,
    `:449`, `:454`, `:461`, `:479`. In `connectFromUrl` and
    `discoverCollections`, resolve the provider **once** at the top
    (`const provider = providers.byUrl(input.url);`) and reuse it — do not call
    `byUrl` repeatedly.
12. **`BrunoEntityProvider.ts`** — the 3 edits in §G: delete `:144-157`, rewire
    `brunoDeepLink` (`:138-142`), add the import + registry construction.
13. **Gate: `yarn tsc`** → must be **0 errors**.
14. **Gate: `yarn lint:bruno plugins/bruno plugins/bruno-backend`** → must be
    **exactly 6 problems (1 error, 5 warnings)**, the same ones listed in
    "Gate baseline". **Never run `lint:bruno:fix`.**
15. **Cycle check:**
    `grep -rn "from '\.\./service\|from '\.\./store\|from '\.\./provider\|from '\.\./processor" plugins/bruno-backend/src/scm/`
    → must be **0 lines**.
16. **Live functional check** (this *is* the verification — no tests exist).
    `yarn start`, then confirm **byte-identical** behaviour to a pre-P1 build:
    - (a) **Discover** on a repo URL **without** `/tree/<ref>` → the returned
      `sourceUrl`s carry the resolved default branch and the **same
      `collectionId`s as before P1**. This is the critical check: it exercises
      `resolveDefaultBranch` → `composeCollectionUrl` → `collectionIdFromUrl`.
      Record the ids from a pre-P1 run and diff them.
    - (b) **Discover** on a URL **with** an explicit `/tree/<ref>/<subpath>` →
      same ids as before, and **no** default-branch API call (the early return).
    - (c) **Connect** → **sync** → **disconnect** a collection.
    - (d) A **private** repo via the Octokit fallback with a user token —
      confirm it still succeeds and that the token appears **nowhere** in logs.
    - (e) A catalog entity from a `type: url` Bruno source → its **"Open in
      Bruno"** `EntityLink` URL is **unchanged** (exercises `repoRootFromUrl`).
    - (f) Restart and confirm `POST /collections/import` still accepts a raw
      body URL (`router.ts:87`, the `collectionIdFromUrl` 1-arg path).
    **Never paste a token into the transcript.**

---

## Acceptance criteria (mechanically checkable)

1. `yarn tsc` → **0 errors**.
2. `yarn lint:bruno plugins/bruno plugins/bruno-backend` → **exactly 6 problems
   (1 error, 5 warnings)**: `router.ts:258` arrow-parens +
   `usebruno-converters.d.ts:10:53,10:59` + `usebruno-lang.d.ts:12:47,14:50,16:55`.
   No new problem of any kind. **No `any` in `src/scm/`.**
3. `grep -rn 'normalizeGithubUrl\|parseGithubUrl\|ParsedGithubUrl' plugins/bruno-backend/src/`
   → **0 lines**.
4. `grep -c 'github\|Github\|GitHub' plugins/bruno-backend/src/service/collectionService.ts`
   → reduced from **37** (measured at `ef10756`, case-insensitive) to a residue
   attributable **only** to: the `Octokit` import (`:10`),
   `readUrlTreeViaOctokit` and its comments, `DefaultGithubCredentialsProvider`,
   `integrations.github.byUrl` (`:753`), `githubNormalizeUrl`, and the RISK-#1
   comment block (`~:650-658`). **Every remaining hit must fall in that list** —
   and every one of them is explicitly **P2** scope. *(This is the honest form of
   MULTI-SCM-PLAN.md's "drops to the adapter file only" — see Corrections item 3.)*
5. `plugins/bruno-backend/src/scm/` contains **exactly 3 files**: `types.ts`,
   `github.ts`, `index.ts`.
6. **No cycle:**
   `grep -rn "from '\.\./service\|from '\.\./store\|from '\.\./provider\|from '\.\./processor" plugins/bruno-backend/src/scm/`
   → **0 lines**.
7. `grep -n 'integrations.byUrl' plugins/bruno-backend/src/scm/index.ts` →
   **exactly 1** line; and
   `grep -rn 'hostname\|includes(.github' plugins/bruno-backend/src/scm/` →
   **0 lines** (dispatch is by integration type, never by hostname).
8. `git diff --stat` shows **only**: 3 new files under
   `plugins/bruno-backend/src/scm/`, `collectionService.ts`, and
   `BrunoEntityProvider.ts`. **`router.ts` is unmodified.**
   **No file under `plugins/bruno/` is modified. No file under `packages/` is
   modified.**
9. `git diff -- plugins/bruno-backend/src/service/router.ts` → **empty**;
   `git diff -- plugins/bruno-backend/src/plugin.ts` → **empty** (no auth mode
   touched).
10. `git diff -- plugins/bruno-backend/src/index.ts` → **empty**
    (`ScmProvider` is **not** published in this phase).
11. `grep -n 'Octokit' plugins/bruno-backend/src/service/collectionService.ts`
    → still present; `grep -n '@octokit/rest' plugins/bruno-backend/package.json`
    → still present (P2 removes it, not P1).
12. Live check 16(a)-(f) all pass, and **16(a)/16(b) produce collection ids
    identical to a pre-P1 run**.

---

## Corrections to MULTI-SCM-PLAN.md

1. **§1.4 is factually WRONG and it changes P2's design.** It states
   "`UrlReaderServiceReadTreeOptions` has **no credential field** — only
   `filter`, `etag`, `signal`" and builds the whole `UrlReaders.default({config:
   synthesized})` workaround (and `credentialConfigFor`, and the B4 table) on
   that premise. **There IS a `token?: string` field** on
   `UrlReaderServiceReadTreeOptions`
   (`node_modules/@backstage/backend-plugin-api/dist/index.d.ts`, documented
   *"An optional token to use for authentication when reading the resources…
   maybe that's supplied by the user at runtime"*), and readers **honour it** —
   e.g. `GitlabUrlReader.readTree` destructures
   `const { etag, signal, token } = options ?? {};`
   (`@backstage/backend-defaults/dist/entrypoints/urlReader/lib/GitlabUrlReader.cjs.js:73`).
   **Consequence:** P2 can very likely be a one-line
   `reader.readTree(url, { token: userToken })` pass-through instead of
   synthesizing a config and constructing a per-request reader — which also
   dissolves most of B4 (the per-provider credential-field table) and is why this
   plan **does not** add `credentialConfigFor` to the interface.
   **This should be re-verified by the P2 spike before P2 is planned.**
2. **§MSCM-P1's function list omits `normalizeGithubUrl`'s central role.** It
   lists it, but §3's interface sketch has no `normalizeUrl` method — so
   following §3 literally would leave the one function whose behaviour B1 says
   must change (`u.search = ''` destroying Bitbucket Server / Azure refs) outside
   the seam. This plan adds `normalizeUrl`.
3. **§MSCM-P1's acceptance criterion is not achievable as written.**
   "`grep -c github` in `collectionService.ts` drops to the adapter file only" is
   impossible in P1 because the Octokit fallback, `DefaultGithubCredentialsProvider`,
   and the `integrations.github.byUrl` at `:753` are explicitly **P2** scope and
   must keep working identically. Acceptance criterion 4 above is the honest,
   checkable form.
4. **§MSCM-P1 says "all existing tests pass".** There are **no tests in this
   project** and none are to be added. Verification is the two gates plus the
   live check in step 16.
5. **§3's `credentialConfigFor` belongs to P2, not P1** — it has no P1 caller,
   and per item 1 it may not be needed in that shape at all.
6. **§B5 previously implied the default-branch lookup was a fetch precondition
   that P2 could remove.** It is an **identity** input: `resolveRef` (`:461`) runs
   *after* the tree fetch and feeds only `composeCollectionUrl` (`:479`), whose
   output becomes the stored `sourceUrl` **and** the collection id (`:484`).
   `readTree` resolving a branch internally does not help, because it never
   returns the ref it used. *(The coordinator has since corrected B5 in the main
   plan; recorded here because this plan's interface depends on it.)*
7. **§B1's frontend claims are correct but are P3, not P1.**
   `hostname.includes('github')` / the `/blob/` rejection live in
   `plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts` — there
   is **no** hostname matching anywhere in `bruno-backend` today.
8. **§B6's root-detection anchor is stale.** It cites
   `collectionService.ts:821`. The heuristic is `commonRootPrefix`, **declared at
   `:1009`** and called at **`:827`** (bru path) and **`:1374`** (yml path), and
   only as a *fallback* when `findBrunoJson` returns `undefined`. Untouched by
   P1; relevant to P2/P5.

---

## Risks / open questions

1. **Default-branch resolution makes collection ids unstable — flagged, NOT
   solved here.** Because `resolveDefaultBranch`'s result is baked into the
   composed URL (`:479`) which is hashed into the id (`:484`), a repo whose
   default branch is renamed (`master` → `main`) yields a **different composed
   URL and therefore a different collection id** for the same collection. That
   silently orphans its `bruno_connections` / `bruno_collections` rows, all three
   `bruno.dev/*` annotations, and any bookmarked docs URL. This is **pre-existing
   behaviour**, unchanged by P1 — and P1 must **not** try to fix it, because
   doing so *is* a behaviour change. It is squarely **B2 / MSCM-P4** (versioned,
   provider-scoped ids + migration). **Do not let an implementer "improve" this
   in P1.**
2. **Zero-behaviour-change is not machine-verifiable here.** There are no tests,
   so nothing mechanically proves the moved bodies are equivalent. The real
   detector is acceptance check 12 — **collection ids identical before and
   after** — which transitively validates `normalizeUrl`, `parseRepoUrl`,
   `resolveDefaultBranch`, and `composeCollectionUrl` in one comparison.
   **The implementer must capture the pre-P1 ids before starting.** If they skip
   that, this phase has effectively no verification.
3. **The `?? github` dispatch fallback is load-bearing and easy to "clean up".** A
   reviewer who reads it as sloppy and replaces it with a thrown error will break
   unconfigured self-hosted GHE hosts — a change that passes both gates and the
   happy-path live check, and only fails for hosts nobody tests. The comment must
   survive review.
4. **`collectionIdFromUrl`'s optional parameter is a compromise, and it can rot.**
   Callers that forget to pass a provider silently get GitHub normalization. With
   one provider that is always correct; with GitLab (P5) it becomes a latent
   wrong-id bug at `router.ts:87`. **P4/P5 must make it a service method.**
   Flagging so it is not mistaken for a finished design.
5. **Unverified: the exact behaviour of `resolveDefaultBranch` when the host has
   no credential AND no user token.** Today `resolveRef` swallows the credential
   error (`:985-988`), sets `auth = undefined`, and lets Octokit 404/403. I moved
   this verbatim, so behaviour is preserved by construction — but **I did not
   exercise it live** against a private repo with no credentials. Live check
   16(d) covers the *with*-token path only.
6. **`joinPosix` duplication.** A trivial pure helper now exists twice
   (`collectionService.ts:1785` and `scm/github.ts`). Deliberate — the
   alternative is a cycle or runtime code in a types module. If a third copy is
   ever needed, that is the signal to add a `src/lib/` leaf module (and P5, which
   adds three adapters, is the likely trigger).
7. **Open question for P5, not P1:** `ParsedRepoUrl`'s `owner`/`repo` shape
   cannot express GitLab nested groups or Bitbucket `workspace`+`project`. Kept
   GitHub-shaped here **on purpose** (widening it now would be speculative and
   change nothing). P5 must widen it — which is precisely why `ScmProvider` is
   **not** exported from `src/index.ts` in this phase.
8. **Open question:** should the registry be a `coreServices`-style backend
   service rather than constructed twice (once in `createCollectionService`, once
   in `BrunoEntityProvider`)? Constructing it twice is cheap (`ScmIntegrations.fromConfig`
   is pure config parsing) and avoids new DI wiring in `plugin.ts`/`module.ts`.
   Revisit only if a third construction site appears.
