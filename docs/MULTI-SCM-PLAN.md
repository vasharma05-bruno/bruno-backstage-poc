# MULTI-SCM — supporting GitLab / Bitbucket / others alongside GitHub · DRAFT

**Status:** DRAFT — revised after the P2 validation spike (findings folded in; corrections marked **[SPIKE]**). Not locked. Written to answer three questions: does Backstage
support per-user auth for non-GitHub providers, is there a one-stop repo-traversal
API, and what actually blocks shipping this as a **public** plugin that any host
drops into their own Backstage app.

**Scope:** read-only collection discovery + fetch across SCM providers. Write
operations (PRs, commits) are out of scope.

---

## 1. What Backstage already gives us (verified)

### 1.1 Per-user login providers — published today

| Provider | Backend module | Version |
|---|---|---|
| GitHub | `@backstage/plugin-auth-backend-module-github-provider` | 0.5.5 |
| GitLab | `…-gitlab-provider` | 0.4.5 |
| Bitbucket Cloud | `…-bitbucket-provider` | 0.3.17 |
| Bitbucket Server | `…-bitbucket-server-provider` | 0.2.17 |
| Atlassian | `…-atlassian-provider` | 0.4.17 |
| Azure / Microsoft | `…-microsoft-provider` | 0.3.17 |
| **Gitea** | — | **not published** |

Frontend clients all exist in `@backstage/core-app-api` (`GitlabAuth`,
`BitbucketAuth`, `BitbucketServerAuth`, `AtlassianAuth`, `MicrosoftAuth`) with
matching refs in `core-plugin-api`.

### 1.2 Server-side integrations — broader than auth

`ScmIntegrationRegistry` covers `github, gitlab, bitbucketCloud, bitbucketServer,
azure, gerrit, gitea, harness, awsCodeCommit, awsS3, azureBlobStorage`
(`@backstage/integration/dist/index.d.ts:1100`).

### 1.3 The two abstractions we should be using

- **`ScmAuth`** (`@backstage/integration-react`) — one frontend API that routes
  to the right OAuth provider by URL host and owns the per-provider scope
  mapping. `getCredentials({ url, additionalScope, optional })` → `{ token, headers }`.
- **`UrlReaderService.readTree(url)`** — already provider-agnostic.
  `@backstage/backend-defaults/urlReader` ships readers for GitHub, GitLab,
  Bitbucket Cloud, Bitbucket Server, Azure, Gerrit, Gitea, Harness, S3, Azure Blob.

### 1.4 Per-request credentials — the mechanism, corrected **[SPIKE]**

**An earlier draft of this plan claimed `readTree` has no credential option. That was
wrong.** `UrlReaderServiceReadTreeOptions` and `UrlReaderServiceReadUrlOptions` both
carry a `token?: string` field in the version this repo pins
(`backend-plugin-api/dist/index.d.ts`, readTree options ending ~line 1354), documented
verbatim as being for a token "maybe that's supplied by the user".

Verified honoured, by experiment — an invalid token passed this way yields `401` on both
providers, and the same reader without it succeeds:

| Reader | Honours per-call `options.token`? |
|---|---|
| `GithubUrlReader` | **yes** — short-circuits `GithubCredentialsProvider`, sets `Authorization: Bearer` |
| `GitlabUrlReader` | **yes** — destructured at line 73, threaded into `getGitLabRequestOptions(config, token)` |
| `FetchUrlReader` | yes |
| Bitbucket Cloud / Server, Gitea, Azure, Gerrit, Harness | **no** — integration config only |

So for the two providers we actually have per-user OAuth for, the fix is one argument on
the existing injected reader:

```ts
const tree = await reader.readTree(url, { token: userToken });   // no new reader, no config surgery
```

