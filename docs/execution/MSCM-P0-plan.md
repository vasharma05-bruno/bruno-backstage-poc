# MSCM-P0 — Provider-neutral naming + widened config · **LOCKED**

**Scope:** Rename `githubUrl` → `sourceUrl`, the wire header `x-bruno-github-token` →
`x-bruno-scm-token`, and the DB columns `github_url` → `source_url`; widen the
`config.d.ts` wording. Pure rename + doc-wording. Implements MULTI-SCM-PLAN.md
phase MSCM-P0 (addresses B8, B9; decision D4 = straight rename, no alias).

**Baseline:** branch `feat/multi-scm` at `ef10756`, working tree clean of plugin
changes. All line numbers below were verified against disk at `ef10756`.

---

## NON-goals

- **No behaviour change.** No route added/removed, no auth mode changed, no
  request/response *shape* changed (field *names* only), no caching change.
- **No new abstraction.** No `ScmProvider`, no adapter, no registry — that is P1.
- **No dispatch change.** `integrations.github.byUrl(...)` stays GitHub-specific
  in this phase (P1 moves it to `integrations.byUrl(url)?.type`).
- **No renaming of the GitHub-shaped *functions*.** `normalizeGithubUrl`,
  `collectionIdFromUrl`, `parseGithubUrl`, `resolveRef` keep their names — P1
  moves them behind the seam and renames them there. Renaming them here would
  double the diff for no contract benefit (they are not published: see
  §"Export surface" — only `collectionIdFromUrl`/`normalizeGithubUrl` are
  module-exported and neither is re-exported from `src/index.ts`).
- **No renaming of `plugins/bruno/src/lib/githubUrl.ts`** (the *file*). Its
  `repoRootFromCollectionUrl` is provider-coupled *logic*, which is P1/P3 work,
  not a naming change. See "Deferred to P1" below.
- **No catalog annotation KEY changes.** `bruno.dev/source-url`,
  `bruno.dev/collection-path`, `bruno.dev/collection-id` are already
  provider-neutral and stay byte-identical.
- **No `.env` staging. No token logging.** Unchanged from baseline.

---

## Standing project constraints (apply to this phase)

- Yarn 4. Authoritative gates: **`yarn tsc`** (repo-level, must be **0 errors**)
  and **`yarn lint:bruno plugins/bruno plugins/bruno-backend`**.
  `backstage-cli build` is **not** a gate — it transpiles without full
  type-checking.
- **No app tests exist in this project and none are to be added.** Verification =
  the two gates + a live boot / functional check.
- Feature work stays in `plugins/bruno` and `plugins/bruno-backend`.
  `packages/app` / `packages/backend` are untouched by this phase.
- Never log or return a user OAuth token from any code path.
- `import type` for type-only imports. Minimal diff, match surrounding style,
  no narration comments, no dead code.
- MUI v4 on the frontend; new-backend-system APIs on the backend.

### Gate baseline you must preserve exactly

- `yarn tsc` → **0 errors**.
- `yarn lint:bruno` → **exactly one error**: `router.ts:258` `arrow-parens`
  (`rows.map(row => ({`), which belongs to the carried docs-auth work and is
  **deliberately left alone**; plus **five pre-existing `no-explicit-any`
  warnings** in `plugins/bruno-backend/src/types/*.d.ts`.
- **Do NOT "fix" those, and do NOT introduce new ones.** In particular: **do not
  run `yarn lint:bruno:fix`** — it would silently absorb `router.ts:258` into
  this phase's diff. Note that `router.ts:258` sits two lines above an edit site
  (`router.ts:261`); edit 261 and leave 258 exactly as-is.

---

## Call-site inventory — `githubUrl` → `sourceUrl`

**42 occurrences across 15 files.** Independently re-counted from disk at
`ef10756` with `grep -rn 'githubUrl' plugins packages | grep -v node_modules`.
This total and every per-file count is **confirmed** (it matches the
coordinator's independent measurement exactly). Note MULTI-SCM-PLAN.md §B8 cites
only `api/types.ts:144,156,182` and `backend/types.ts:147,176` — those five
anchors are **correct but drastically incomplete** (5 of 42); see "Corrections to
MULTI-SCM-PLAN.md".

Three of the 42 are references to the *module path* `lib/githubUrl`, not the
field; they are **out of scope** here (marked ⊘).

### Backend — `plugins/bruno-backend` (26)

| # | file:line | current | change |
|---|---|---|---|
| 1 | `src/types.ts:146` | jsdoc `Fully-qualified GitHub URL to pass verbatim…` | `Fully-qualified source URL to pass verbatim…` |
| 2 | `src/types.ts:147` | `githubUrl: string;` (`DiscoveredCollection`) | `sourceUrl: string;` |
| 3 | `src/types.ts:176` | `githubUrl: string;` (`ImportedCollection`) | `sourceUrl: string;` |
| 4 | `src/processor/BrunoLinkProcessor.ts:20` | `githubUrl: string;` (`BrunoLink`) | `sourceUrl: string;` |
| 5 | `src/processor/BrunoLinkProcessor.ts:77` | `'bruno.dev/collection-path': link.githubUrl,` | `…: link.sourceUrl,` — **key unchanged** |
| 6 | `src/processor/BrunoLinkProcessor.ts:78` | `'bruno.dev/source-url': link.githubUrl,` | `…: link.sourceUrl,` — **key unchanged** |
| 7 | `src/service/router.ts:82` | `if (!c?.githubUrl \|\| !c?.name) {` | `if (!c?.sourceUrl \|\| !c?.name) {` |
| 8 | `src/service/router.ts:83` | `'Each collection needs \`githubUrl\` and \`name\`.'` | `` `sourceUrl` `` |
| 9 | `src/service/router.ts:87` | `collectionIdFromUrl(c.githubUrl)` | `collectionIdFromUrl(c.sourceUrl)` |
| 10 | `src/service/router.ts:89` | `` `Invalid githubUrl: ${c.githubUrl}` `` | `` `Invalid sourceUrl: ${c.sourceUrl}` `` |
| 11 | `src/service/router.ts:93` | `githubUrl: c.githubUrl,` | `sourceUrl: c.sourceUrl,` |
| 12 | `src/service/router.ts:109` | `githubUrl: row.githubUrl,` | `sourceUrl: row.sourceUrl,` |
| 13 | `src/service/router.ts:188` | `row?.githubUrl ?? …getCollection(id)?.sourceUrl` | `row?.sourceUrl ?? …?.sourceUrl` |
| 14 | `src/service/router.ts:226` | `githubUrl: detail.sourceUrl!,` | `sourceUrl: detail.sourceUrl!,` |
| 15 | `src/service/router.ts:261` | `githubUrl: row.githubUrl,` | `sourceUrl: row.sourceUrl,` |
| 16 | `src/service/router.ts:280` | `githubUrl: row.githubUrl,` | `sourceUrl: row.sourceUrl,` |
| 17 | `src/service/collectionService.ts:395` | `connectFromUrl({ url: link.githubUrl })` | `{ url: link.sourceUrl }` |
| 18 | `src/service/collectionService.ts:479` | `const githubUrl = composeCollectionUrl(…)` | `const sourceUrl = composeCollectionUrl(…)` |
| 19 | `src/service/collectionService.ts:484` | `collectionId: collectionIdFromUrl(githubUrl),` | `…(sourceUrl),` |
| 20 | `src/service/collectionService.ts:485` | `githubUrl` (shorthand) | `sourceUrl` |
| 21 | `src/store/connectionStore.ts:5` | `githubUrl: string;` (`BrunoConnectionRow`) | `sourceUrl: string;` |
| 22 | `src/store/connectionStore.ts:29` | `githubUrl: row.github_url,` | `sourceUrl: row.source_url,` |
| 23 | `src/store/connectionStore.ts:64` | `github_url: row.githubUrl,` | `source_url: row.sourceUrl,` |
| 24 | `src/store/collectionsStore.ts:5` | `githubUrl: string;` (`ImportedCollectionRow`) | `sourceUrl: string;` |
| 25 | `src/store/collectionsStore.ts:28` | `githubUrl: row.github_url,` | `sourceUrl: row.source_url,` |
| 26 | `src/store/collectionsStore.ts:63` | `github_url: row.githubUrl,` | `source_url: row.sourceUrl,` |
| ⊘ | `src/provider/BrunoEntityProvider.ts:145` | comment: `Mirrors repoRootFromCollectionUrl in plugins/bruno/src/lib/githubUrl.ts` | **leave** — module-path reference, P1 |

> Rows 22/23/25/26 each carry **both** a camelCase field and a snake_case column
> on one line; they are counted once here and once in the column inventory.

### Frontend — `plugins/bruno` (16)

| # | file:line | current | change |
|---|---|---|---|
| 27 | `src/api/types.ts:144` | `githubUrl: string;` (`DiscoveredCollection`) | `sourceUrl: string;` |
| 28 | `src/api/types.ts:156` | `githubUrl: string;` (`ConnectionRecord`) | `sourceUrl: string;` |
| 29 | `src/api/types.ts:182` | `githubUrl: string;` (`ImportedCollection`) | `sourceUrl: string;` |
| 30 | `src/api/BrunoApi.ts:44` | `Array<{ githubUrl: string; name: string }>` | `Array<{ sourceUrl: string; name: string }>` |
| 31 | `src/api/BrunoClient.ts:166` | `Array<{ githubUrl: string; name: string }>` | `Array<{ sourceUrl: string; name: string }>` |
| 32 | `src/components/CollectionPicker/useCollectionPicker.ts:111` | `brunoApi.connect(entityRef, chosen.githubUrl, token)` | `chosen.sourceUrl` |
| 33 | `…/useCollectionPicker.ts:260` | `brunoApi.connect(entityRef, chosen.githubUrl, token)` | `chosen.sourceUrl` |
| 34 | `…/useCollectionPicker.ts:321` | `chosen.githubUrl,` | `chosen.sourceUrl,` |
| 35 | `…/BrunoPage/AddCollectionModal/AddCollectionModal.tsx:187` | `githubUrl: c.githubUrl,` | `sourceUrl: c.sourceUrl,` |
| 36 | `…/BrunoPage/LinkApi/LinkPanel.tsx:100` | comment `…already carries the fully-qualified githubUrl.` | `…fully-qualified sourceUrl.` |
| 37 | `…/LinkPanel.tsx:118` | `brunoApi.connect(selectedRef, chosen.githubUrl, token)` | `chosen.sourceUrl` |
| 38 | `…/LinkPanel.tsx:224` | `{c.githubUrl}` (JSX) | `{c.sourceUrl}` |
| 39 | `…/BrunoCard/BrunoCard.tsx:74` | `sourceUrl: rec?.githubUrl` | `sourceUrl: rec?.sourceUrl` |
| 40 | `…/BrunoCard/BrunoCard.tsx:126` | `sourceUrl: record.githubUrl` | `sourceUrl: record.sourceUrl` |
| ⊘ | `…/BrunoCard/BrunoCard.tsx:16` | `import { repoRootFromCollectionUrl } from '../../lib/githubUrl';` | **leave** — module path, P1/P3 |
| ⊘ | `src/lib/brunoLink.ts:1` | `import { repoRootFromCollectionUrl } from './githubUrl';` | **leave** — module path, P1/P3 |

**Field/identifier edits: 39. Module-path references left alone: 3. Total 42.** ✅

### ⚠ Non-collision check (verified)

`sourceUrl` **already exists** in both type modules, and it does **not** collide:

- `plugins/bruno/src/api/types.ts:118` (`CollectionSummary.sourceUrl?`) and
  `:126` (`CollectionDetail.sourceUrl?`) — *optional*.
- `plugins/bruno-backend/src/types.ts:131` (`CollectionSummary.sourceUrl?`);
  `CollectionDetail extends CollectionSummary` (`:135`) inherits it.

The renamed field lands on `DiscoveredCollection`, `ConnectionRecord`,
`ImportedCollection`, `BrunoLink`, `BrunoConnectionRow`, `ImportedCollectionRow`
— **six disjoint interfaces**. No interface gains a duplicate member. The
semantics converge correctly (both mean "the URL this collection came from"); the
only asymmetry is optional-on-Summary/Detail vs required-on-the-six, which is
pre-existing and intentional.

`router.ts:188` and `:226` already mix both names on one line
(`row?.githubUrl ?? …?.sourceUrl`, `githubUrl: detail.sourceUrl!`). After the
rename these read `row?.sourceUrl ?? …?.sourceUrl` and
`sourceUrl: detail.sourceUrl!` — **correct, not a self-assignment bug**: the LHS
is the store row's field and the RHS is the cached detail's. Do not "simplify"
them.

---

## Call-site inventory — header `x-bruno-github-token` → `x-bruno-scm-token`

**Both sides must change in the same commit** — the header is a private wire
contract between `BrunoClient` and `router.ts` with no version negotiation.

| file:line | current | change |
|---|---|---|
| `plugins/bruno/src/api/BrunoClient.ts:14-17` | jsdoc `Header carrying the caller's GitHub OAuth token…` | `…the caller's SCM OAuth token…` |
| `plugins/bruno/src/api/BrunoClient.ts:18` | `const GITHUB_TOKEN_HEADER = 'x-bruno-github-token';` | `const SCM_TOKEN_HEADER = 'x-bruno-scm-token';` |
| `plugins/bruno-backend/src/service/router.ts:318` | jsdoc `…GitHub OAuth token from the \`x-bruno-github-token\` request header` | `…SCM OAuth token from the \`x-bruno-scm-token\` request header` |
| `plugins/bruno-backend/src/service/router.ts:323` | `req.headers['x-bruno-github-token']` | `req.headers['x-bruno-scm-token']` |

**String-literal occurrences of the header name: 2 (one per side) + 2 jsdoc
mentions.** Verified: `grep -rn 'x-bruno-github-token' plugins` returns exactly
these 4 lines (docs/*.md also mention it — see "Docs" below, out of code scope).

### Dependent identifier renames (same phase, required for consistency)

`GITHUB_TOKEN_HEADER` → `SCM_TOKEN_HEADER` — **4 sites** (1 decl + 3 uses):

| file:line | current |
|---|---|
| `plugins/bruno/src/api/BrunoClient.ts:18` | declaration |
| `plugins/bruno/src/api/BrunoClient.ts:91` | `headers[GITHUB_TOKEN_HEADER] = token;` |
| `plugins/bruno/src/api/BrunoClient.ts:113` | `headers[GITHUB_TOKEN_HEADER] = token;` |
| `plugins/bruno/src/api/BrunoClient.ts:134` | `headers[GITHUB_TOKEN_HEADER] = token;` |

`githubTokenFromHeader` → `scmTokenFromHeader` — **4 sites** (1 decl + 3 calls):

| file:line | current |
|---|---|
| `plugins/bruno-backend/src/service/router.ts:322` | `function githubTokenFromHeader(req: express.Request)` |
| `plugins/bruno-backend/src/service/router.ts:182` | `const userToken = githubTokenFromHeader(req);` |
| `plugins/bruno-backend/src/service/router.ts:221` | `userToken: githubTokenFromHeader(req)` |
| `plugins/bruno-backend/src/service/router.ts:249` | `userToken: githubTokenFromHeader(req)` |

Both are module-private (`const` / non-exported `function`) — verified not
re-exported from either `src/index.ts`, so this is not a published-API change.

---

## Call-site inventory — DB columns `github_url` → `source_url`

**8 code sites across 2 files** (`grep -rn 'github_url' plugins` → exactly 8).

| file:line | current | change |
|---|---|---|
| `src/store/connectionStore.ts:20` | `github_url: string;` (`RawRow`) | `source_url: string;` |
| `src/store/connectionStore.ts:29` | `githubUrl: row.github_url,` | `sourceUrl: row.source_url,` |
| `src/store/connectionStore.ts:45` | `table.text('github_url').notNullable();` | `table.text('source_url').notNullable();` |
| `src/store/connectionStore.ts:64` | `github_url: row.githubUrl,` | `source_url: row.sourceUrl,` |
| `src/store/collectionsStore.ts:19` | `github_url: string;` (`RawRow`) | `source_url: string;` |
| `src/store/collectionsStore.ts:28` | `githubUrl: row.github_url,` | `sourceUrl: row.source_url,` |
| `src/store/collectionsStore.ts:44` | `table.text('github_url').notNullable();` | `table.text('source_url').notNullable();` |
| `src/store/collectionsStore.ts:63` | `github_url: row.githubUrl,` | `source_url: row.sourceUrl,` |

Tables: `bruno_connections` (PK `entity_ref`), `bruno_collections` (PK
`collection_id`). Column names appear **nowhere else** — no raw SQL, no
`orderBy`/`where` on `github_url` (verified).

### Migration consequence — investigated

**There is no knex migration infrastructure in this plugin at all.**
`find plugins -type d -name 'migrations*'` → **no results**. Both stores do
ad-hoc guarded DDL at construction time:

```ts
if (!(await client.schema.hasTable('bruno_connections'))) {
  try { await client.schema.createTable(…); }
  catch (error) { if (!(await client.schema.hasTable(…))) throw error; }
}
```

(`connectionStore.ts:41-57`, `collectionsStore.ts:40-56` — the `try/catch`
tolerates a racing replica.)

**Dev burden: zero.** `app-config.yaml:46-48` sets
`backend.database.client: better-sqlite3`, `connection: ':memory:'`. The DB is
destroyed on every process exit, so `hasTable` is always false at boot and both
tables are created fresh with `source_url`. A renamed column is invisible in dev.

**A host on persistent Postgres faces a hard runtime break.** Their table already
exists, so `hasTable` returns **true**, `createTable` is **skipped**, and the
column stays `github_url` forever. Then:
- every `upsert` → `insert({ source_url: … })` throws
  `column "source_url" of relation "bruno_connections" does not exist`;
- every read → `rowToModel` returns `sourceUrl: undefined`, so
  `POST /connections` (`router.ts:226`) writes and `rebuildConnected`
  (`collectionService.ts:395`) calls `connectFromUrl({ url: undefined })`.

So the break is **silent at boot and total at first use** — the worst failure
shape. It cannot be left undocumented.

### ⛔ SUPERSEDED — no migration shipped

The user directed (2026-08-19): *"Re-write the DB if needed, I'll be starting the
backend server from scratch only."* The database is always created fresh, so a
migration branch would be dead code in the only workflow that exists. **P0 ships the
renamed `createTable` schema and no migration.** This keeps the phase a genuinely
pure rename.

Consequence to carry forward: any future host with a **persistent** database (and any
v1 publish, per B8/B9) will need a real migration, because `hasTable` returns true,
the column is never renamed, and every write then fails. That is a v1 concern, not a
POC one — record it when the plugin is prepared for publishing.

The analysis below is retained for that future work.

### ~~Recommendation: ship an idempotent guarded `renameColumn` in both stores~~

Add an `else if` branch beside the existing `hasTable` guard, in the **same
ad-hoc-guarded-DDL idiom the file already uses** (so no new abstraction, and no
migrations framework introduced):

```ts
if (!(await client.schema.hasTable('bruno_connections'))) {
  try {
    await client.schema.createTable('bruno_connections', (table) => {
      table.text('entity_ref').primary();
      table.text('source_url').notNullable();
      // … unchanged
    });
  } catch (error) {
    if (!(await client.schema.hasTable('bruno_connections'))) {
      throw error;
    }
  }
} else if (await client.schema.hasColumn('bruno_connections', 'github_url')) {
  try {
    await client.schema.alterTable('bruno_connections', (table) => {
      table.renameColumn('github_url', 'source_url');
    });
  } catch (error) {
    if (await client.schema.hasColumn('bruno_connections', 'github_url')) {
      throw error;
    }
  }
}
```

…and the identical shape for `bruno_collections` / `github_url`.

**Justification (one line):** it costs ~10 lines per store, reuses the file's
existing guarded-DDL idiom rather than introducing a migrations framework, is
idempotent and replica-safe by the same `hasColumn` re-check the `createTable`
path already models, and it converts a silent-then-total data-loss break into a
no-op — whereas the "document the break" alternative buys a smaller diff at the
price of the one failure mode nobody can debug from the symptom.

**Verified API availability:** `knex/types/index.d.ts:2413`
`hasColumn(tableName, columnName): Promise<boolean>`; `:2431`
`renameColumn(from, to): TableBuilder`. Both are on the installed knex.

**Honest caveat — this is the single deliberate exception to this phase's "no
behaviour change" rule.** It adds a code path that did not exist. It is scoped
to store construction, is a no-op on every fresh DB (i.e. all dev runs and all
CI), and changes no request-handling behaviour. If the orchestrator wants P0 to
be *literally* pure rename, the fallback is: drop both `else if` branches,
and instead add a **BREAKING** note to `plugins/bruno-backend/README.md`
instructing hosts to `DROP TABLE bruno_connections, bruno_collections` (data
loss: connections + imports, both re-creatable from the UI) before upgrading.
Decision D4 ("straight rename — do it before v1 and there is nothing to alias")
supports that fallback being *acceptable*; I still recommend the guarded rename,
because the cost asymmetry is ~20 lines against an unrecoverable-looking break.
**Pick one and state it in the commit message.**

**Not in scope either way:** collection **ids** are `sha256(normalized URL)`
(`collectionService.ts:216-219`) and are **unaffected** — this phase changes no
URL normalization, so no id is re-keyed. Id re-keying is B2 / MSCM-P4.

---

## `config.d.ts` wording (B9)

`plugins/bruno-backend/config.d.ts` — two edits, wording only. **Do not change
the `type` union**: it is `'local' | 'url'`, which is already provider-neutral
(MULTI-SCM-PLAN.md §MSCM-P0 says "widen … the `type` union"; that instruction is
**stale//incorrect** — there is no provider name in the union. See "Corrections".)

- **`config.d.ts:23-27`** — before:
  `The source type: read from the local filesystem, or fetch from a URL (e.g. a GitHub tree/blob URL) via Backstage's UrlReader.`
  after: `… or fetch from a URL (e.g. a GitHub, GitLab, or Bitbucket tree/blob URL) via Backstage's UrlReader.`
- **`config.d.ts:29-34`** — before:
  `For \`local\`: a path … For \`url\`: a GitHub tree or blob URL.`
  after: `For \`url\`: a source-control tree or blob URL (GitHub, GitLab, Bitbucket, …) on a host configured under \`integrations\`.`

Keep every `@visibility backend` tag and the interface shape byte-identical.

---

## Catalog annotation VALUES — checked, and one thing to know

**Keys are unchanged.** Values:

- `BrunoLinkProcessor.ts:77-79` writes `'bruno.dev/collection-path'` and
  `'bruno.dev/source-url'` from `link.githubUrl`. The **field feeding them is
  renamed** (inventory rows 4-6) so the expression becomes `link.sourceUrl`. The
  **emitted string value is byte-identical** — it is the same URL from the same
  `GET /connections` row.
- `BrunoEntityProvider.ts:94` / `:98` write both annotations from
  `source.target` (`BrunoSourceConfig.target`), which is **not renamed**. No
  change.

**Coupled wire contract to change atomically:** `BrunoLink`
(`BrunoLinkProcessor.ts:17-21`) is the processor's structural cast
(`return body as BrunoLink[]`, `BrunoLinkProcessor.ts:132`) of the
`GET /connections` response built at `router.ts:258-264`. Renaming one side
without the other type-checks fine and fails **silently at runtime**
(`link.sourceUrl === undefined` → annotations set to `undefined`). Inventory rows
**4 and 15 must land together.**

---

## Export / re-export surface that changes

- **`plugins/bruno/src/index.ts:14`** — `export * from './api/types';` ⇒
  `DiscoveredCollection`, `ConnectionRecord`, and `ImportedCollection` are
  **published API**. Their `githubUrl` → `sourceUrl` is a **breaking change for
  any external consumer.** No edit to `index.ts` itself is required (the
  star-export carries the new name automatically).
- **`plugins/bruno-backend/src/index.ts:24-46`** — re-exports
  `DiscoveredCollection` (`:32`) and `ImportedCollection` (`:36`) as types.
  **Same breaking change; no edit to `index.ts` required.**
- **Not published, so not a contract change:** `BrunoConnectionRow`,
  `ImportedCollectionRow` (store modules are not re-exported from
  `bruno-backend/src/index.ts`), `BrunoLink` (not exported at all),
  `GITHUB_TOKEN_HEADER`, `githubTokenFromHeader`.
- Nothing needs adding to or removing from either `index.ts`. **Verified** by
  reading both files in full.

This is exactly B8's argument for doing P0 pre-publish, and decision **D4**:
straight rename, no alias, no deprecation window.

---

## Route auth modes — **preserve exactly, change nothing**

Read from `router.ts` at `ef10756`. This phase touches the *bodies* of several
handlers; **every `httpAuth.credentials(...)` call must be left byte-identical.**

| route | line | auth |
|---|---|---|
| `GET /health` | 64 | *(none — barrier `unauthenticated`)* |
| `GET /collections` | 69 | `allow: ['user']` |
| `POST /collections/import` | 74 | `allow: ['user']` ✎ body edited |
| `GET /collections/imported` | 103 | `allow: ['user', 'service']` ✎ body edited |
| `DELETE /collections/imported/:id` | 117 | `allow: ['user']` |
| `GET /collections/:id` | 128 | `allow: ['user']` |
| `GET /collections/:id/docs` | 143 | **no in-handler call** — gated by the `user-cookie` auth policy in `plugin.ts:89-91`. **Do not add one** (the comment at `router.ts:139-142` explains a bearer-only read would reject the iframe cookie). |
| `GET /collections/:id/opencollection.yml` | 170 | `allow: ['user']` |
| `POST /collections/:id/sync` | 180 | `allow: ['user']` ✎ body edited (188, and 182 fn rename) |
| `GET /dashboard` | 204 | `allow: ['user', 'service']` |
| `POST /connections` | 211 | `allow: ['user']` ✎ body edited (226, and 221 fn rename) |
| `POST /connections/discover` | 239 | `allow: ['user']` ✎ 249 fn rename |
| `GET /connections` | 255 | `allow: ['user', 'service']` ✎ body edited (261) |
| `GET /connections/:entityRef` | 269 | `allow: ['user']` ✎ body edited (280) |
| `DELETE /connections/:entityRef` | 287 | `allow: ['user']` |
| `POST /refresh` | 298 | **no credentials call** (POC/demo endpoint) — leave as-is |

Barrier policies in `plugins/bruno-backend/src/plugin.ts:77-79`
(`allow: 'unauthenticated'`) and `:89-91` (`allow: 'user-cookie'`) are
**untouched**.

---

## Docs (in-repo prose) — deliberately out of scope

`grep -rn 'x-bruno-github-token' docs/` matches
`docs/POC-OVERVIEW.md:79,146,193`, `docs/POC-OVERVIEW.confluence.md:119,142,166`,
`docs/POC-GAPS.md:48`, `docs/PRODUCTION-REVIEW.md:170,184`,
`docs/POC-DECISIONS.md:99,153`, `docs/NEXT-STEPS.md:121,129`,
`docs/execution/SYNC-P1-plan.md:9`. These are **historical records of shipped
phases** and must **not** be rewritten — doing so would falsify the record of
what those commits did. `MULTI-SCM-PLAN.md:211` likewise documents the *current*
name as the thing to rename.

**Do update** `plugins/bruno-backend/README.md` and `plugins/bruno/README.md` if
either names the header or `githubUrl` as current API. Verified matches:
`plugins/bruno-backend/README.md:64,65` mention `sourceUrl?` (already correct,
these describe `GET /collections`, unaffected) and `:91` mentions
`bruno.dev/source-url` (key, unchanged) — so **no README edit is required**,
but re-grep both after editing and fix any wire-contract mention you find.

---

## Ordered execution checklist

Do it in this order so the type-checker guides you and no intermediate state has
a silently-broken wire contract. Run `yarn tsc` only at the marked points.

1. **Backend types.** `plugins/bruno-backend/src/types.ts` — rows 1-3
   (jsdoc `:146`, `:147`, `:176`).
2. **Frontend types.** `plugins/bruno/src/api/types.ts` — rows 27-29
   (`:144`, `:156`, `:182`).
3. **Stores** — `connectionStore.ts` then `collectionsStore.ts`: the camelCase
   field (rows 21-26) **and** the snake_case columns (all 8 column sites)
   **and** the guarded `renameColumn` branch (or the README break note, per the
   decision recorded above). Do both stores identically.
4. **`yarn tsc`** → expect errors only in the not-yet-edited consumers
   (`router.ts`, `collectionService.ts`, `BrunoLinkProcessor.ts`, and the four
   frontend components). Use that error list as your worklist; it should name
   nothing outside the inventory above. **If it names a file not in the
   inventory, stop and report** — the inventory is wrong.
5. **`collectionService.ts`** — rows 17-20 (`:395`, `:479`, `:484`, `:485`).
6. **`router.ts`** — rows 7-16 (`:82,83,87,89,93,109,188,226,261,280`), then the
   `githubTokenFromHeader` → `scmTokenFromHeader` rename (`:322` decl; `:182`,
   `:221`, `:249` calls) and the header literal + jsdoc (`:318`, `:323`).
   **Leave `:258` (`rows.map(row => ({`) exactly as it is.**
7. **`BrunoLinkProcessor.ts`** — rows 4-6 (`:20`, `:77`, `:78`).
   *(Steps 6 and 7 together satisfy the atomic wire-contract requirement.)*
8. **`BrunoClient.ts`** — row 31 (`:166`), the header const rename (`:18` decl;
   `:91`, `:113`, `:134` uses) and the jsdoc (`:14-17`).
9. **`BrunoApi.ts`** — row 30 (`:44`).
10. **Frontend components** — `useCollectionPicker.ts` (`:111`, `:260`, `:321`),
    `AddCollectionModal.tsx` (`:187`), `LinkPanel.tsx` (`:100`, `:118`, `:224`),
    `BrunoCard.tsx` (`:74`, `:126`). **Do not touch `BrunoCard.tsx:16`.**
11. **`config.d.ts`** — the two wording edits (`:23-27`, `:29-34`).
12. **Gate: `yarn tsc`** → must be **0 errors**.
13. **Gate: `yarn lint:bruno plugins/bruno plugins/bruno-backend`** → must show
    **exactly** the one pre-existing `router.ts:258` arrow-parens error and the
    five pre-existing `no-explicit-any` warnings in
    `plugins/bruno-backend/src/types/*.d.ts`. **Never run `lint:bruno:fix`.**
14. **Residual-name sweep** (all must return **0** hits under
    `plugins/`, excluding `node_modules`):
    - `grep -rn 'githubUrl' plugins | grep -v node_modules | grep -v "lib/githubUrl"`
    - `grep -rn 'github_url' plugins`
    - `grep -rn 'x-bruno-github-token' plugins`
    - `grep -rn 'GITHUB_TOKEN_HEADER\|githubTokenFromHeader' plugins`
15. **Live functional check** (no tests exist; this *is* the verification):
    `yarn start`, then with an entity carrying a Bruno annotation —
    (a) the Bruno card loads a **connected** collection and shows its source URL
    (exercises rows 39-40 + `GET /connections/:entityRef`);
    (b) **scan + link** a repo URL from the picker (exercises discover→connect,
    rows 32-34 + 17-20 + the renamed header end-to-end — confirm in the browser
    network tab that the request carries **`x-bruno-scm-token`** and **no**
    `x-bruno-github-token`);
    (c) **import** a collection from the Bruno page and confirm it appears under
    `GET /collections/imported` (exercises rows 7-12, 35, 30-31, both stores);
    (d) **sync** a connected collection (exercises `:188`, `:182`);
    (e) confirm an injected annotation still appears on an externally-owned API
    entity (exercises the `BrunoLink` contract, rows 4-6 + 15).
    **Never paste a token into the transcript.**

---

## Acceptance criteria (mechanically checkable)

1. `yarn tsc` → **0 errors**.
2. `yarn lint:bruno plugins/bruno plugins/bruno-backend` → **exactly** 1 error
   (`router.ts:258` arrow-parens) and **exactly** 5 warnings (`no-explicit-any`
   in `plugins/bruno-backend/src/types/*.d.ts`). No new error, no new warning.
3. `grep -rn 'githubUrl' plugins --include='*.ts' --include='*.tsx' | grep -v node_modules`
   → **exactly these 3 lines**, all deliberate references to the
   `lib/githubUrl` *module* rather than the renamed field:
   - `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx:16` — `from '../../lib/githubUrl'`
   - `plugins/bruno/src/lib/brunoLink.ts:1` — `from './githubUrl'`
   - `plugins/bruno-backend/src/provider/BrunoEntityProvider.ts:145` — comment naming the module
   State the expected set explicitly; do **not** use a negative `grep -v` filter.
   Every filter tried here was wrong: `lib/githubUrl` misses `brunoLink.ts`
   (`from './githubUrl'`, no `lib/` prefix) and `githubUrl'` misses the
   `BrunoEntityProvider` comment (ends `githubUrl.ts`, no quote).
4. `grep -rn 'github_url' plugins | grep -v node_modules` → **0 lines** (no
   migration is shipped; see the superseded migration section).
5. `grep -rn 'x-bruno-github-token' plugins` → **0 lines**;
   `grep -rn 'x-bruno-scm-token' plugins` → **exactly 2** code lines
   (`BrunoClient.ts:18`, `router.ts:323`) plus 2 jsdoc lines.
6. `grep -rn 'GITHUB_TOKEN_HEADER\|githubTokenFromHeader' plugins` → **0 lines**.
7. `grep -rnc "bruno.dev/source-url\|bruno.dev/collection-path\|bruno.dev/collection-id" plugins`
   → **identical counts to `ef10756`** (annotation *keys* untouched).
8. `git diff --stat ef10756` touches **only** the 15 inventory files +
   `config.d.ts` (+ optionally `plugins/bruno-backend/README.md`). **No file
   under `packages/` is modified.**
9. `git diff ef10756 -- plugins/bruno-backend/src/service/router.ts | grep -E '^[+-].*httpAuth.credentials'`
   → **0 lines** (no auth mode changed). The `^[+-]` anchor is required: an
   unanchored grep matches an unchanged *context* line from the
   `POST /collections/:id/sync` hunk and returns 1.
10. `git diff ef10756 -- plugins/bruno-backend/src/plugin.ts` → **empty**.
11. `grep -n "'local' | 'url'" plugins/bruno-backend/config.d.ts` → still present
    (the `type` union was **not** widened).
12. Live check 15(a)-(e) all pass; the network tab shows `x-bruno-scm-token`.

---

## Corrections to MULTI-SCM-PLAN.md

1. **§B8's call-site list is drastically incomplete.** It cites
   `api/types.ts:144,156,182` and `backend/types.ts:147,176` — **5 of 42**
   occurrences across **2 of 15** files. All five anchors are individually
   **correct**. The omitted 37 include the two store modules, `router.ts` (10),
   and six frontend components. An implementer working from §B8 alone would ship
   a non-compiling tree.
2. **§MSCM-P0's "widen … the `type` union" instruction is wrong.** The union at
   `config.d.ts:28` is `'local' | 'url'` — already provider-neutral. There is no
   provider name in any `config.d.ts` type. Only the two **prose** blocks
   (`:23-27`, `:29-34`) name GitHub. This plan widens the wording only.
3. **§B8 says the provider name appears "in the values written to
   `bruno.dev/collection-path` and `bruno.dev/source-url`".** Misleading: the
   *values* are user-supplied repo URLs (which do contain "github.com" for a
   GitHub repo, but that is data, not our naming). The renamed thing is the
   *internal field* feeding them (`BrunoLinkProcessor.ts:77-78`); the emitted
   strings are byte-identical. `BrunoLinkProcessor.ts:77` is a correct anchor.
4. **§MSCM-P0 does not mention the migration consequence at all**, nor that this
   repo has **no knex migration infrastructure** (`find plugins -name
   'migrations*'` → nothing) and evolves schema via ad-hoc `hasTable`-guarded
   `createTable`. §6 defers "knex migrations for the existing schema" to
   `PRODUCTION-REVIEW.md`, which leaves the P0 column rename's break
   unaccounted-for. This plan resolves it explicitly.
5. **§MSCM-P0's acceptance criterion "no `github` in any exported type name,
   header name, or column name" is already satisfiable but under-specified** — no
   *exported type name* contains "github" today (the field names do). Criteria
   3-6 above are the checkable form.

---

## Operational note — rolling deploys

A straight column rename (decision D4, no alias column) means that during a rolling
deploy the new replica renames `github_url` → `source_url` while old-code replicas
are still live; those old replicas then fail every write against the missing column
until they cycle out. Not fixable inside P0 under D4 — record it in the release
notes for any host running more than one backend replica against a persistent
database.

## Risks / open questions

1. **The `BrunoLink` ↔ `GET /connections` contract breaks silently.**
   `BrunoLinkProcessor.ts:132` is an unvalidated `as BrunoLink[]` cast, so
   renaming `router.ts:261` without `BrunoLinkProcessor.ts:20` **type-checks and
   lints clean** while writing `undefined` into two catalog annotations on every
   externally-owned API entity. `yarn tsc` **cannot** catch this. Mitigation:
   checklist steps 6-7 are adjacent and mandatory; acceptance check 15(e) is the
   only real detector. **Highest-severity risk in this phase.**
2. **The DB column rename's blast radius depends on an unverifiable fact.** I
   confirmed dev is in-memory sqlite (`app-config.yaml:46-48`) so dev is safe,
   but I **could not verify whether any host has already deployed this POC
   against a persistent Postgres**. Decision **D3** explicitly says "We do not
   know who has already deployed the POC" — which argues *for* the guarded
   `renameColumn`. If the orchestrator knows no such deployment exists, the
   README-note fallback becomes defensible.
3. ~~**`renameColumn` on sqlite is a table rebuild, not a true ALTER.**~~
   **RESOLVED — this claim was wrong, in the safer direction.** knex does *not*
   emulate the rename: both the sqlite3 dialect
   (`knex/lib/dialects/sqlite3/schema/sqlite-tablecompiler.js:307`) and postgres
   (`.../postgres/schema/pg-tablecompiler.js:16`) emit a single native
   `alter table <t> rename <a> to <b>`. No table rebuild, no data copy, no PK or
   index loss. Verified twice by execution against this repo's own knex +
   `better-sqlite3` on a file-backed DB seeded with the old schema and a row:
   emitted SQL was the single native statement; the row survived verbatim;
   `PRAGMA table_info` kept `entity_ref` as PK and `source_url` NOT NULL; a second
   invocation was a no-op; and `onConflict('entity_ref').merge()` upserted
   correctly afterwards. The "hand-verify before claiming done" prerequisite is
   **discharged**.
4. **`router.ts:258` is two lines from an edit site.** An implementer with
   editor-integrated ESLint autofix-on-save, or a reflexive `--fix`, will absorb
   it and pollute the diff. Acceptance check 2 catches it (error count drops to
   0 instead of staying 1).
5. **`sourceUrl` becomes semantically overloaded.** It is optional on
   `CollectionSummary`/`CollectionDetail` (config-source URL, `undefined` for
   `local`) and required on the six renamed interfaces (a connected/discovered
   repo URL). No compile-time collision, but `router.ts:188`'s
   `row?.sourceUrl ?? …getCollection(id)?.sourceUrl` reads like a tautology at a
   glance. A future reader may "simplify" it and break local-collection sync.
   Mitigation: the existing explanatory comment at `router.ts:183-185` already
   covers it; leave that comment in place and update only its "GitHub" wording if
   you touch it.
6. **Open question (deferred, not blocking):** should `x-bruno-scm-token` also
   carry the provider type (e.g. `x-bruno-scm-provider: gitlab`) so the backend
   need not re-derive it? Not needed while GitHub is the only provider — the
   backend derives it from the URL via `integrations.byUrl`. Revisit in **P3**
   when `ScmAuth` starts returning tokens for multiple providers.

---

## Deferred to P1 / later (do NOT do here)

- `plugins/bruno/src/lib/githubUrl.ts` (file name) and its
  `repoRootFromCollectionUrl`, plus its backend duplicate at
  `BrunoEntityProvider.ts:146-157` and the stale comment at `:145` — **P1**
  (backend side) / **P3** (frontend side).
- `normalizeGithubUrl` (`collectionService.ts:203`), `parseGithubUrl` (`:722`),
  `ParsedGithubUrl` (`:714`), `composeCollectionUrl` (`:944`), `resolveRef`
  (`:969`) — renamed/moved behind the `ScmProvider` seam in **P1**.
- `integrations.github.byUrl(...)` (`collectionService.ts:753`, `:991`) →
  `integrations.byUrl(url)?.type` dispatch — **P1**.
- The Octokit fallback (`readUrlTreeViaOctokit`, `collectionService.ts:745`) —
  **P2** (a spike is separately testing its replacement).
- `githubAuthApiRef` / hardcoded `['repo']` scopes in `useCollectionPicker.ts`
  and `LinkPanel.tsx`, and `validateUrl`'s host matching — **P3**.
- Collection-id re-keying / versioned ids — **P4** (B2). This phase changes no
  normalization, so **no id changes**.