The Octokit fallback (`readUrlTreeViaOctokit`,
[collectionService.ts:746](../plugins/bruno-backend/src/service/collectionService.ts#L746))
is therefore not working around a platform gap — it is redundant. Deleting it also fixes
a proxy-egress gap, since `UrlReader` honours Backstage's HTTP-proxy config and raw
Octokit does not.

**The synthesized-config route stays in the design, but demoted** to a future hook for the
providers that ignore `options.token`. If it is ever built, two traps found by experiment:

- **Never synthesize a bare `{host, token}` entry — clone the host's existing entry and
  override the credential.** Minimal entries throw at *construction*:
  `github [{host:'ghe.example.com', token}]` → "must configure an explicit apiBaseUrl or
  rawBaseUrl"; `gitlab [{host:'gl.example.com', token}]` → "'undefined' is not a valid
  apiBaseUrl". `github.com`/`gitlab.com` self-default — which is exactly why a naive
  implementation passes local testing and breaks at the first enterprise adopter.
- **Per-request reader construction is cheap (~0.3 ms) but drops the GitHub App
  installation-token cache**, which lives per-`GithubUrlReader.factory` instance. On hosts
  using `integrations.github[].apps` it would re-mint an App token every request.
  Preferring `options.token` sidesteps this entirely.

Two further mechanism facts that constrain the implementation:

- **A `readTree` response is single-consumption.** Calling `files()` twice, or `dir()`
  after `files()`, throws "Response has already been read". Code wanting both must
  re-`readTree`.
- `UrlReadersOptions = { config: RootConfigService; logger: LoggerService; factories?: ReaderFactory[] }`;
  a `ConfigReader` satisfies it, and a synthesized config need not carry
  `backend.workingDirectory` (the read-tree factory falls back to `os.tmpdir()`).

---

### 1.5 Does Backstage use this internally? — partly, and the split matters

| Concern | Unified? | Evidence |
|---|---|---|
| **Reads** | **Yes** — one API | `UrlReaderService` is what `plugin-catalog-backend`'s `UrlReaderProcessor` and `plugin-techdocs-node`'s `stages/prepare/url` use for every provider. This is the blessed path; §1.4 is not an invention. |
| **Writes** | **No — deliberately not** | Seven separate published packages: `plugin-scaffolder-backend-module-{github 0.9.12, gitlab 0.11.9, bitbucket-cloud 0.3.9, bitbucket-server 0.2.24, azure 0.2.24, gitea 0.2.24, gerrit 0.2.24}`, each with its own `publish:*` action. Backstage never built a unified write abstraction. Fine for us — writes are out of scope. |
| **Frontend auth** | Unified API, thinly used | `scmAuthApiRef` has exactly **one** core consumer: `plugin-catalog-import`. And that plugin's own flow is effectively GitHub + Azure only (24 vs 19 provider references in its bundle, zero for gitlab/bitbucket). The abstraction is real but lightly exercised — we would be an early adopter, not on a paved road. |

### 1.6 Backstage's own answer to the URL-grammar problem: don't parse URLs

The scaffolder does **not** parse provider web URLs. `RepoUrlPicker` uses a
structured `repoUrl` string — `host?owner=&repo=&organization=&workspace=&project=`
(`plugin-scaffolder/dist/components/fields/RepoUrlPicker/utils.esm.js`,
`parseRepoPickerUrl`) — collected by six per-provider pickers
(`GithubRepoPicker`, `GitlabRepoPicker`, `BitbucketRepoPicker`, `AzureRepoPicker`,
`GiteaRepoPicker`, `GerritRepoPicker`), each asking for the fields its provider
actually needs (Bitbucket: workspace + project; Azure: organization + project).

This is a real alternative to B1's six URL parsers, and it is what the platform
itself chose. See **D6**.

## 2. Blockers, ranked

Ranked by likelihood of biting a real external adopter.

### B1 — URL grammar is per-provider, and ours is hardcoded to GitHub · **blocker**

[`parseGithubUrl`](../plugins/bruno-backend/src/service/collectionService.ts#L722)
assumes `segments[0]=owner`, `[1]=repo`, `[2]==='tree'`, `[3]=ref`, rest = subpath.
Actual grammars:

| Provider | Web URL shape |
|---|---|
| GitHub | `/{owner}/{repo}/tree/{ref}/{path}` |
| GitLab | `/{group}/{subgroup…}/{repo}/-/tree/{ref}/{path}` — arbitrary-depth groups, `-` separator |
| Bitbucket Cloud | `/{workspace}/{repo}/src/{ref}/{path}` |
| Bitbucket Server | `/projects/{KEY}/repos/{slug}/browse/{path}?at=refs/heads/{ref}` — **ref in query** |
| Azure DevOps | `/{org}/{project}/_git/{repo}?path=…&version=GB{ref}` — **path and ref in query** |
| Gitea | `/{owner}/{repo}/src/branch/{ref}/{path}` |

Two consequences beyond parsing. `normalizeGithubUrl` does `u.search = ''`
([collectionService.ts:203](../plugins/bruno-backend/src/service/collectionService.ts#L203)),
which **destroys** the ref for Bitbucket Server and Azure. And the reverse
direction is equally coupled: `composeCollectionUrl` rebuilds GitHub-shaped URLs,
[`repoRootFromCollectionUrl`](../plugins/bruno/src/lib/githubUrl.ts) takes
`seg[0]/seg[1]`, and the frontend `validateUrl` rejects any host not matching
`github` and any `/blob/` path
([useCollectionPicker.ts:84](../plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts#L84)).

There is **no generic parser** in `@backstage/integration` — it exports only
`parseGiteaUrl`, `parseHarnessUrl`, `parseGitilesUrlRef`. This must be written
per provider. (`git-url-parse`, used internally by the readers, handles the
path-style providers but not Bitbucket Server `?at=` or Azure `?version=`.)

### B2 — Collection ids are hashes of URL text · **blocker, needs migration**

```ts
collectionIdFromUrl(url) = sha256(normalizeGithubUrl(url)).slice(0, 16)
```

([collectionService.ts:216](../plugins/bruno-backend/src/service/collectionService.ts#L216))

Any change to normalization — and B1 forces one, since query strings must stop
being dropped — silently re-keys **every** collection. That breaks
`bruno_connections` and `bruno_collections` rows, all three `bruno.dev/*` catalog
annotations, and every bookmarked docs URL. Needs a versioned id scheme plus a
migration, not an in-place edit.

### B3 — Per-user auth coverage is not uniform · **product decision, not fixable**

`ScmAuth.createDefaultApiFactory()` covers **github, gitlab, azure, bitbucket
only**, and `additionalScope.customScopes` accepts only those four keys
(`integration-react/dist/index.d.ts:105-215`). Combined with §1.1: **Gitea,
Gerrit, Harness, and AWS CodeCommit can never support the per-user private-repo
path** — not because their config cannot carry a token (per B4 **[SPIKE]**, Gitea's can),
but because there is no published auth provider to *obtain* a per-user token from. They work only via a host-configured service credential. State this in
the README as a support matrix rather than discovering it per-host.

Scope names also differ per provider and we currently hardcode `['repo']` in five
call sites — GitHub `repo`, GitLab `read_api read_repository`, Bitbucket Cloud
`account team pullrequest`, Bitbucket Server `PUBLIC_REPOS REPO_READ`. `ScmAuth`
owns this mapping; we should stop owning it.

### B4 — Integration-config credential shapes differ (and the plan had them wrong) · **[SPIKE]**

Only relevant if the synthesized-config route is ever built (see §1.4 — `options.token`
covers GitHub and GitLab without it). Corrected by round-tripping a sentinel token
through `ScmIntegrations.fromConfig` and reading each `get*RequestOptions`:

| Provider | Earlier claim | **Verified** |
|---|---|---|
| github | `token` | ✅ `token` → `Authorization: Bearer` |
| gitlab | `token` | ✅ `token` |
| bitbucketServer | `token` + `username` | ⚠️ **partly wrong** — `token` alone → `Bearer`, **or** `username`+`password` → `Basic`. `username` pairs with `password`, never with `token`. |
| bitbucketCloud | `token`, or `username`+`appPassword` | ❌ **wrong** — a bare `token` is **silently dropped** (`if (username && (token ?? appPassword))`). Needs `username`+`token`, or `clientId`+`clientSecret` → OAuth. `appPassword` is deprecated in favour of `token`. |
| gitea | `username`+`password` only; **cannot** carry a token | ❌ **conclusion wrong** — with `username` omitted, `getGiteaRequestOptions` sends `Authorization: token <password>`. Gitea *can* carry a bare PAT/OAuth token. |
| azure | `credentials[]` | ✅ `credentials: [{personalAccessToken}]`. A scalar `token` **throws hard**, it is not ignored. |
| gerrit | — | `username`+`password` |
| harness | — | `token` (or `apiKey`) |

The bitbucketCloud row is the dangerous one: a bare token produces `authed=false` and no
header — a silent anonymous read, not an error.

### B5 — Default-branch resolution — needed for *identity*, not for reading · **[SPIKE]**

Half of the original claim dissolves: `readTree` resolves the default branch itself on
GitHub (`/repos/{full}`) and GitLab (`project.default_branch`), so reading never needs a
ref up front.

**But the capability must survive, for a reason the first draft missed.** In
`discoverCollections`, `resolveRef`
([collectionService.ts:461](../plugins/bruno-backend/src/service/collectionService.ts#L461))
runs *after* the tree has already been fetched, and its result feeds exactly one place:
`composeCollectionUrl(normalized, rootPrefix, ref)` at
[:479](../plugins/bruno-backend/src/service/collectionService.ts#L479). That composed URL
becomes both the stored `sourceUrl` and, via `collectionIdFromUrl`, the **collection id**.
So the ref is not a fetch precondition — it is an *identity* input, and `readTree` never
hands back the ref it resolved internally. A per-provider `resolveDefaultBranch` therefore
stays in the seam.

Two consequences: `@backstage/integration` offers `getBitbucketCloudDefaultBranch` and
`getBitbucketServerDefaultBranch` but **no GitHub or GitLab equivalent**, so this stays
hand-written per provider; and it couples to **B2** — if a repo's default branch is renamed
(`master` → `main`), the composed URL changes and the collection id changes with it. The
versioned id scheme in P4 should decide whether identity pins a ref at all.

Separately, and belonging to B1: `git-url-parse` mis-parses a GitLab URL that omits
`/-/tree/<ref>/` — `…/-/tree/doc/api/graphql` yields `sha=doc` and a `NotFoundError`.

### B6 — Archive roots — **refuted at the API level** · **[SPIKE]**

`readTree` strips the archive root generically (`stripFirstDirectory`, documented at
`backend-defaults/dist/urlReader.d.ts:95`; implemented in
`.../urlReader/lib/tree/TarArchiveResponse.cjs.js`) plus the subpath, so returned paths are
already relative and carry no provider prefix. Observed: GitHub → `echo json.bru`,
`multiline/echo binary.bru` (15 files); GitLab → `_index.md`, … (19 files). The raw
archives genuinely do differ (`usebruno-bruno-aa5d85f/` on GitHub), but `readTree` never
exposes that.

Consequence, and it inverts the original finding: this is **not** a per-provider adapter
point. It is dead code in *our* tree — the root-detection heuristic around
[`commonRootPrefix`, declared at collectionService.ts:1009](../plugins/bruno-backend/src/service/collectionService.ts#L1009) and called at [:827](../plugins/bruno-backend/src/service/collectionService.ts#L827) and [:1374](../plugins/bruno-backend/src/service/collectionService.ts#L1374)
becomes unnecessary once every read goes through `readTree`. Leave it untouched in P1;
remove it in P2.

### B7 — Error→state mapping is GitHub-shaped · **UX bug**

The "404 without a token is ambiguous, so offer Connect GitHub" heuristic
([useCollectionPicker.ts:~185](../plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts#L185))
plus `classifyLinkError` encode GitHub's behaviour. GitLab 404s on hidden
projects but 403s elsewhere; Bitbucket Cloud returns 403; Bitbucket Server
returns 401. The private-repo funnel will mis-fire per provider.

### B8 — The provider name is baked into the published API surface · **do before v1**

`githubUrl` appears **42 times across 15 files** — of which 3 are `lib/githubUrl`
module-path references, leaving **39 field edits**. It is in `DiscoveredCollection`,
`ConnectionRecord`, and the `importCollections` payload
([api/types.ts:144,156,182](../plugins/bruno/src/api/types.ts#L144);
[backend/types.ts:147,176](../plugins/bruno-backend/src/types.ts#L147)), in the DB
columns, in the values written to `bruno.dev/collection-path` and
`bruno.dev/source-url`
([BrunoLinkProcessor.ts:77](../plugins/bruno-backend/src/processor/BrunoLinkProcessor.ts#L77)),
and in the wire header `x-bruno-github-token`. Renaming after publish is a
breaking change for every consumer and every stored annotation.

### B9 — Config schema says GitHub · **do before v1**

[`config.d.ts`](../plugins/bruno-backend/config.d.ts) documents `target` as "a
GitHub tree or blob URL". The published schema is the contract with hosts; widen
the wording and the `type` union before release, not after.

### B10 — The host prerequisite matrix multiplies · **needs a diagnostics surface**

Per provider, a host may have: integration configured but no auth provider; an
auth provider but insufficient scopes; or the host absent from
`integrations` entirely — in which case `byUrl()` returns `undefined` and the
reader falls through to `FetchUrlReader`, which fails on anything non-public.

**This is worse than "self-hosted" implies.** `readGithubIntegrationConfigs`
(`integration/dist/github/config.esm.js:40-50`) always appends a default `github.com`
entry when none is configured — which is precisely why this plugin reads public GitHub
today with no `integrations` config at all. **No other provider gets that default.**
`byUrl()` is exact host matching returning `undefined` for anything unlisted
(`helpers.esm.js:43-50`). So a host that configures nothing reads public GitHub fine and
gets `undefined` for a public **gitlab.com** or **bitbucket.org** URL. Multi-provider
support therefore requires hosts to add an `integrations.<provider>` block *even for
public repos* — an onboarding step GitHub never exposed.
With one provider these are three support tickets; with four they are twelve.
The plugin needs to report which providers are actually usable up front instead
of failing at click time.

### B11 — Rate-limit handling is per-provider and mostly absent · **we must own it**

There *is* an abstraction — `ScmIntegration.parseRateLimitInfo(response): RateLimitInfo`
(`integration/dist/index.d.ts:871`) — but it is close to vestigial:

- **Only GitHub implements it.** It is the single `parseRateLimitInfo` body in the
  whole `integration` package: `status === 429 || (403 && x-ratelimit-remaining === '0')`
  (`integration/dist/github/GithubIntegration.esm.js:32`).
- **Its only consumer is `GithubUrlReader`**, and all it does is append
  `" (rate limit exceeded)"` to an error message
  (`backend-defaults/dist/entrypoints/urlReader/lib/GithubUrlReader.cjs.js:238`).
  No retry, no backoff, no queueing.
- **GitLab has an entirely separate, unrelated mechanism**: its own fetch strategy
  with `Retry-After` parsing, exponential backoff capped at 10s, and `pThrottle`
  request-per-minute limiting (`integration/dist/gitlab/GitLabIntegration.esm.js:37-90`).
  Opt-in via `integrations.gitlab[].retry.{maxRetries,retryStatusCodes,maxApiRequestsPerMinute}`
  and **off by default** (`maxRetries ?? 0`).
- **No other provider has a retry or throttle config block at all** — `retry?:`
  appears exactly once in `integration/config.d.ts`, under gitlab.
- `RateLimitMiddleware` in `backend-defaults` is **inbound** protection for
  Backstage's own API. Unrelated to outbound SCM quota; do not conflate them.
- The one place with real throttling is the scaffolder's GitHub module, which pulls
  `@octokit/plugin-throttling` + `@octokit/plugin-retry` — the only Backstage
  package that declares them.

**What Backstage actually relies on is structural, not reactive:**

1. **ETag conditional requests** — `readUrl({ etag })` → 304 → `NotModifiedError`
   → skip processing. Used by `UrlReaderProcessor` and the techdocs url preparer.
   On GitHub, 304s do not count against the REST quota.
   **[SPIKE] — but `readTree`'s ETag is not an HTTP 304.** It is a client-side commit-SHA
   compare: GitHub spends 1 quota-counting call (`/commits/{ref}/status`, +1 to
   `/repos/{full}` for a ref-less URL) and GitLab spends **2** (`/projects/{id}` then
   `/repository/commits`) *before* comparing. So an ETag'd `readTree` still costs 1–3 API
   calls per refresh — it saves the tarball download, not the quota hit. Budget refresh
   loops on that basis. Separately, GitLab's `readUrl` returns **no ETag at all**, so on
   GitLab the mitigation is `readTree`-only.
2. **Archive endpoints instead of tree APIs** — `GithubUrlReader.readTree` fetches
   a **tarball**: one request per tree, not one per file.
3. **Credential scoping** — GitHub App installation tokens carry their own
   per-installation quota rather than sharing one PAT's.
4. **Scheduled refresh with configurable intervals** instead of on-demand fanout.

**Consequence for us, and it cuts both ways.** Our Octokit fallback does
`git.getTree({recursive})` then fetches blobs
([collectionService.ts:746](../plugins/bruno-backend/src/service/collectionService.ts#L746))
— the worst available pattern for quota, on the one provider where we have
per-user tokens. **MSCM-P2 fixes rate-limit exposure as a side effect**, because
`UrlReaders` gives us the tarball fetch and ETag support for free. Per-user tokens
also help: each user's OAuth token carries its own quota, so private reads do not
drain a shared service quota.

But we cannot assume a uniform backoff exists, because it does not. We must:
respect GitHub's `403 + x-ratelimit-remaining: 0` ourselves; document the
`integrations.gitlab[].retry` block for hosts (it is off by default); wire ETags
into `syncCollection` and `rebuildConnected` so refresh loops go 304 instead of
re-downloading; and throttle our own background rebuild, since nothing upstream
will do it for us.

---

## 3. Target architecture **[SPIKE-revised]**

```
Frontend                              Backend
────────                              ───────
scmAuthApiRef (via useApiHolder)      ScmProvider adapter registry
  .getCredentials({ url })              .parseRepoUrl(url)          ─┐ URL grammar
        │                               .composeCollectionUrl(...)   │ only — see
        │   x-bruno-scm-token           .repoRootFromUrl(url)         │ B5/B6: no
        └────────────────────────►      .canonicalIdInput(url)      ─┘ default-branch
                                                  │                    or archive-root
scmIntegrationsApiRef                             │                    adapter points
  .byUrl(url) → validation                        ▼
                                        integrations.byUrl(url)?.type
                                          → dispatch (+ defined
                                             undefined-fallback, B10)
                                                  │
                                                  ▼
                        reader.readTree(url, { token: userToken })
                        the INJECTED UrlReaderService — no new reader,
                        no synthesized config, no Octokit
```

Two seams, one per side. The frontend stops knowing provider names; the backend
knows them in exactly one place — and that place handles **URL grammar only**, because
the reader already owns credentials (§1.4), default-branch resolution (B5), and
archive-root stripping (B6).

---

## 4. Phases

Ordered so that anything affecting the published contract lands before v1, and
each phase is independently shippable.

### MSCM-P0 — Provider-neutral naming + widened config · **before v1**
Rename `githubUrl` → `sourceUrl` across `api/types.ts`, `backend/types.ts`, the
two store schemas, and the `ConnectionRecord`/`DiscoveredCollection`/import
payloads. Rename the header to `x-bruno-scm-token`. Widen `config.d.ts` wording.
Keep the annotation *keys* (`bruno.dev/source-url` is already neutral).
**Acceptance:** no `github` in any exported type name, header name, or column
name. Existing behaviour unchanged. Addresses B8, B9.

### MSCM-P1 — Backend `ScmProvider` seam, GitHub adapter only
Introduce the adapter interface from §3 and move today's GitHub logic behind it
(`parseGithubUrl`, `composeCollectionUrl`, `normalizeGithubUrl`,
`resolveRef`, `repoRootFromCollectionUrl`). Dispatch on
`integrations.byUrl(url)?.type`.
**Acceptance:** pure refactor, zero behaviour change. **This project has no test suite**,
so equivalence must be shown mechanically instead: capture every collection id *before*
the change and diff them after (ids are `sha256` of a normalized URL, so any drift in URL
handling shows up immediately), plus a clean `yarn tsc`, a clean live boot, and one
successful connect + sync against a public GitHub repo. A `grep`-based acceptance is NOT
usable here — the Octokit path legitimately still mentions GitHub until P2.
Addresses B1 structurally.

### MSCM-P2 — Delete Octokit; pass `options.token` to the injected reader **[SPIKE-revised]**
Replace `readUrlTreeWithCreds`/`readUrlTreeViaOctokit` with
`reader.readTree(url, { token: userToken })` on the **existing injected**
`UrlReaderService` — no new reader, no synthesized config, no per-request construction
(§1.4). Drop `@octokit/rest`, `resolveRef`'s Octokit client, and the now-dead root-detection
heuristic (B6). Leave a documented, unimplemented hook for the synthesized-config route,
for the providers that ignore `options.token`.
**Acceptance:** a **real** private-repo read succeeds through `options.token` (this needs
one real PAT or a live OAuth session — see §7, it is the one thing the spike could not
prove); proxy config honoured; `@octokit/rest` gone from `package.json`;
`syncCollection`/`rebuildConnected` pass an `etag` and treat `NotModifiedError` as
"unchanged"; no code calls `files()` twice on one `readTree` response. Addresses B5, B6,
B11 and the Octokit-proxy gap.

### MSCM-P3 — Frontend `ScmAuth`
Replace `githubAuthApiRef` in all five call sites with `scmAuthApiRef` obtained
through `useApiHolder().get()` so an unregistered API degrades to
public-repo-only instead of throwing at render. Replace `validateUrl`'s
`hostname.includes('github')` with `scmIntegrationsApiRef.byUrl(url)`. Derive all
"Connect …" copy from the provider.
**Acceptance:** card renders with no SCM auth API registered; GitHub flow
unchanged; scope strings no longer hardcoded. Addresses B3 (partly), B10 (partly).

### MSCM-P4 — Versioned collection ids + migration
Move to `v2:<provider>:<sha256(canonical(url))>` where `canonical` is
adapter-owned and query-preserving. Ship a knex migration that rewrites both
tables and a catalog re-emit that rewrites annotations. Keep v1 ids resolvable
read-only for one release.
**Acceptance:** an existing install upgrades with links and docs URLs intact.
Addresses B2.

### MSCM-P5 — GitLab adapter, then Bitbucket Cloud, then Bitbucket Server
GitLab first: it exercises nested groups, the `-` separator, and a working
per-user token, so it validates the P1 seam properly. Bitbucket Server last — it
is the one that forces query-string refs and therefore the most likely to expose
a wrong assumption in P4's canonicalization.
Per adapter: URL parse/compose, default-branch call (B5), archive-root
expectation (B6), error mapping (B7).
**Acceptance:** per provider, a public and a private collection connect, sync,
and render docs.

### MSCM-P6 — Preflight diagnostics + support matrix
A backend endpoint reporting, per configured integration: reachable, has service
credential, has a registered auth provider. Surface it in the UI as "GitLab:
public repos only — no auth provider registered". Publish the B3 matrix in the
README.
**Acceptance:** a host with a half-configured provider sees why before clicking.
Addresses B10.

---

## 5. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Which providers are v1? | GitHub + GitLab + Bitbucket Cloud. Bitbucket Server next. Gitea/Gerrit/Harness: service-credential only, documented. |
| D2 | Require explicit `/tree/{ref}` or implement per-provider default-branch lookup? | Implement it (B5) — requiring refs pushes real friction onto every user to save four small functions. |
| D3 | Break collection ids now, or carry a v1→v2 shim? | Shim for one release (P4). We do not know who has already deployed the POC. |
| D4 | Ship P0 renames as a breaking change, or alias? | Straight rename — do it before v1 and there is nothing to alias. |
| D5 | Old frontend system support? | Out of scope for this plan; tracked separately. It gates adoption but is orthogonal to multi-SCM. |
| D6 | Parse provider web URLs (B1), or adopt scaffolder-style structured `repoUrl` input (§1.6)? | **Hybrid.** Store canonically structured (`{provider, host, owner/workspace/project, repo, ref, path}`); accept a pasted web URL as a convenience parsed best-effort per provider. Paste is the whole UX of the connect flow, so we cannot drop it — but the *stored identity* should not be a URL string. This also defuses B2. |
| D8 | Build the synthesized-config route at all? | **Not in P2.** `options.token` covers GitHub + GitLab, which is D1's whole v1 scope. Leave it a documented hook and build it only if a provider that ignores `options.token` enters scope. |
| D7 | Who owns rate-limit backoff (B11)? | We do. Nothing upstream provides it uniformly. ETag-first refresh + our own throttle on `rebuildConnected`, plus documented `integrations.gitlab[].retry` guidance for hosts. |

## 6. Non-goals

- Write operations (PRs, commits, scaffolder actions).
- Gerrit, Harness, AWS CodeCommit, S3 adapters.
- Per-user auth for providers with no published auth module (B3).
- The old-frontend-system packaging question.
- Everything in `PRODUCTION-REVIEW.md` that is not provider-specific (permissions,
  cross-user cache exposure, knex migrations for the existing schema, the docs
  iframe cookie chain). Those block going public but are not multi-SCM work.

---

## 7. What the spike could NOT prove

The P2 validation spike ran against real GitHub and GitLab, but `.env` in this repo holds
only OAuth client id/secret for the login providers — no PAT, no GitLab token. So:

- **No real private-repo read was ever performed.** Everything verified shows a credential
  is *transmitted and evaluated by the server* (invalid token → `401`, absent token →
  success). Nothing shows that a *valid* credential grants access anonymous access would be
  denied. **That is P2's acceptance criterion and it needs one real token to close.**
- Whether a GitHub **user OAuth** token (`gho_*`) behaves like a PAT on the `codeload`
  tarball endpoint — only PAT-shaped, invalid strings were exercised.
- Every provider other than GitHub and GitLab is unverified end-to-end: Bitbucket
  Cloud/Server, Gitea, Azure, Gerrit, Harness were checked only at the config-resolution
  and header-construction layer. No `readTree` was issued against any of them.
- Proxy honouring, claimed as a P2 side benefit, was not exercised.
- `integrations.gitlab[].retry` (B11) was not exercised.

Re-runnable spike scripts are in the session scratchpad (`spike.js` … `spike5.js`); they
resolve modules out of this worktree, so they run from any cwd.
