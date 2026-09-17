# Bruno for Backstage — Gap Closure Design

> **Companion to** [`TECHNICAL-DESIGN.md`](./TECHNICAL-DESIGN.md). That document decides the
> architecture and enumerates what is *not* done. This document decides **how each open gap is
> closed**: the options considered, what is wrong with each, and the one selected.
>
> **Status:** 🟠 Living document · **Last updated:** 2026-09-18
> **Basis:** this repository at `claude/technical-design-gaps-b63dc3`, its dependency tree as
> installed (Backstage 1.53.0), and five parallel research passes over the source, `node_modules`
> and upstream provider documentation.

---

## How to read this document

One section per gap, each with the same four headings:

- **The gap** — what is actually broken or absent, with file references.
- **Options** — every approach seriously considered, with pros and cons. Options are real
  alternatives, not strawmen; where an option is obviously wrong it is still recorded, because
  the reason it is wrong is the useful part.
- **Selected** — the chosen option and why it beat the others.
- **Implementation** — files, APIs, config keys, tests, and the honest effort estimate.

Two conventions carried over from `TECHNICAL-DESIGN.md`:

- **Verified** — executed or read directly from source/`node_modules`. Cited with `file:line`.
- **Asserted** — argued from verified facts but not itself run.

A gap is **Closable here** if it can be finished inside this repository. Some cannot be — they
need a second repository (`bruno-electron`, the renderer), an external resource (a Postgres
cluster, real GitLab/Bitbucket credentials, a multi-replica deployment), or a decision that is
commercial rather than technical (licensing). Those are marked and scoped rather than quietly
dropped.

---

## Gap register

Severity is the operational consequence of shipping without the fix, not the effort to fix it.

### Security — `SEC`

| ID | Gap | Source | Severity | Closable here |
| --- | --- | --- | --- | --- |
| SEC-1 | SSRF and private-repo existence oracle on the probe/create routes | §9 S1, R3 | **Critical** | Yes |
| SEC-2 | No authorization model (IDOR on every mutating route) | §9 S2, R2 | **Critical** | Yes |
| SEC-3 | Docs CSP allows `https:` broadly; `allow-same-origin` on the app's cookie origin | §9 S3 | High | Partial |
| SEC-4 | Renderer bundle served from an unpinned staging CDN | §9 S4, R4 | High | Partial |
| SEC-5 | Playground proxy: frontend-hardcoded host map, no server-side secret injection | §9.3, P5 | Medium | Deferred |
| SEC-6 | `</script` neutralisation misses `<!--`; any ingested repo can break the docs page | *new* | High | Yes |
| SEC-7 | Log injection via the raw probe URL | *new* | Medium | Yes |
| SEC-8 | `getByName` case-insensitive, `delete` case-sensitive — becomes a security bug under SEC-2 | *new* | Medium | Yes |
| SEC-9 | No caps on request-body array lengths | *new* | Low | Yes |
| SEC-10 | Docs iframe silently cannot download (`allow-downloads` absent) | *new* | Low | Yes |

### Data correctness and persistence — `DAT`

| ID | Gap | Source | Severity | Closable here |
| --- | --- | --- | --- | --- |
| DAT-1 | Secrets in generated docs reach the catalog in plaintext | §14.1, R1, P1 | **Critical** | Yes |
| DAT-2 | Byte-stability of the generated definition is not enforced in CI | §14.2, R8 | High | Yes |
| DAT-3 | No database migrations on the two tables | §4, R10 | High | Yes |
| DAT-4 | Postgres never exercised; everything has run on in-memory SQLite | §14.9, §18.4 | Medium | Yes |
| DAT-5 | Multi-replica behaviour never run | §14.3, R9 | Medium | Partial |
| DAT-6 | Divergences from Bruno's own exporter are undocumented for users | §14.8 | Low | Yes |
| DAT-7 | Entity size at scale unmeasured (500 collections × 1 MiB) | §18.7 | Medium | Yes |

### SCM provider coverage — `SCM`

| ID | Gap | Source | Severity | Closable here |
| --- | --- | --- | --- | --- |
| SCM-1 | Org-wide discovery is GitHub-only | §6, R12 | High | Yes |
| SCM-2 | Pull-request (descriptor write) flows are GitHub-only | §14.6, R12 | High | Yes |
| SCM-3 | Tier-1 zero-quota revalidation is GitHub-only | §5 | Medium | Yes |
| SCM-4 | Support-matrix holes: Bitbucket Server/DC, Azure, Gitea, Gerrit, Harness | §5 | Medium | Partial |
| SCM-5 | Large-repo tree truncation is logged, never surfaced | §14.7 | Low | Yes |
| SCM-6 | Credential-shape traps are documented in prose only, so nothing stops a regression | §5 | Medium | Yes |
| SCM-7 | Link/unlink pull request is broken on GitHub Enterprise — every call goes to `api.github.com` | *new* | **High** | Yes |

### Frontend and UX — `FE`

| ID | Gap | Source | Severity | Closable here |
| --- | --- | --- | --- | --- |
| FE-1 | Legacy frontend system unsupported | §8, R6, P2 | High | Yes |
| FE-2 | Docs frame does not match a customised host theme | §10, P3 | Medium | Partial |
| FE-3 | No broken-link detection for dead `spec.partOf` refs | §7.2 | Medium | Yes |
| FE-4 | Stranded UI-created collection whose name config claimed | §7.2 | Low | Yes |
| FE-5 | `bruno://` deep link absent; only the repo root is sent, not the subpath | §14.5, R13 | Medium | Partial |
| FE-6 | Tree truncation never reaches a user-visible surface — *merged into SCM-5* | §14.7 | Low | Yes |

### Release engineering — `REL`

| ID | Gap | Source | Severity | Closable here |
| --- | --- | --- | --- | --- |
| REL-1 | Zero router/security tests; the pyramid is unit-only | §14.4, R15 | **Critical** | Yes |
| REL-2 | Backstage floor below 1.53 unknown | §12, §18.1 | Medium | Yes |
| REL-3 | Distribution: package names, dependency ranges, licence | §11, R14, P6 | High | Partial |
| REL-4 | **No CI exists at all** — a finding of this study, not of the design doc | new | **Critical** | Yes |
| REL-5 | `yarn install` fails on a clean checkout (dead `portal:` resolutions) | new | **Critical** | Yes — *done* |
| REL-6 | Prior art unread; `deferToCatalogInfo` default unvalidated; CDN set audited on staging only | §18.8–18.10 | Low | Partial |

### Product calls — `PRD`

These are recorded, not decided here. `TECHNICAL-DESIGN.md` §17 owns them; this document only
states what engineering will build **under each possible answer**, so that the decision does not
block implementation.

| ID | Question | Blocks |
| --- | --- | --- |
| PRD-1 | Secret handling: byte-parity with Bruno, or redact? | DAT-1 |
| PRD-2 | Legacy frontend support: new-only, both, or on demand? | FE-1 |
| PRD-3 | Theme fidelity: presets only, or the `postMessage` handshake? | FE-2 |
| PRD-4 | Is `allowRuntimeWrites` on in the recommended config? | — |
| PRD-5 | Is the docs playground in Beta scope? | SEC-5 |
| PRD-6 | Package naming and licence | REL-3 |
| PRD-7 | Ship the `kind: API` fallback for kind-restricted orgs? | — |

---

## Sequencing

The order is driven by dependency, not by severity alone. Nothing can be verified until the repo
installs and CI runs, so REL-5 and REL-4 come first even though they are infrastructure.

| Phase | Contents | Rationale |
| --- | --- | --- |
| **0** | REL-5, REL-4 | A clean checkout must install and a pipeline must run, or no later fix is provably closed. |
| **1** | REL-1 (harness), SEC-6–SEC-9, SEC-1, SEC-2 | The two critical security holes, landed together with the `supertest` harness that proves them closed. The small defects go first: SEC-8 **must** precede SEC-2, whose ownership check is incorrect without it. Tests come with the fix, not after. |
| **2** | DAT-1, DAT-2, DAT-3 | Correctness of what we store and the ability to evolve it. DAT-2 needs the CI from phase 0. |
| **3** | SEC-4, SEC-3, SEC-10, DAT-6, FE-3, FE-4, FE-6, SCM-5 | Bundle hosting **before** the CSP, because `bruno.docs.cdnBaseUrl` is the CSP's single source of truth. Plus the UX gaps that are small and independent. |
| **4** | SCM-1, SCM-2, SCM-3 | Provider breadth. Largest single block of new code. |
| **5** | FE-1, FE-2, FE-5 | Frontend reach and fidelity. |
| **6** | DAT-4, DAT-5, DAT-7, REL-2, REL-3, SCM-4, SCM-6, REL-6 | Verification, measurement and release. Several need external resources. |

Three ordering constraints are **hard**, not preferences:

- **SEC-8 before SEC-2** — the ownership check reads one row and deletes another until the
  case-fold mismatch is fixed.
- **SEC-4 before SEC-3** — the pinned CSP derives its allowed origins from `bruno.docs.cdnBaseUrl`.
- **DAT-3 before DAT-4** — the Postgres tests must exercise migrations, not the DDL being deleted.

And one tooling prerequisite gates the whole of phase 1: **`supertest` and
`@backstage/backend-test-utils` are not installed.** Every "lock the hole closed" test depends on
adding them, so that is the first commit of the security workstream.

---

## SEC-1 — SSRF and the private-repo existence oracle

### The gap — corrected in both directions

The design doc says "any authenticated user may ask the backend to read any URL its integrations
can reach". Reading the code, **that overstates one half and understates the other.**

**It is not an arbitrary-URL SSRF primitive.** `UrlReaderPredicateMux.readTree` dispatches only to a
reader whose predicate matches, and every SCM reader's predicate is `url.host === integration.config.host`.
The only catch-all, `FetchUrlReader`, **cannot do `readTree` at all** — it throws
*"FetchUrlReader does not implement readTree"*. So `POST /collections/probe` with
`http://169.254.169.254/latest/meta-data` raises `NotAllowedError` from the mux **before a socket
opens**. This should be stated explicitly, because it is the first thing a security reviewer will
test.

**What it actually is, and this is worse than the doc implies:**

- **A cross-tenant existence oracle** over every host with a configured reader. `byUrl` is useless
  as a guard here: `readGithubIntegrationConfigs` unconditionally appends a default `github.com`
  entry when none is configured, and GitLab and Bitbucket Cloud do the same. So `byUrl` returns
  truthy for **every public GitHub/GitLab/Bitbucket URL on earth**. Any authenticated user can ask
  "does `<private-org>/<private-repo>` exist, and can the server's PAT read it?" — and the reader's
  own error string is returned **verbatim** to them.
- **A quota-burning primitive.** Each cold probe costs 1–2 GitHub API calls plus a **full tarball
  download**, charged to the operator's PAT, with no per-user limit. A dictionary loop over repo
  names saturates a 5000/hr PAT in minutes and takes the catalog down with it.
- **A memory amplifier.** The cache holds 100 entries × `maxBytes` (1 MiB default) = 100 MiB, and
  the probe generates the *whole* OpenCollection document even though the dialog wants only the
  manifest fields. A user can pin 100 MiB of a stranger's collections in the router's LRU.
- **A hardcoded API-base fall-through**, exactly as documented: `scm/github.ts:106-107` falls back
  to `https://api.github.com` when no integration matches. Currently unreachable for a foreign host
  (unknown hosts always cache as `error`, and error entries are excluded from reuse), but it is a
  latent bug that goes live the moment caching changes.
- **The scheme is never validated.** `normalizePathStyleUrl` is `new URL(url.trim())` with no
  protocol check, so `file:`, `ftp:`, `data:` all parse. They die in the mux today.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | Derive the allowlist implicitly from `integrations` + existing `bruno.collections`/`bruno.discovery` | No new config; cannot drift from what the plugin already ingests | **Kills the add-collection flow**, whose entire purpose is scanning a repo not yet declared. Self-defeating |
| **B** | **Explicit `bruno.allowedSources[]` — host + repo-path prefixes, fail-closed** | The only shape that actually closes the oracle; directly testable; composes with rather than duplicates `backend.reading.allow` | Adopter config burden; **breaking** for today's paste-any-URL behaviour |
| **C** | `byUrl` + `https:` + a deny-list of private/link-local literals | Almost no adopter burden; closes the scheme hole | **Does not close the oracle**, which is the actual finding. Only useful as a layer under B |
| **D** | Push it onto Backstage's own `backend.reading.allow` | Zero new surface; a key adopters know | **Factually the wrong lever** — that key feeds only `FetchUrlReader`'s predicate and has no effect on SCM readers |

### Selected: **B, layered over C**

Do the cheap invariants unconditionally — scheme, literal-IP refusal, `byUrl` — then require the
explicit allowlist on the two user-driven routes only. The processor and provider read
config-declared URLs and must **not** be gated: an operator who wrote `bruno.collections[]` has
already consented.

D is recorded because it is the first thing a reviewer suggests, and the reason it fails is precise.

### Implementation

New `service/sourceAllowlist.ts` with `readAllowedSources(config)` and `assertSourceAllowed({url,
integrations, allowed})`, checked in this order before any fetch: URL parses → `https:` (or `http:`
behind an explicit per-host opt-in) → hostname is not an IP literal or `localhost`/
`metadata.google.internal` → `integrations.byUrl` defined → host matches an allowlist entry **and**
a `pathPrefixes` entry is a **whole-segment** prefix of the path (`/acme` must not match
`/acme-legacy`; `posixPath.ts` already has the helpers).

Config `bruno.allowedSources[]` of `{host, pathPrefixes?, allowInsecure?}`, all `@visibility
backend` — the browser must never see the org list. Fix `scm/github.ts:106-107` to throw rather
than default; `checkTreeIdentity` already downgrades throws to `{status:'unknown'}`, so it is safe.

**Rate limiting — mostly "don't write it".** Backstage already installs `createRateLimitMiddleware`
in front of `/api/bruno`, enabled purely by the presence of `backend.rateLimit.plugin.bruno`, and it
supports a **Redis** store, which solves multi-replica correctly and for free. Its limitation is
that it is IP-keyed and plugin-wide.

| | Option | Verdict |
| --- | --- | --- |
| 1 | Document `backend.rateLimit.plugin.bruno`, ship nothing | Multi-replica-correct via Redis; weak against a shared NAT egress |
| 2 | In-memory per-user token bucket keyed on `userEntityRef` | Per-replica, so the effective limit is `N × limit` — weak as a quota, **strong as a floor** |
| 3 | A `bruno_probe_budget` table | Correct across replicas; a DB write on the hot path and a new failure mode, for a control nobody audits |
| 4 | Declare it a reverse-proxy concern | Unenforceable and untestable in the plugin's own tests |

Selected: **1 as the documented production answer, plus 2 as an always-on backstop** — because the
realistic failure mode is an operator who never read the README, and a per-replica limiter
guarantees the hole is not wide open on their instance.

**Tests.** The load-bearing assertion is not the status code but the call count:
`expect(readTree).not.toHaveBeenCalled()`. Cover link-local, `file://`, loopback-to-own-API, an
allowed host with a disallowed owner, an absent allowlist (403 naming the key), and the same set
against `POST /collections` so the guard cannot be bypassed via the create route.

**Breaking.** Ship one release where an empty allowlist warns at startup and permits, then flip to
fail-closed. **Effort: M.** Closable here.

---

## SEC-2 — No authorization (IDOR)

### The gap

Verified route by route. `DELETE /collections/:name` and `DELETE /links` are `allow: ['user']` with
no ownership check, so **any authenticated user deletes any row** — and the collection delete
cascades to its runtime links. `created_by` is recorded and never read.

Two parts of the doc's framing are already discharged and should be closed out rather than left
open: `GET /collections` **does** strip `createdBy` for user principals, and `GET /links` is
`['service']`-only, so `createdBy` never reaches a browser.

**`created_by` is directly comparable**, which is the fact that makes the fix cheap. It is written
from `credentials.principal.userEntityRef`, which is the JWT `sub` = `stringifyEntityRef(entity)`,
lower-cased component by component. `ownershipEntityRefs[0]` is the *same string*. So
`ownershipEntityRefs.includes(row.createdBy)` is sound with **no normalisation** — and a
`parseEntityRef`/`stringifyEntityRef` round-trip "for safety" would be a no-op that invites someone
to "fix" the casing later.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **Basic permissions + a hand-rolled ownership check** | ~80 lines; no resource refs, rules or `getResources`; works with any policy including the shipped allow-all; mirrors `AuthorizedLocationService` exactly | Ownership is hardcoded, so "platform-admins may delete anything" is not expressible in policy without a second permission |
| **B** | Resource permissions via `permissionsRegistry.addResourceType` + an `isCollectionOwner` rule | The correct Backstage idiom; ownership becomes policy, so admins and group-ownership are expressible without touching the plugin | Much more machinery — and **the shipped allow-all policy returns `ALLOW`, so ownership silently stops being enforced by default**. The default posture must be safe |
| **C** | Ownership check only, no permissions | Tiny; closes the actual IDOR | Leaves "any user may create a catalog-visible entity" open — half the finding |
| **D** | Defer to `allowRuntimeWrites` and document "turn it off" | Zero work | The DELETE routes are deliberately **not** gated by that key, so the IDOR survives with it off. A non-answer |

### Selected: **A, shaped so B is a drop-in later**

B's fatal flaw is the default: under the allow-all policy every adopter ships with, a conditional
ownership rule evaluates to `ALLOW` and the hole stays open. A's hardcoded check is safe by default,
which is the property that matters. Put the check behind one `assertOwns(credentials, row)` function
so swapping in `createConditionAuthorizer` later is a one-file change.

**Six permissions, not five.** The doc's list is missing the admin escape hatch. Add
`bruno.collection.delete.any` and `bruno.link.delete.any`, which bypass the ownership check when
`ALLOW` — that gives adopters an admin path without the resource machinery.

**Drop `bruno.collection.read`.** Every read path already resolves through `catalogServiceRef` **with
the requesting user's credentials**, so the catalog's own `catalogEntityReadPermission` governs it.
A second gate would mean an adopter who denies it sees a *blank* Bruno tab on an entity the catalog
happily shows — which reads as a bug — and every conditional catalog policy would have to be
mirrored in a Bruno policy with nothing keeping them in step. Reads are governed by
`catalog.entity.read`; say so in the README.

### Implementation

`src/permissions.ts` exporting the six `createPermission` constants (also consumed by the frontend
and by an adopter's policy). `src/service/authorization.ts` with `requirePermission`, `isAllowed`
and `assertOwns`. Register with `coreServices.permissionsRegistry.addPermissions` — **not** the
deprecated `createPermissionIntegrationRouter`. `RuntimeLinkStore` needs a new `get(collectionRef,
apiRef)`; there is none today, so the delete route cannot read `created_by` before deleting.

All three permission packages are **already installed** transitively at exactly the versions the
1.53.0 manifest pins, `permission.enabled: true` is already set, and `packages/backend` already
registers the allow-all policy module. So this is backwards-compatible by default: the permission
half changes nothing until an adopter writes a policy. **The ownership half is breaking** — a user
who deleted someone else's collection yesterday cannot today. That is the point; it goes in the
release notes.

**Guest-auth caveat, documented not coded:** this app-config enables the guest provider, under which
every guest shares one ref and therefore owns every guest's rows. Ownership enforcement is
meaningless there.

**Effort: M.** Closable here. **Depends on SEC-8** — the ownership check is incorrect until the
case-fold mismatch is fixed.

---

## SEC-3 — The docs CSP and the shared-origin iframe

### The gap

`script-src` permits a bare `https:`, which is barely a CSP at all. The frame is
`sandbox="allow-scripts allow-same-origin"` on the backend origin, which shares Backstage's auth
cookies.

The renderer bundle was **audited, not assumed** — 8.4 MB downloaded and every absolute URL
extracted. `'unsafe-eval'` is genuinely required (`WebAssembly` ×5, `new Function(` ×3, QuickJS
symbols throughout), and blob workers are load-bearing (`URL.createObjectURL` ×5, `new Worker` ×2,
including a PDF.js CDN-wrapper shim). The real origin set is ~20 hosts: the Bruno CDN, pinned
`monaco-editor@0.55.1` plus hls/flv/mux on jsDelivr, dashjs on cdnjs, Google Fonts, and eleven
oEmbed/media frame hosts.

**One correction worth carrying:** `HashRouter` appears **zero** times in the shipped bundle, so the
justification in `docsSession.ts:29-31` for needing a real origin is stale. The sound reason is the
CSP, which the same file also gives.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **Pin the audited origins; keep the shared origin** | One function body; zero adopter config; immediately testable. Removes the `https:` wildcard, which is the part that matters | Does not address cookie adjacency. A compromised CDN still runs script on the backend origin |
| **B** | **Drop `allow-same-origin` from the iframe** | One attribute; severs the origin by construction | Storage loss is safe (all `localStorage`/`sessionStorage` access is `try/catch`-wrapped) but **blob workers are blocked from an opaque origin**, breaking PDF.js and Prism highlighting. Needs a browser trial |
| **C** | Serve docs from a distinct `backend.baseUrl` host | The textbook fix; isolation is structural | Doubles the deployment; the *same* backend still serves `POST /collections`, so unless the plugin is also split this moves the surface rather than isolating it |
| **D** | Nonce-based CSP for the inline boot script | Removes one wildcard; ~10 lines | Cosmetic while `'unsafe-eval'` is required. Polish, not the fix |
| **E** | Subresource Integrity | Pins exact bytes; defeats a CDN content swap | **Impossible against an unversioned URL.** A consequence of SEC-4, not an independent option |

### Selected: **A now, plus D as polish; B trialled in a browser; E the day SEC-4 lands a versioned URL**

C is understood, costed and deferred — recorded because a reviewer will ask. B is cheap and
genuinely better, but must not ship on analysis alone.

Two honest notes: `img-src`/`media-src` **stay `https:`-broad**, because a collection's own
documentation may reference any image and pinning them breaks real content. And the eleven
`frame-src` media hosts are a product decision — if in-portal video embeds are not a requirement,
`frame-src 'none'` drops nine origins.

**Tests.** Assert `script-src` contains no bare `https:` scheme source; assert the CSP is identical
on **every error branch** (the headers-before-any-branch invariant is exactly what a later refactor
breaks); snapshot the full header, because the value *is* the security property.

**Effort: S** for A+D; **S/M** for B including the browser trial. Closable here except C.

---

## SEC-4 — The unpinned staging CDN

### The gap

The URL is a module-private `const` — **not configurable at all**. Measured live: `200`, 8,364,550
bytes, served from S3 behind CloudFront, and **`cache-control: max-age=31536000,public` on an
unversioned path**. That is worse than "unpinned": a one-year immutable directive on a mutable URL
means a browser that fetched the bundle may not see a security fix for a year, and the operator has
no cache-busting lever. SRI is impossible because there is no version or hash in the path.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | Versioned production CDN + baked SRI + a config override | Fixes pinning, caching and SRI together; renderer keeps its own cadence | Work in the **CDN publishing pipeline, not this repo** |
| **B** | Vendor the bundle into the npm package | Air-gap works out of the box; SRI moot | **8.4 MB in the tarball**; pins the renderer to the plugin's release cadence; needs a real **licence audit** (Monaco, Prism, QuickJS, faker…); and it **still** lazy-loads Monaco and fonts at runtime, so it does not actually complete air-gap |
| **C** | Fetch-and-cache at build time | Small repo; self-contained tarball | Network-dependent build; fails reproducibility audits; bakes in whatever staging served that day — the exact problem being fixed |
| **D** | `postinstall` download | Small tarball | Blocked by `--ignore-scripts` and enterprise policy; a supply-chain smell |
| **E** | **`bruno.docs.cdnBaseUrl` + `integrity` config keys** | **~40 lines, lands today**, non-breaking; an air-gapped adopter can mirror two files to their own host | Leaves the default pointing at staging |

### Selected: **E now as the in-repo deliverable; A filed upstream**

B, C and D rejected on size, licence and reproducibility. The design doc's framing — "move to a
versioned production CDN, or self-host" — makes both sound like choices this team can make
unilaterally. **Only the second is, and at a cost that should not be paid.** SEC-4 is therefore
**partially closable here**, and the doc should say so.

E also has a structural payoff beyond air-gap: the same config value feeds the SEC-3 CSP, giving one
source of truth instead of two places to keep in step.

**Effort: S here, L upstream.**

---

## SEC-5 — The playground proxy

### The gap — it does not exist on this branch

There is **no playground, no "try it out", and no proxy routing anywhere** in either plugin.
`proxy.endpoints` in `app-config.yaml` is entirely commented out. `@backstage/plugin-proxy-backend`
is installed and registered but nothing uses it. The code §9.3 describes lives on the
`annotation-flow` branch — `PROXY_HOST_MAP` and its direct-`fetch` fallback are confirmed at source
there, so the doc's account of the two defects is accurate; they are simply not defects in anything
currently shipped.

### Selected: **defer execution; record the design as a precondition** *(product decision, 2026-09-18)*

SEC-5 is not a hole in shipped code — it is a constraint on a feature that has not been rebuilt. Its
correct home is a precondition list for the day the playground returns:

- `proxy.endpoints` is a **backend** key a browser cannot read, so "derive the allowlist from config
  at runtime" means **a backend route that publishes the derived map** — `GET /playground/targets`
  inverting each endpoint's `target` host — not a frontend config read. This is the part most likely
  to be re-implemented wrongly.
- The unmapped-host fallback must become a **refusal with an explanation**, never a silent direct
  fetch. §9.3's "do not ship a playground that silently sends no credentials" applies equally to
  "silently bypasses the proxy".
- Server-side secret injection stays its own design and its own ticket.

**Not closable here, and correctly so.**

---

## SEC-6 — `</script` neutralisation is incomplete: any ingested repo can break the docs page

### The gap — found during this study

`generateOcDocsHtml.ts:44` does `JSON.stringify(yaml).replace(/<(\/script)/gi, '<\\$1')`. The
reasoning in its docblock is right as far as it goes, but `JSON.stringify` does not escape `<!--`.
The HTML script-data tokenizer has a **double-escape state**: a payload containing `<!--` followed
by `<script` puts the tokenizer into *script data double escaped*, where the page's own closing
`</script>` transitions back to *script data escaped* **instead of ending the element**. The rest of
the document is then swallowed as script source and the renderer never boots.

This is **denial-of-rendering, not XSS** — the existing regex does block every `</script`, so the
attacker cannot get back out. But the input is a `.bru` or `opencollection.yaml` file in **any
repository the server ingests**, which under `bruno.discovery` is a very low bar.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | Extend the regex to also catch `<!--` and `<script` | Minimal diff | Three patterns to keep correct; the tokenizer has more states than most reviewers know |
| **B** | **Escape `<` outright as `<`** | The standard serialisation fix; one rule, no state machine to reason about; `<` inside a double-quoted JS literal is a no-op, so the rendered YAML is **byte-identical** | Slightly larger payload |
| **C** | Move the YAML out of the script into a `<script type="application/json">` | No script-data state at all | Still needs escaping for `</script`; a bigger change to the renderer contract |

### Selected: **B**, also escaping ` `/` `

Test with a fixture whose definition contains `<!--<script>alert(1)</script>-->` and assert the
inline boot script is properly terminated. **Effort: S.**

---

## SEC-7 — Log injection on the probe failure path

### The gap — found during this study

`router.ts:265` interpolates the **raw, unnormalised, unvalidated** request body string into a log
message. The probe throws on an unparseable URL *before* normalising, so anything reaches this line,
newlines included, and an authenticated user can forge log lines.

The contrast is instructive: `scm/readTree.ts:53-57` logs only the already-`new URL()`-round-tripped
value and is safe, and the plugin README documents structured-second-argument logging as a
deliberate credential-safety rule. This one site simply missed it.

### Selected: log the URL as a structured second argument

Matching the correct pattern already used elsewhere in the same file. Give the same treatment to the
reader-message echo, which when SEC-1 lands should collapse to a fixed client-facing string with the
detail logged server-side — the *distinguishability* of those messages is what makes the SEC-1
oracle precise. **Effort: S.**

---

## SEC-8 — `getByName` is case-insensitive, `delete` is case-sensitive

### The gap — found during this study

`uiCollectionStore.getByName` uses `whereRaw('lower(name) = ?')`; `delete` uses `.where({ name })`.

Today this is a latent 404 mismatch. **The moment SEC-2's ownership check lands it becomes a
security bug**: the route reads row `Payments` to make the ownership decision and then deletes row
`payments` — a different row, or none.

### Selected: fold `delete` the same way, or delete by the `row.name` already read

Must land **in the same change as SEC-2**, with a test that creates `Payments`, deletes `payments`,
and asserts identical behaviour for both the ownership decision and the delete. **Effort: S.**

---

## SEC-9 — No caps on request-body array lengths

### The gap — found during this study

`readApiRefs` and `readOptionalApiRefs` accept arrays of any length, and `POST /links` passes all of
them to `catalog.getEntitiesByRefs`. The only bound is `express.json()`'s **default 100 kB**, which
caps it at roughly 2,000 refs — an incidental limit, not an intentional one.

### Selected: explicit `express.json({ limit: '64kb' })` and a `MAX_PART_OF` constant

Low severity; the point is to make the bound deliberate and visible. **Effort: S.**

---

## SEC-10 — The docs iframe silently cannot download

### The gap — found during this study

The frame is `sandbox="allow-scripts allow-same-origin"`. The bundle implements "download this YAML"
and attachment download via `URL.createObjectURL` plus a synthetic `<a download>.click()` (found
three times). Sandboxed iframes block downloads without `allow-downloads`, so those renderer
features are **silently dead** in the Backstage embed.

### Selected: add `allow-downloads`, or document the limitation

A product call about whether download belongs in the embed. Note the interaction with SEC-3 option
B: dropping `allow-same-origin` does not affect downloads, but it *would* break the blob workers.
**Effort: S.**

---

## Checked and **not** findings

Recorded so they are not re-investigated, and because a reviewer will ask about each:

- **Path traversal on the docs route.** `namespace`/`name` go to `catalog.getEntityByRef`. No
  filesystem, no string concatenation into a path, no SQL. `..%2F..` simply resolves to nothing →
  the 404 branch, whose message is `escapeHtml`-escaped.
- **CSRF on the DELETE routes.** The credentials barrier accepts a cookie **only** on paths
  registered `user-cookie`, and exactly one path is. Every other route needs a bearer header, which
  a cross-site form cannot attach; the DELETEs additionally omit `allowLimitedAccess`. Note the
  prefix-matching semantics mean a future route added *under* the docs path would silently inherit
  cookie auth — the existing warning comment must survive any refactor.
- **`createdBy` leakage.** Stripped for user principals on `GET /collections`; `GET /links` is
  service-only. Already discharged.
- **Credential isolation.** No route returns a token, no generated HTML contains one, and the
  structured-logging discipline is genuinely followed — apart from SEC-7.

---

## DAT-1 — Secrets in generated docs reach the catalog in plaintext

### The gap

`spec.definition` mirrors Bruno's own "Generate docs" pipeline deliberately, so a collection
documented from Backstage matches one documented from Bruno. That pipeline redacts in exactly one
place: `@usebruno/converters`'s `environment.ts:80-95` emits `secret: true` and **omits the `value`
key entirely** for an environment variable flagged secret. `brunoToOpenCollection` takes one
argument — there is no options object and no redaction hook.

**The severity is real but the surface is narrower than `TECHNICAL-DESIGN.md` §14.1 states.**
`collectionParser.ts:126-131` admits only `basic | bearer | apikey | digest`; `mapAuth` and
`adaptAuthYml` collapse oauth2, awsv4, ntlm and wsse to `{ mode: 'none', unsupportedMode }`, and
`openCollectionExport.ts:160-161` drops anything else. So OAuth2 client secrets, AWS secret access
keys and NTLM/WSSE passwords **never reach `spec.definition` today**. §14.1's field list should be
corrected.

What genuinely reaches the catalog:

| Tier | Emitted key path |
| --- | --- |
| Auth | `items[].http.auth.password` (`basic`, `digest`), `.token` (`bearer`), `.value` (`apikey`), and the same under `items[].graphql.auth.*` |
| Headers | `items[].{http,graphql}.headers[].value` — all of them, `Authorization` included |
| Params | `items[].{http,graphql}.params[].value`, query and path |
| Bodies | `…body.data` for `json`/`text`/`xml`; `…body.data[].value` for `form-urlencoded` and `multipart-form`; `items[].graphql.body.query` |
| Scripts | `items[].runtime.scripts[].code` for `before-request`, `after-response`, `tests` |
| Docs | `items[].docs`, collection `docs.content` |

### Why the previous attempt was reverted — and what it constrains

Commit `9192eaf` removed a redaction pass for four separable reasons, each of which is a constraint
on any future attempt:

1. **Name-matching on strings.** A regex over header and param *names*, fuzzy in both directions:
   `X-Session-Id` redacted, `X-Auth` not.
2. **A sentinel that is a lie.** `REDACTED = '<redacted>'`. The document then asserts that a
   password *is* the literal string `<redacted>`, and the renderer is an opaque CDN bundle that
   renders the lie faithfully.
3. **Entangled with the adapter.** Redaction lived inside `mapAuth`/`mapBody`/`mapRequest`, so
   removing it rewrote 196 lines of one file.
4. **Parity was unreachable.** The knob was `'standard' | 'strict'`, default `'standard'` — and
   `'standard'` already redacted. **No setting matched Bruno.** That is what actually killed it.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **Parity, documented loudly** | Zero divergence; zero code; one behaviour to explain | Leaves the highest-severity finding open. PoC 1's review called plaintext environment values a policy breach (`CMP-3`) |
| **B** | Structural post-pass on the OpenCollection AST, config-gated, parity reachable via `off` | Typed switch on the `type` discriminator, not regex; one new file, no mapper touched; omission keeps the document schema-valid | A deliberate divergence from Bruno that must be documented and explained |
| **C** | Redact in the `NormalizedCollection` pre-pass | Also covers non-docs consumers | Does **not** protect fields added to the model later — the exact failure mode to design against |
| **D** | Refuse to store a definition when a credential is detected | Fails safe | Needs the same detection to decide; disables docs precisely on the collections that need them |

### Selected: **A — parity, documented loudly** *(product decision, 2026-09-18)*

Engineering's recommendation was **B** with `redact: 'off' | 'credentials' | 'strict'` defaulting to
`'credentials'`, on the grounds that the reachable set is four enumerable keys, that omitting a key
(rather than substituting a sentinel) leaves a valid OpenCollection document, and that an explicit
`off` makes byte-parity reachable — the property whose absence killed `9192eaf`.

**That recommendation was not taken.** Parity with Bruno is a product promise, not an implementation
detail, and a second behaviour to explain was judged worse than a documented risk. Recorded here so
the reasoning is not rediscovered: if an enterprise security review later blocks adoption, **B is
the pre-designed answer** and the four constraints above are what it must satisfy.

### Implementation

Documentation only, in three places, each stating the same thing without hedging: **a credential
hardcoded in a `.bru` file reaches the catalog in plaintext, where the audience is anything that can
read the catalog rather than one signed-in user entitled to one collection.**

- `plugins/bruno-backend/README.md` — a dedicated section, not a footnote, with the field table above.
- Root `README.md` — one paragraph in the install flow, before an operator points the plugin at a repo.
- `docs/TECHNICAL-DESIGN.md` §14.1 — correct the field list; oauth2/awsv4/ntlm/wsse are dropped at
  parse time and do not reach the catalog.

Two adjacent **bugs** fixed regardless of the parity decision, because neither is a policy choice:

- `openCollectionExport.ts:113` forces `type: 'text'` on every multipart entry, so a `file`-typed
  field's **local filesystem path** is emitted mislabelled as text — disclosing the author's machine
  layout and evading any `type === 'file'` check.
- `mapEnv` passes the plaintext `value` into the converter even for `secret: true` variables, relying
  entirely on the converter to drop it. Correct today; a silent plaintext leak the day the converter
  changes. Strip it on our side of the boundary.

Also stale: `manifestProbe.ts:92` still documents `definition` as *"redacted per
`bruno.definition.redaction`"*, a config key that no longer exists.

**Effort: S.** Closable here.

---

## DAT-2 — Byte-stability is not enforced, and two real defects threaten it

### The gap

Backstage's `DefaultCatalogProcessingEngine` hashes the processed entity and skips the write when
the hash is unchanged. `stableStringify` sorts **object keys** but preserves **array order**. So
`spec.environments` array order is load-bearing, and `spec.definition` is one string whose bytes
matter exactly. If either moves, every Bruno entity is rewritten and re-stitched every 100-150
seconds, forever, invisibly.

**There is no automated byte-stability test.** What §14.2 calls "the etag test" is a manual
boot-check in `docs/execution/BE-P2-plan.md` — record `metadata.etag`, wait ~6 minutes, re-read,
compare. That plan also states *"No tests are added; `yarn test` is not a gate"*. And there is no CI
to put a test into (see REL-4).

Three sources of nondeterminism were audited. Most of the pipeline is clean: archive order is
`selected.sort()` in `treeFilter.ts`, the converter has no `Date.now`/`Math.random`/`uuid` on the
export path, and `js-yaml` runs with `sortKeys: false, lineWidth: -1, noRefs: true`. But two defects
are real:

1. **`localeCompare` on environment names** — `collectionParser.ts` sorts environments with
   `a.name.localeCompare(b.name)` at two sites. This is locale- and ICU-dependent: collation differs
   across ICU versions and between full-icu and small-icu Node builds. Two replicas on different
   Node patch versions, or a rolling deploy, order environments differently — moving both the array
   and the YAML bytes. **This is the live instance of R8**, and the codebase already shows the right
   discipline elsewhere (`uiCollectionStore.ts` uses an explicit `toLocaleLowerCase('en-US')`).
2. **`exportedAt` defaults to `new Date().toISOString()`.** Harmless today because the only caller
   passes `exportedAt: null` — but a default-on timestamp footgun pointed at the catalog, whose
   justifying call sites were deleted with the old connection-store backend.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | Unit test: generate twice, assert identical | Fast, hermetic | Proves determinism *within one process*. Misses `localeCompare` entirely — same locale on both runs |
| **B** | **A + golden file + fix the two defects** | Golden file catches *unintended* byte changes from dependency bumps, which is the real regression risk; the fixes remove the cross-process hazard A cannot see | Golden file needs deliberate updating |
| **C** | Integration test against a real catalog asserting `resultHash` stable across runs | Tests the actual property | `@backstage/plugin-catalog-backend` publishes no test harness at 1.53; slow; flake-prone |
| **D** | Keep the manual boot check, write a runbook | Zero cost | Already unrun, therefore already unenforced |

### Selected: **B**

A alone would have passed while the `localeCompare` bug shipped — which is the whole argument. The
golden file is what makes a converter upgrade visible instead of silent. C is not available at this
version and is the wrong altitude anyway; the end-to-end property is better served by the Playwright
path (REL-1).

### Implementation

- Replace both `localeCompare` sites with a code-unit comparison, matching `treeFilter.ts`.
- Invert `exportedAt` to opt-in, so forgetting a parameter cannot reintroduce churn.
- Create a fixture collection (none exists — `find -name '*.bru'` returns zero) exercising
  multiple environments whose names sort differently under different locales, requests across
  folders, headers, params, a JSON body and a script.
- `definitionBuilder.test.ts` asserting: two generations byte-identical (`toBe`); output matches a
  committed golden; no `exportedAt`; the comparator orders accented and mixed-case names to an exact
  expected sequence (the regression test for defect 1); and shuffled input insertion order produces
  identical bytes.

The test rides the ordinary `test` CI job. It must **not** be relegated to nightly — its failure mode
is invisible in production and loud in a unit test, which is exactly backwards from where it would
get attention.

**Effort: S.** Closable here.

---

## DAT-3 — No database migrations

### The gap

Both stores create tables on first boot with `hasTable`-guarded DDL, plus one add-column-if-missing
for `title`. `uiCollectionStore.ts:118-122` names the trigger precisely: *"A third widening is the
point at which this should become a real migration."* After v1 there is no safe way to evolve the
schema.

The upstream convention, verified against five installed Backstage plugins: a `migrations/`
directory at the **published package root, sibling to `dist/`**; filenames
`YYYYMMDDHHMMSS_snake_name.js`, plain CommonJS, never TypeScript; `exports.up` / `exports.down`
taking a Knex handle. The dist-path trap is solved upstream by
`resolvePackagePath('<pkg>', 'migrations')` — exported by `@backstage/backend-plugin-api` and
implemented as `path.resolve(require.resolve(\`${name}/package.json\`), '..', ...paths)`, so it
resolves the package root identically from source and from a published tarball. Two requirements
follow: `"./package.json": "./package.json"` must be in the `exports` map, and `migrations` must be
in `files` (ours is `["dist"]` today).

On `tableName`: catalog, scaffolder, auth, search and user-settings all **omit** it and take Knex's
default. Only the two core *services* set one, because they run inside someone else's plugin
database. The `bruno` plugin owns `backstage_plugin_bruno`, so omit it and match the catalog.

Backstage never runs migrations for you — `DatabaseManager` contains no `migrate` call. Every plugin
runs its own, guarded by `if (!database.migrations?.skip)`.

### Options — the baseline problem

`knex.migrate.latest` has no record of the `hasTable` DDL, so migration #1 runs against databases
that already have the tables.

| | Baseline | Pros | Cons |
| --- | --- | --- | --- |
| **A** | Non-idempotent `_init.js`, pure `createTable`, exactly like upstream | Cleanest to read; matches convention | **Crashes on every existing database.** Only safe with a declared hard reset |
| **B** | **Idempotent baseline** — guard each `createTable` with `hasTable`, each column with `hasColumn`, reproducing today's shape including `title` | Works on fresh *and* existing databases; no adopter action; migration #2 onward can be plain | Baseline is uglier than upstream's; a one-off deviation needing a comment |
| **C** | Ship A plus a documented `knex_migrations` seed row | Clean baseline | Asks an operator to run manual SQL against a production database |
| **D** | Declare a reset; drop both tables | Simplest code | Destroys UI-created collections and runtime links |

### Selected: **B**

The only option with no adopter action and no data loss. The ugliness is confined to one file that
is written once and never edited.

### Implementation

- `plugins/bruno-backend/migrations/<ts>_init.js` reproducing exactly the shape the two stores
  create today, including the `collection_ref` index; `down` drops both tables.
- `src/store/migrations.ts` exporting `applyDatabaseMigrations(db)` using `resolvePackagePath`,
  guarded by `db.migrations?.skip`. Called once in `plugin.ts` **before** the stores are created;
  both stores then drop their DDL blocks and become pure data access.
- `package.json`: `files: ["dist", "migrations"]`.
- **Keep `part_of` as `text`, not `json`.** The reasoning currently in `uiCollectionStore.ts:58-78`
  moves into a comment in the migration file, because the migration is now the authoritative schema
  and is where someone will be tempted to "improve" it to `table.json()`. Enforce it with a test
  asserting `typeof row.part_of === 'string'` after round-trip, run under both dialects (DAT-4) —
  the check the design doc says has never been possible to run on both sides at once.

Tests: fresh migrate creates both tables and the index; `latest()` twice is idempotent; `latest()`
against a database pre-created by today's DDL succeeds with zero data loss (the whole point of B);
`up` → `down` → `up`.

**Effort: M.** Closable here. Must land **before** DAT-4, so the Postgres work exercises migrations
rather than DDL that is about to be deleted.

---

## DAT-4 — Postgres never exercised

### The gap

Dev is `better-sqlite3` on `:memory:`. `app-config.production.yaml` **already carries a complete
`client: pg` block**, and `pg@^8.11.3` is **already a dependency**. The README caveat §14.9 asks for
**already exists** in both the root and plugin READMEs — the residual gap is only that neither says
Postgres is *unverified*, and that nothing tests it.

`@backstage/backend-test-utils` is **not installed** here (it appears in `yarn.lock` only as an
optional peer). It provides `TestDatabases.create({ids, disableDocker})`, `.init(id)` and
`.eachSupportedId()`, shaped for `describe.each`. Postgres runs via testcontainers.

**The gotcha that decides the design:** `isDockerDisabledForTests()` returns true whenever `CI` is
unset. So on a laptop `TestDatabases.create()` yields `SQLITE_3` only, and the identical test file
transparently gains Postgres in CI. There is no skip logic to write — `eachSupportedId()` simply
never generates unsupported cases.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **`TestDatabases` + `eachSupportedId()` Jest tests** | Automatable, and zero-friction locally by construction; runs the *same* assertions on both dialects — precisely what the `part_of` decision has never had | Adds a devDependency; Postgres needs Docker; CI job is slower |
| **B** | `docker-compose.yml` + a scripted full-backend boot | Exercises the real backend end to end | A second harness; brittle; asserts "it booted", not "read-back is byte-identical" |
| **C** | Documented-manual runbook | Zero infra | Unenforced — the same failure as DAT-2's boot check |
| **D** | **A + a thin compose file for manual exploration** | Automated regression *and* a way to click around against Postgres | Two artefacts, but they serve different audiences |

### Selected: **D**, with A as the load-bearing half

A is the only option that automates, and the only one that can assert the property §4 actually rests
on: the same store code reads back **byte-identical** values on better-sqlite3 and on Postgres.

### Implementation

Add `@backstage/backend-test-utils` as a devDependency of `plugins/bruno-backend`. A
`stores.integration.test.ts` using `describe.each(databases.eachSupportedId())` covering: `part_of`
string-typed read-back on both dialects; the case-insensitive `whereRaw('lower(name) = ?')` path;
duplicate-insert → `ConflictError` on both; the composite-PK conflict in `runtimeLinkStore`; and
DAT-3's migration idempotence. Pin the matrix to `['SQLITE_3', 'POSTGRES_16']` to keep the job
bounded. Amend both README caveats to say Postgres is the supported production configuration and is
now covered by tests.

**Effort: M.** Closable here; depends on DAT-3.

---

## DAT-5 — Multi-replica behaviour

### The gap — smaller than documented

**`scope: 'global'` is already in force.** `backend-plugin-api` documents `@defaultValue 'global'`
and `PluginTaskSchedulerImpl` applies `task.scope ?? 'global'`; `readSchedule` omits `scope`, so the
correct behaviour is inherited. §14.3's "the provider's scheduled task must be `scope: 'global'`"
is **already satisfied** and should move from "to verify" to "verified". `'global'` requires a shared
database, which it has: the module registers under `pluginId: 'catalog'`, so the lock lives in the
catalog's database.

`initialDelay` is explicitly per-worker and documented as *"not useful for globally pausing work"*,
so the existing 3-second delay is correct and harmless. `ManifestProbe.evict` being unwired is a
**correct call, not a gap**.

The genuine residual risk is narrower: 2N in-process caches (two probes per process, capped at 100
entries each) all revalidating, unmeasured; and nothing *asserts* the global scope, so an edit adding
`scope: 'local'` would be invisible.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **Set `scope: 'global'` explicitly + a test** | Turns an inherited default into a stated invariant with a regression guard; ~4 lines | Behaviour-neutral today — buys documentation and a test, not a fix |
| **B** | A + make the probe cache bound configurable and log miss rate | Makes the 2N cost measurable | New config surface for a cost not yet shown to exist |
| **C** | Two-replica manual verification against one Postgres | Actually exercises the untested claim | Manual, slow, needs DAT-4 first |
| **D** | Share the cache via `coreServices.cache` | Collapses 2N→1, unblocks `evict` | Large; changes the probe's whole shape to solve an unmeasured cost. Premature |

### Selected: **A now, C as a Beta gate, D explicitly deferred**

### Implementation

Set `scope: 'global'` explicitly in `readSchedule` with a one-line docblock on why per-replica would
be wrong, plus `schedule.test.ts` asserting it. Add the two-replica count to the runbook beside the
etag boot-check. Correct §14.3.

**Effort: S.** Closable here.

---

## DAT-6 — Divergences from Bruno's own exporter

### The gap

§14.8 lists them loosely. The verified list of what the converter **can** emit but this repo's model
cannot reach: collection- and folder-level `request.{headers,auth,scripts,variables}`;
`config.{protobuf,proxy,clientCertificates}`; `items[].examples[]`; `info.tags`; `runtime.variables`,
`runtime.actions`, `runtime.assertions` (parsed, then dropped); grpc/websocket/js items; body modes
`sparql` and `file`; graphql `body.variables`; environment `color`.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | README table only | Free; honest | Drifts silently the moment the model widens |
| **B** | **README table + the golden file as a conformance pin** | The list cannot go stale unnoticed — a widening changes the golden, and the diff forces the table to be updated in the same commit | Needs the DAT-2 fixture, which DAT-2 creates anyway |
| **C** | Close the gap — widen `NormalizedCollection` toward parity | Real parity | **L**, and it re-opens every secret carrier currently out of reach |
| **D** | Drop the parity goal | Removes the constraint that killed `9192eaf` | Throws away a genuine product property |

### Selected: **B**

The value is stopping the list from rotting, for near-zero marginal cost over DAT-2.

**The architectural note that matters for the roadmap: C is a security change disguised as a
fidelity change.** Every row in the "not reachable" column is also a row in DAT-1's untouchable-secret
column — proxy passwords, certificate passphrases, OAuth2 client secrets. Given DAT-1 is settled as
parity-with-documentation rather than redaction, **C must not be undertaken without revisiting
DAT-1**, because it widens the plaintext surface that decision was taken against.

**Effort: S.** Closable here.

---

## DAT-7 — Entity size at scale

### The gap

§18.7 asks about 500 collections × 1 MiB. Real measurements already exist in
`docs/execution/BE-P2-plan.md`: existing `kind: API` entities with inline OpenAPI run 5-22 KB, and a
4-request Bruno collection with 2 environments is 13,231 bytes — **~3 KB per request**. At that rate
the 1 MiB cap is roughly **350 requests in one collection**, well above anything typical, and
500 × ~30 KB ≈ **15 MB** is the realistic steady state rather than 500 MB.

The amplification factor is **2×, not 3×**: the catalog stores `refresh_state.unprocessed_entity`,
`refresh_state.processed_entity` and `final_entities.final_entity`, but the provider emits no
`spec.definition`, so the unprocessed copy carries none.

Heap is the term nobody had written down: two probes per process × 100 cache entries × `maxBytes`
= **200 MiB per replica worst case** at the 1 MiB cap. The cap bounds heap, not just row size — which
is the strongest argument for keeping it at 1 MiB and is not obvious from its name.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **Publish the capacity model; no measurement** | Free; already most of the decision-relevant information | Models storage growth but not stitcher CPU or `getEntities` latency |
| **B** | Synthetic load test: seed N entities, measure bytes, heap, latency | Measures the real thing on the real engine; settles §4 | Needs a scratch harness and DAT-4's Postgres; a day |
| **C** | Lower the default `maxBytes` | Cheap risk reduction | Picks a number with no data — the thing DAT-7 exists to avoid |
| **D** | Reverse §4; move the definition off the entity | Removes the ceiling | Reintroduces PoC 1's split read model, the problem §4 exists to solve |

### Selected: **A now, B before Beta**

State the go/no-go criterion **before** measuring: if 500 realistic collections cost more per entity
than the existing `kind: API` entities do, §4's inline-definition decision needs revisiting; if not,
§18.7 closes.

**Effort: S for A, M for B** (B gated on DAT-4).

---

## SCM-1 — Org-wide discovery is GitHub-only

### The gap

The seam is already clean: `githubDiscovery.ts`'s orchestration contains **no GitHub-specific logic
at all** once the truncation warning is removed, and URL composition already goes through
`providers.byUrl(...)`, so GitLab's `-/tree` and Bitbucket's `/src` grammars are handled. What is
GitHub-specific is the three-method client and two field names.

**Measured on gitlab.com, 2026-09-17:** a recursive tree on an 89,452-entry repo paginates
(`x-total`, `x-total-pages`, `Link rel="next"`) rather than truncating, and a URL-encoded project
path (`gitlab-org%2Fgitlab-foss`) works directly as `:id` with no prior lookup.

### Options

| | Approach | Maintenance | Silent-wrong risk |
| --- | --- | --- | --- |
| **A** | **Generalise `DiscoveryClient`; one client per provider; shared orchestration** | ~200 lines per provider, low churn | Low — orchestration is already tested; only the client is new |
| **B** | A separate `createGitlabCollectionDiscovery` alongside the GitHub one | **High** — the cache/claim/throw-vs-skip logic gets a second copy and the two will drift | **High** — divergent deletion semantics is exactly the bug that deletes entities |
| **C** | Keep GitHub-only; require `bruno.collections[]` elsewhere | Zero | None, but it defeats "org-wide" |
| **D** | GitLab group-level blob search instead of tree walks | Low | **High — index lag.** A collection pushed an hour ago is invisible. This is the same objection §6 raises against GitHub code search |

### Selected: **A**

B is the one to actively avoid, and the reason is specific. The logic worth protecting is not the
API calls — it is `discover()`'s **failure semantics**: a transient tree failure keeps the cached
collections; a failure on a repo never swept *in this process* skips it; a failure on an entry's
**first** sweep throws so the provider skips the tick entirely rather than applying a `full`
mutation that reads as "these collections are gone". That ladder is what stands between a network
blip and mass entity deletion, and a second hand-maintained copy is how it gets lost.

D is recorded with an explicit rejection for the same reason §6 rejects code search: "silently lags
source control" is a worse failure than "costs a tree call".

### Implementation — three contract changes, each load-bearing

- **`truncated: boolean` → `complete: boolean`.** "Truncated" is GitHub's word for its own failure
  mode; GitLab's equivalent is "I stopped paging". One flag, inverted so the safe default is explicit.
- **`listTree`/`readTextFile` take the whole `DiscoveryRepo`, not `{owner, repo}`.** GitLab addresses
  a project by URL-encoded `path_with_namespace`, which cannot be reliably recombined from
  `owner`/`name` when the namespace is nested.
- **`pushedAt` → `changeToken`**, an opaque token compared for equality only. GitLab's
  `last_activity_at` is **not** a `pushed_at` equivalent — it updates at most once per hour and
  tracks general project activity, so it both over-triggers and lags a push by up to an hour.

That last point creates the one real asymmetry: GitHub and Bitbucket get their change token free in
the listing; GitLab's reliable token is the default branch's head sha, one extra call per repo per
tick. **Mitigation:** `GET /groups/:id/projects` supports `order_by=last_activity_at`, so use it as
a **coarse prefilter** — skip the sha check for projects whose `last_activity_at` has not moved.
`last_activity_at` never fails to *eventually* move after a push, so this cannot under-invalidate;
it only delays by up to an hour, the same order as the existing `frequencySeconds` tolerance.

### Naming — the compatibility trap, and why the rule must not change globally

`metadata.name` is frozen before any processor runs. If `acme/payments` currently discovers as
`payments` and a new rule makes it `acme-payments`, the old entity is **not renamed** — it is
deleted by the next `full` mutation's set difference and a new one appears. Every `spec.partOf`
reference, every bookmark and every dashboard link to the old ref breaks silently, with no repair
path. Names are also clamped to 63 characters, so a namespace-qualified name in a deep group tree
can truncate into a *different* collision than the one it was introduced to fix.

The current rule qualifies by repository name only, so two GitHub orgs that each have a `payments`
repo **already** collide today; the claim guard resolves it by skipping the loser. GitLab makes that
the normal case rather than the rare one.

**Selected: make naming a per-provider function and leave GitHub's byte-identical.** GitLab gets
qualification by the *last* namespace segment (`platform/payments` → `platform-payments`) — not the
full group path, which would blow the 63-char clamp and encode organisational structure into a
frozen identity, so a group rename would orphan the entity. This is safe precisely because **there
are no GitLab-discovered entities today**; taking the opportunity now is the only time it is free.
The residual GitHub cross-org collision stays documented and claim-guarded — fixing it would cost
exactly what we just refused to pay.

Add a test asserting `discoveredCollectionName('payments', '') === 'payments'` **whose stated
purpose is to fail if anyone changes the GitHub rule.**

**Effort: M.** Closable here. Bitbucket Cloud discovery is a further S–M once the seam exists.

---

## SCM-2 — Pull requests are GitHub-only

### The gap

Narrower than it looks. The GitHub coupling is four Octokit call sites; the plan/submit split, the
stage machine, the method chooser and — most importantly — the YAML edit are all provider-neutral.
The YAML edit is the valuable part and is entirely reusable: it operates on a string via `yaml`'s
`parseDocument` to preserve comments, which is why `js-yaml` is not used here. The per-provider work
is a **~120-line adapter**.

### Delegating to the scaffolder is eliminated, not merely rejected

Only the GitHub scaffolder module is installed, but the missing dependency is not the blocker. All
three write modules are **backend scaffolder actions**. The Bruno PR flow runs **in the browser, on
the user's own `scmAuth` token**, and the codebase records that as a structural decision: the user's
SCM token is used in exactly one place, and those writes "must be attributed to them". Delegating
means moving the write to the backend, which means either every PR is authored by a bot or the
user's token is forwarded to our backend — which the codebase explicitly refuses. **Option (b) costs
the attribution property.**

### Options

| | Approach | Cost | Risk |
| --- | --- | --- | --- |
| **A** | Per-provider adapters behind a `PrAdapter` interface | GitLab S, Bitbucket Cloud S–M | Low — the YAML edit, diff preview and stage machine are shared; only transport differs |
| **B** | Delegate to scaffolder modules | — | **Eliminated** — backend-only, breaks user attribution |
| **C** | Generic "here is the YAML and the path, copy it" fallback for every unsupported host | ~0 | None, but it is not a feature |
| **D** | A *backend* PR route using `integrations.*` host credentials | M | **High** — every PR authored by the service account. The audit trail says "backstage-bot" for a change a human made, and the backend gains a write credential it does not currently have |

### Selected: **C first as the permanent floor, then A for GitLab, then A for Bitbucket Cloud**

C is not an alternative to A — it is the backstop that should exist regardless, and it partly exists
already on the add-collection side. The link/unlink side has no equivalent: today a GitLab user is
told to hand-edit a `spec.partOf` list. Because `addPartOf`/`removePartOf` are **pure string
functions needing no token**, rendering the computed `after` YAML with a copy button and the exact
repo-relative path is most of A's value for a fraction of the cost — and it works on every host
including Gerrit and Harness. That makes A a strict upgrade rather than a gate.

D is named and rejected in the doc so it is not re-proposed: it is genuinely less work, and it is
wrong for one reason that outweighs that.

### Implementation

A `PrAdapter` interface whose one earned abstraction is `concurrencyToken` — GitHub blob `sha`,
GitLab `last_commit_id`, Bitbucket `parents` sha. All three mean "fail if this moved under me", all
three are opaque strings, and `undefined` means "create, do not update".

Verified call sequences: **GitLab is two calls, not four** — `POST /repository/commits` with
`start_branch` creates the branch as part of the commit. **Bitbucket Cloud is also two** —
`POST /src` with `branch=` creates the branch, and `parents=<base sha>` returns 409 if the tip moved,
a cleaner guard than GitHub's.

Adopter prerequisites, which belong in the README: `ScmAuth.forGitlab`'s stock `repoWrite` already
includes `api`, so **gitlab.com needs no app change**. Bitbucket does: this app sets `repoWrite: []`,
and even `ScmAuth`'s **stock** `forBitbucket` omits `repository:write`, so an adopter following the
Backstage default hits a permission error when committing a file.

**Effort:** fallback UI S; GitLab S; Bitbucket Cloud S–M; the `PrAdapter` refactor M. Closable here.

---

## SCM-3 — Tier-1 revalidation is GitHub-only

### The gap — and §5's stated reasoning is wrong

`TECHNICAL-DESIGN.md` §5 says GitLab and Bitbucket "would spend the same quota the sha-compare
already spends, **for no gain**". Both halves were measured on 2026-09-17 and both are wrong.

**GitHub baseline confirmed, and now doc-backed.** GitHub's own REST best-practices page states that
a conditional request returning 304 does not count against the primary rate limit *when correctly
authorized* — corroborating the module's measurement and its authenticated-only caveat.

**GitLab: the mechanism exists; a 304 is genuinely not free; but there is real gain.** Weak ETags
are returned on `/api/v4` and replaying `If-None-Match` returns 304 — with `ratelimit-remaining`
decrementing by exactly 1 each time, monotonically. No free path. *But* `GitlabUrlReader.readTree`
spends **two** calls before it can compare — a project lookup issued unconditionally even when the
URL carries an explicit ref, then the commits call — and the project lookup is unnecessary because
the API accepts the encoded path as `:id`. So tier-1 is **1 call instead of 2: a 50% cut**, which
matters more on gitlab.com's 100-req/**minute** burst limit than the same ratio would on GitHub.

*Caveat to record:* GitLab's docs never mention ETag or 304 anywhere on `/api/v4`. These 304s come
from generic Rails middleware, not a documented contract. **Behaviour, not a promise.**

**Bitbucket Cloud: the claim is refuted — tier-1 is worth *more* here than on GitHub.** The commits
endpoint returns a strong ETag, honours `If-None-Match` with a 304, and **genuinely honours
`path=`** (verified: different shas for different paths; an empty array for a nonexistent one, which
maps cleanly onto the existing `unknown` branch). The 304 quota cost could not be measured — the
anonymous counter is jittery because it is shared per-IP across edge nodes — and the widely-repeated
"Bitbucket 304s are free" claim has **no Atlassian source**, so budget as if it costs one.

Even so, tier-1 wins bigger there, for a reason §5 missed. Tier-2 on Bitbucket Cloud uses a
**whole-repo** sha and downloads a **whole-repo** tarball, trimming the subpath client-side. So for a
collection in a monorepo, **any push anywhere in the repo forces a full-repo download.** A
path-scoped tier-1 skips that entirely.

| | GitHub | GitLab | Bitbucket Cloud |
| --- | --- | --- | --- |
| tier-2 calls before compare | 1 (2 w/o ref) | **2** | 1 (2 w/o ref) |
| tier-2 sha scope | whole repo | **subpath** | whole repo |
| tier-2 archive scope | whole repo | **subpath** | **whole repo** |
| tier-1 quota on 304 | **free** (authenticated) | 1 unit | unknown, assume 1 |
| tier-1 marginal gain | quota → 0, plus path scoping | 2 calls → 1 | **path scoping, which tier-2 lacks entirely** |

### Options

| | Approach | Risk |
| --- | --- | --- |
| **A** | Leave tier-1 GitHub-only; correct §5's reasoning | None |
| **B** | **Add tier-1 for Bitbucket Cloud only** | Low — `checkTreeIdentity` is optional and total; any failure reports `unknown` and falls through |
| **C** | B plus GitLab | Low, same reason |
| **D** | Add it everywhere **and rely on 304s being free** | **High** — both providers' 304s are undocumented emergent behaviour |

### Selected: **B now, C opportunistically, and correct §5 either way**

The payoff on Bitbucket is bandwidth and latency on monorepos rather than quota. D is the trap:
neither vendor promises conditional-request support. The existing design — optional, total, falling
through to the read that would have happened anyway — is exactly the right shape for depending on
behaviour that might vanish, and neither B nor C changes that property.

**The doc edit is the deliverable even if no code is written.**

**Effort: S each.** Closable here. The §5 correction is XS and should happen regardless.

---

## SCM-4 — Support-matrix holes

### The gap — §5 overstates the Bitbucket Server blocker

§5 says Bitbucket Server has "no adapter — ref lives in the query string". The ref genuinely does,
and `normalizePathStyleUrl` does delete it — but that is **not** an interface problem.
`normalizeUrl` is *already* a per-provider member precisely so a query-string grammar can keep its
query string.

Verified: `git-url-parse` — the parser every Backstage UrlReader uses — handles Bitbucket Server
URLs correctly today, extracting owner, name, ref and filepath from both `?at=main` and
`?at=refs%2Fheads%2Fmain`. `BitbucketServerUrlReader.readTree` is fully functional and its download
URL is **path-scoped**. `getBitbucketServerDefaultBranch` exists. The credential shape is the
simplest of any provider.

**So reads would work today if the seam had an adapter.** Every interface member maps cleanly, and
Bitbucket Server is in fact the *only* provider whose grammar can represent a slash-bearing ref like
`release/1.x` — so its `composeCollectionUrl` simply must not call `assertSingleSegmentRef`. That is
an argument **for** the seam, not against it.

The real cost is on the frontend: `scmUrl.ts` is shape-based, taking `seg.slice(0, 2)` for
everything non-GitLab and requiring a known view segment at index 2, so both helpers return wrong
answers for `/projects/K/repos/s/browse/...`. And `scmProviders.ts` conflates Bitbucket Cloud with
Server under one id.

### Options

| | Approach | Risk |
| --- | --- | --- |
| **A** | "Reader-level only, documented" for everything non-GitHub/GitLab/BB-Cloud | None — **but the README must be honest that `bruno.collections[]` on those hosts will fail**, because the registry falls through to the GitHub adapter and parses the URL wrongly |
| **B** | **Bitbucket Server backend adapter only** — reads and `bruno.collections[]`, no discovery, no PRs | Low; the pieces are verified to work |
| **C** | B plus the frontend `scmUrl`/`scmProviders` generalisation | Medium — touches the helper that decides **where a generated descriptor is committed** |
| **D** | Full Bitbucket Server parity | High for v1 |

### Selected: **B for v1; C when a Bitbucket Server adopter appears; fix A's honesty gap now**

§5's wording reads as "this is blocked", which will stop someone from picking it up. It is
**unscheduled work, not blocked work** — roughly 150 lines plus the frontend helpers.

**The urgent part regardless of B** is A's honesty gap. The registry returns the **GitHub** adapter
for any unknown host. For Azure and Bitbucket Server that is worse than it sounds:
`normalizePathStyleUrl` will have **deleted the ref** before the reader sees it, so the error is
about a path that does not exist rather than about an unsupported provider. A three-line guard —
throw a named error when `integrations.byUrl(url)?.type` is known-but-unimplemented — turns a
confusing failure into an actionable one and costs nothing.

Azure stays reader-level: it puts both path and ref in the query string, its reader derives the
subpath from only the **last segment** of `path`, and it unpacks a zip rather than a tar. Gitea would
be the cheapest possible addition — path-style grammar, working reader — but nobody has asked.

The subtle part of B is `normalizeUrl` canonicalising `refs/heads/main` and `main` to one form:
without it, the same collection pasted from two different Bitbucket screens becomes two entities
with two cache entries — exactly the class of bug the "must be idempotent" contract exists to
prevent.

**Effort:** the unimplemented-provider guard XS *(do now)*; B S–M; C M.

---

## SCM-5 / FE-6 — Tree truncation never reaches a user

### The gap

Truncation is detected and `logger.warn`'d with the repository name, then **discarded** — the return
type has no room for it. Nobody reads backend logs for a plugin they are evaluating.

### Why an annotation is the wrong channel — two reasons, not one

The standing rule is never to gate a UI surface on an annotation, because processing stamps them
minutes late. Here there is a second and more decisive reason: **a truncation is a property of a
repository, and the collections it would have produced do not exist as entities.** There is nothing
to annotate. Annotating the collections that *were* found would be backwards — it marks the ones
that worked.

### Options

| | Approach | Reaches the user? | Cost |
| --- | --- | --- | --- |
| **A** | Status quo, `logger.warn` only | No | 0 |
| **B** | Annotation on discovered entities in the affected repo | Minutes late | **Wrong** — violates the annotation rule, and marks the wrong entities |
| **C** | **`SweepReport.incomplete` → a `GET /discovery/status` route → a dashboard strip** | Within one tick | S–M |
| **D** | C plus a `kind: Location` "problem" entity | Yes, and in catalog errors | The plugin starts declaring entities that are not collections — new surface, new deletion semantics, for a report |

### Selected: **C**

There is an exact precedent to copy: the existing pending-collections strip polls a backend route,
**renders nothing in the normal case** ("a report of an unusual transient state, not furniture"),
resolves its APIs through `useApiHolder` so a missing registration costs only the strip, and renders
nothing on a read failure.

**One caveat to build in:** truncation is **persistent**, not transient. The pending strip polls
until nothing is pending and then stops; a truncated repo stays truncated until someone splits it or
edits config, so a copied fast poll would hold a timer forever on every dashboard. Fetch once per
mount and on the provider-tick interval only.

**What the strip says matters.** Not "truncated" — that is GitHub's word for its own API limit and
means nothing to the reader. Say what was lost, what to do, and **how many collections *were* found
in that repository** — that last number is what tells an operator whether they are missing one
collection or fifty, which decides whether they care at all.

**Keep `incomplete` strictly separate from failure.** A repo that could not be read at all still
follows the existing cached/skip/throw ladder. `incomplete` means "I read it and the answer was
knowably partial" — a different fact that must not be conflated with "I could not read it".

A useful follow-on the same route enables free: `sweptAt` plus per-entry found counts answers "is
discovery even running?", which today requires reading a log line.

**Effort: S–M.** Closable here. The GitLab equivalent drops straight into the same structure once
SCM-1 lands — **a reason to do this before SCM-1 rather than after.**

---

## SCM-6 — Credential-shape traps

### The gap

All six documented traps were re-verified against the installed `@backstage/integration@2.0.3`.
**All six hold.** Two need a sharper statement:

- **Bitbucket Cloud's bare `token` is worse than documented.** Config validation does **not** catch
  it — validation throws only for the *mirror* case, `username` without a secret. A bare `token`
  passes validation cleanly, is stored, and is then silently discarded at request time, producing an
  **anonymous** read on the **60-requests/hour** bucket: a 404 on a private repo, a mystifying
  rate-limit failure on a public one.
- **`token: null` is safe; `token: ''` is fatal.** An explicit `null` returns `undefined`, but the
  empty string is treated as a *type error*, not as absent. That asymmetry is not intuitive and is
  a genuinely useful escape hatch that is documented nowhere.

Also: Gitea has **no `token` key at all** — the token goes in `password` — so
`integrations.gitea[].token` is an unknown key rather than an ignored one. And Bitbucket **Server**
gets no auto-injected default entry, so `assertConfigured` will always fire for an unconfigured
host, which is correct and should be stated in SCM-4's adapter docblock.

### Options

| | Approach | Coverage | Risk |
| --- | --- | --- | --- |
| **A** | Prose in the README and `app-config.yaml` (status quo) | None — prose does not fail a build | A refactor silently reintroduces any of them |
| **B** | A boot check round-tripping a sentinel through each configured integration and warning when no `Authorization` header comes back | The two **silent** traps | Low; it is a warning, and the sentinel never leaves the process |
| **C** | **Unit tests over `ScmIntegrations.fromConfig` pinning each trap's exact behaviour** | All six | None |
| **D** | Validate at startup and refuse to boot | All six | **High** — refusing to boot over another plugin's credential shape is not this plugin's call |

### Selected: **C, plus B**

§5's evidence note says these findings came from "round-tripping a sentinel token through
`ScmIntegrations.fromConfig` and reading each `get*RequestOptions`". **That procedure should be a
test file, not a one-time investigation** — six small tests that fail the build if
`@backstage/integration` changes any of this under us. It is the cheapest item in this document and
it protects the most surprising knowledge in it.

B earns its place for exactly the two silent traps, turning a multi-hour debugging session into a
startup line. Only the *presence* of the header is inspected, never its value — consistent with the
credential-never-logged rule. Check only the hosts the plugin will actually touch, so an unrelated
misconfigured integration produces no noise.

D is the wrong instinct: `integrations.*` is the host app's config, shared with techdocs, catalog and
scaffolder. This plugin gets to warn about it, not to veto it.

**Effort: S each.** Both closable here and independent of everything else.

---

## SCM-7 — The link/unlink pull request is broken on GitHub Enterprise

### The gap — found during this study, user-visible today

`DescriptorAdvice.tsx:56` enables the pull-request path whenever the integration type is `github`,
which is true for a GHE host. But `unlinkPr.ts` constructs `new Octokit({ auth: token })` with **no
`baseUrl`** at two call sites, so every request goes to `api.github.com`; it also hardcodes
`repoUrl: https://github.com/${owner}/${repo}` for the dialog. `descriptorPr.ts` gets this right and
threads an `apiBaseUrl` through.

**A GHE user reaches the token-consent popup and then gets a 404.**

### Selected: thread `apiBaseUrl` through, matching `descriptorPr.ts`

A ~10-line fix, and it should be made **regardless of which SCM-2 option is chosen** — it is a
straight defect, not a feature gap. The `PrAdapter` refactor should absorb it by making `repoUrl` an
adapter method rather than a template literal.

**Effort: S.** Closable here.

---

## FE-1 — Legacy frontend system unsupported

### The gap

The plugin is new-frontend-system only, and `plugins/bruno/package.json` has **no `exports` field**
at all, so the CLI builds exactly one entry point. Most production Backstage installs still run the
legacy system.

**The doc's "a day of work rather than a fork" is 95% right, and the missing 5% is structural.**
A grep for new-system imports finds six hits, of which only two are in rendering components
(`useRouteRef` in two dialogs) plus one type-plus-hook import in the entity header. But the real
blocker is a **value import**: `LinkCollectionDialog` imports `brunoPageRouteRef` from
`extensions.tsx`. That is the module declaring every blueprint, so importing `BrunoCard` drags
`EntityCardBlueprint`, `PageBlueprint`, `PluginHeaderActionBlueprint` and
`EntityHeaderLayoutBlueprint` into the graph. **A naive `/legacy` entry re-exporting the existing
components would pull the entire new-frontend-system runtime into a legacy app's bundle.**

Verified enabling facts: `createPlugin`, `createRoutableExtension` and `createComponentExtension`
are all still exported and **not deprecated**; `EntityLayout`/`EntitySwitch` live in
`plugin-catalog`, already a dependency; and `backstage-cli package build` supports **arbitrary**
subpath entry points — it iterates `Object.keys(pkg.exports)` with no name filtering.

`BrunoEntityHeader` is **genuinely non-portable**: it is typed on `EntityHeaderLayoutProps`, a
contract that exists only because the new system hands a replacement header its own tab model.
Legacy `EntityLayout` renders its own header and exposes no equivalent slot.

### Options

| | Approach | Pros | Cons |
| --- | --- | --- | --- |
| **A** | **`./legacy` subpath exporting `createPlugin` + extension wrappers, omitting the custom header** | Verified buildable; zero new deps; the legacy bundle never sees a blueprint; `./legacy` is invisible to new-system auto-discovery, so it can never be loaded into an NFS app by accident | Legacy users get the stock entity header; two manual test paths |
| **B** | Wrap every legacy-exported element in `compatWrapper` | Smallest delta; `compatWrapper` is public and explicitly bidirectional | Adds a runtime dep for all consumers unless carefully split; a compat provider per card; still does not solve the header |
| **C** | A separate `@usebruno/plugin-bruno-legacy` package | Hardest isolation; independent cadence | A second package to version, publish and keep in lockstep; doubles the compat matrix — for isolation A already gives free |
| **D** | New-system only plus `convertLegacyAppRoot` guidance | Zero plugin work | Inverts the ask. A team evaluating a plugin will not migrate their whole app to try it |

### Selected: **A**, with the route-ref extraction as a mandatory prerequisite *(product decision: build it, 2026-09-18)*

A is the only option satisfying the real constraint — a legacy app's bundle must not contain the
new-system runtime, and vice versa — without a second package. The isolation is **structural, not by
convention**: `.` and `./legacy` are separate rollup inputs, so nothing a legacy consumer imports
can reach `plugin.ts`.

**Prerequisite, and it is five minutes:** move `brunoPageRouteRef` into its own leaf module and have
`extensions.tsx` import *it*, inverting the dependency. Do this immediately whether or not legacy
ships — it is a latent bundle bug today.

Rather than B's `compatWrapper` for the two `useRouteRef` sites, prefer the cheaper fix: make the
dialogs take the resolved path as a prop. That removes the new-system import entirely and makes both
dialogs trivially testable in either system.

**The test that matters is not a React test:** assert the built `dist/legacy` module graph contains
no `@backstage/frontend-plugin-api`. Without it, someone re-adds the import in six months and
nobody notices.

**The doc under-prices one thing:** a legacy Playwright smoke path needs a *second app fixture*
running the legacy system. That, not `legacy.ts`, is the real cost.

**Effort: M.** Closable here.

---

## FE-2 — Docs frame does not match a customised host theme

### The gap

The frontend reads the active theme, maps it to `light`/`dark`, and passes `?theme=` on the iframe
URL. That is a two-state match, correct for a default Backstage theme and wrong for a customised one.

**Two facts change the shape of the problem.** The docs CSP already permits inline script — *we
generate that document*. And the backend already knows the parent origin, because it reads
`app.baseUrl` to build `frame-ancestors`. So the expected origin can be interpolated into the
document as a hardcoded literal rather than trusted from the message.

### Options

| | Approach | Cost |
| --- | --- | --- |
| **T1** | Renderer ships `backstage-light`/`backstage-dark` presets | Renderer-repo change; zero integration work here; still wrong for a customised host |
| **T2a** | `postMessage` handshake → **the renderer** applies tokens | Cross-repo contract plus a renderer change. The doc's plan |
| **T2b** | **`postMessage` handshake → a backend-injected shim in our own generated HTML applies them** | **Entirely closable here**, iff the renderer's styling is reachable by CSS custom properties or an override sheet |
| **T3** | Extend `?theme=` into a full token query string | No messaging and idempotent by construction — but a long opaque query string, tokens in logs and referrers, and every theme change is a full iframe reload that loses scroll position |

### Selected: **T1 + T2b now, T2a as the convergence target** *(product decision: ship the parent half now, 2026-09-18)*

T1 must exist regardless — it is what renders before any handshake and if the handshake fails; that
is a renderer-repo ask and should be filed as one.

**T2b is where this recommendation differs from the design doc.** The parent half of T2a and T2b is
*byte-identical* — same message, same origin checks, same re-send policy. Only the receiver differs.
So build the parent half and a shim receiver here, and delete the shim when the renderer grows a
native receiver. Nothing is wasted either way, and the feature ships without a cross-repo dependency.

**One check gates T2b's viability and must happen before the estimate is trusted:** fetch the
renderer's stylesheet and grep for `var(--`. If the bundle already uses custom properties, T2b is
trivial; if it uses hashed CSS-in-JS class names, T2b degrades to a brittle override sheet and T2a
becomes the right call.

### The contract

A versioned message carrying `mode` plus six palette tokens — background, paper, primary text,
secondary text, accent, border — and a **fixed** method-colour set. Method colours are not in any
palette and must be constants in the message: deriving them from a host theme is exactly the "clone,
not match" overreach §10 warns against. Use `divider` for the border with Backstage's
palette-augmented `border` as a fallback, since a custom theme may not set the latter.

**Both directions speak, deliberately.** The frame posts `ready` once the shim runs; the parent also
posts unconditionally on the iframe's `load` and on every theme change. The `ready` post covers a
first send that raced the document; the parent's unconditional sends make the whole thing work
against a shim-less renderer that only listens — which is the graceful-degradation property we want.

**Fallback is silent and instant by construction:** the T1 preset is applied before any message
exists, so a frame that never receives a theme message is not *waiting* — it is already correctly
rendered in two-state mode.

Origin discipline: `postMessage` targets the exact backend origin, **never `'*'`**; the parent
verifies both `event.origin` and `event.source === iframeRef.current.contentWindow`; the frame
verifies against the backend-interpolated literal. **This is a security property and gets a test**,
not a review comment — dispatch a wrong-origin `MessageEvent` and assert nothing is posted.

Token extraction uses the resolved theme's light/dark discriminator directly. Do **not** drive this
off the app-theme API's active theme id: it yields `undefined` when the user is following
`prefers-color-scheme`, so you would have to resolve it through the installed-theme list and handle
the OS-preference case. The palette already holds the resolved answer.

**Effort: M** for parent plus shim; **S** for the parent half alone. Partially closable here.

---

## FE-3 — No broken-link detection for dead `spec.partOf` refs

### The gap

The Related APIs card reads the **relation**, so a ref naming a non-existent entity produces no
relation and no row. Silent omission is indistinguishable from "the link did not take" — which is
exactly the failure mode that makes a user think their edit failed.

### Options

| | Approach | Verdict |
| --- | --- | --- |
| **(a)** | Frontend resolves `spec.partOf` via `getEntitiesByRefs` and diffs against relations | Works; one batched round trip per card |
| **(b)** | Backend processor validates refs and stamps an annotation | **Violates the annotation rule and must not be built.** The card would render "all fine" for minutes after a user typo'd a ref — precisely when they are looking. It also invites the throw §7.2 forbids |
| **(c)** | **Compare `spec.partOf` + the runtime-link annotation against `relations` already in React context — zero fetches** | Correct, free, available on first paint |

### Selected: **(c)**

(a) is not merely more expensive, it answers the **wrong question**. `getEntitiesByRefs` answers
"does this entity exist"; the card's question is "did this ref produce a relation". Those differ: a
ref can name a real entity and still produce no relation because the stitch has not run yet. (a)
would then report the row as *healthy* while the card still shows nothing — the same silent failure
in a new costume. (c) compares like with like.

Both sides must go through the existing ref-canonicalisation helper, because `stringifyEntityRef`
lower-cases its components — comparing a raw `spec.partOf` string against a stringified ref would
report every mixed-case ref as dead.

**The timing caveat, and it must be honoured.** On a freshly-registered collection nothing is
stitched, so *every* declared ref is transiently unresolved. Rendering them all as "not found in the
catalog" is worse than the omission it replaces. So: render a neutral **"not resolved yet"** state,
and escalate to "not found in the catalog" only after the entity has been seen with at least one
resolved relation or after a bounded grace period — reusing the vocabulary and delays the existing
refresh helper already establishes.

Render unresolved refs as **synthetic rows in the existing table**, not a separate strip: a user
scanning for "is `orders` linked?" should find the answer in one place. Offer Unlink only when the
ref has a runtime component, since a descriptor-only dead ref is removed by a pull request. The
state must not be colour-only — give the row an accessible name stating the condition, matching the
card's existing `aria-label` convention.

Nothing here touches the backend, so §7.2's no-throw constraint is satisfied trivially — which is
itself an argument for (c) over (b).

**Effort: S.** Closable here; no backend change, no new dependency, no extra request.

---

## FE-4 — The stranded UI-created collection

### The gap — the shipped mitigation names a cause that cannot happen

The pending strip correctly subtracts the catalog from the stored list and offers a direct Remove.
But its stalled message says the manifest may be "no longer readable where it lives in source
control" — and **that is false at the current code state**. The provider's emission loop reads
nothing; its own docblock says so in capitals. A stored row with an unreadable manifest still
becomes an entity, just without a definition. So a user is told to fix something that is not the
problem, and the row they are looking at is not the row that is stuck.

Worse, **the two causes that genuinely can strand a row are both omitted.** The provider has two
whole-tick bailouts that return without applying a mutation: the stored-collection list throwing
(the catalog module reaches the plugin's store over HTTP with a plugin token, so misconfigured
service-to-service auth, or an unreachable `bruno` plugin, strands **every** UI collection
indefinitely), and discovery throwing (so a broken `bruno.discovery` entry prevents UI collections
from landing **even though discovery has nothing to do with them**). Both fail on every tick until
fixed, so the user reliably hits the stalled threshold and gets two wrong diagnoses.

**Two premises in the brief were inverted and should be recorded as such.** `refreshSeconds` does
**not** come from frontend config and should not — the key is backend-visibility and travels on the
`GET /collections` envelope, which is right, because moving it would split one number across two
sources. And there is no *permission* hole in the strip today; there is an **over-permissiveness**
hole in the route, which SEC-2 closes.

Multi-replica is **not** a hole: the tick is globally scoped and `refreshSeconds` comes from shared
config, so the only variance is where in the tick a create landed — exactly what the margin absorbs.

### Selected: correct the copy; design the permission-shaped Remove now

Drop the manifest clause. Name the collision cause, which is real, and add "or the Bruno backend is
not reachable from the catalog — check the backend log for the provider". The existing instinct to
point at a log line is right; it just points at the wrong lines.

**Forward-looking:** once SEC-2 lands, a stranded row created by user A becomes unreachable for user
B, and the strip would render a Remove that 403s. It should be **hidden rather than failed**, which
means the route must return enough for the client to know. Design that now, while the route is still
being specified.

**Better still, and this is the highest-leverage item in the FE cluster:** the provider already knows,
per tick, exactly why each row was skipped. Carrying that reason through the same plumbing SCM-5
needs replaces guessed copy with the actual reason — closing FE-4's diagnosis and SCM-5 together for
one piece of work instead of two.

**Effort: S** for the copy and the permission-shaped Remove; **M** for a real per-row diagnosis
(shared with SCM-5).

---

## FE-5 — `bruno://` deep link, and the subpath bug

### The gap

"Open in Bruno" opens a hosted fetch endpoint with the **repo root**, so a multi-collection
repository opens at the wrong level. Bruno desktop handles only an OAuth callback verb; there is no
`open` or `clone`.

**The subpath is already computed and thrown away.** A helper that is the exact complement of the
repo-root function already exists, already handles GitHub, Bitbucket and GitLab's `-/` separator
with percent-decoding, and is already used elsewhere. The fix costs a function call.

**Unverifiable from this repo:** whether the hosted endpoint accepts a subpath at all. Every
reference in the repo describes what we *send*; none describes what the endpoint *accepts*. That is
a five-minute empirical check and must happen before the estimate is trusted.

### Options

| | Approach | Cons |
| --- | --- | --- |
| **1** | Send the subpath on the existing endpoint | Contract unknown; a wrong guess silently opens at the repo root — i.e. today's behaviour, so the downside is bounded |
| **2** | **Fix the clone fallback to `cd` into the collection folder** | Does not fix the primary action |
| **3** | A real `bruno://` verb in `bruno-electron` | Different repo, different release train |
| **4** | Probe-then-choose: try `bruno://`, fall back on failure | Custom-scheme detection is unreliable across browsers and needs a timing hack |

### Selected: **2 now, 1 the moment the contract is confirmed, 3 as a separate workstream — designed now**

2 is unambiguously correct and unblocked: everything needed already exists, so the copied instruction
can `cd` into the collection folder instead of dumping the user at the repo root.

**The grammar the desktop workstream must implement** is specified here so both halves are designed
together: `bruno://open` and `bruno://clone`, each taking a percent-encoded `url`, an optional
repo-relative `path` (per-segment encoded, never leading-slashed — folder names with spaces are
real) and an optional `ref`. Requirements, each existing because of something in this repo: `open`
must not assume the collection is at the root (that is the entire bug); unknown query keys must be
**ignored, not rejected**, so Backstage can add `ref` before the desktop supports it; an unknown verb
must fail **visibly**, or the browser reports success for a link that did nothing; and the existing
OAuth callback route must keep working.

**Effort: S** for 2; **S** for 1 once the contract is known. 3 is **not closable here**.

---

## REL-1 — Zero router and security tests

### The gap

11 unit test files, all on pure logic. **Zero tests** touch the 1,082-line router, the plugin or
module wiring, the definition builder, the provider, either store, any SCM adapter, or any of the
nine frontend extensions. `@backstage/backend-test-utils` and `supertest` are **not installed** —
which gates every "lock the hole closed" test in this document.

**Two premises in the brief do not hold and change the work.** There is no SSRF allowlist to
test — the control does not exist, so that line belongs in the SEC-1 hardening work, not in the
testing section, or it creates false assurance. And the byte-stability test does not exist either;
what is there tests HTTP revalidation tiers, a different thing.

### The decisive finding

`mockServices.httpRouter.factory()` returns the **real** router factory, and it is in
`startTestBackend`'s default list. That factory mounts the plugin at `/api/<pluginId>` **and installs
the real credentials barrier**. So `addAuthPolicy` is genuinely enforced under `startTestBackend`:
auth-policy tests are real end-to-end tests, not assertions about a mock.

### Options

| | Approach | Assurance |
| --- | --- | --- |
| **A** | **`startTestBackend` + supertest against the whole plugin** | The only option that exercises the credentials barrier — where three of the four security properties live. ~2–4s per file |
| **B** | `createRouter()` + supertest on a bare Express app | Fast, but **cannot test `/health`-unauthenticated or the cookie policy at all** — those live in the plugin, outside the router. It would test a hand-rolled mock |
| **C** | Unit-test handlers with fake req/res | Near-zero assurance for security properties |
| **D** | Full app boot and HTTP probing | Highest fidelity, ~60–90s, wrong tool for a per-principal policy matrix |

### Selected: **A**, with B as a fast inner loop for body-validation cases

**Two traps that must be encoded in the tests**, or the suite passes vacuously:

- The mock `httpAuth` **defaults unauthenticated requests to the mock user**. Without overriding the
  default credentials to "none", every "should 401" test passes while proving nothing.
- A config flag can short-circuit the entire barrier. Never set it in test config — and consider a
  test asserting it is not set in `app-config.yaml`.

The cookie policy is testable: send the mock limited-user cookie as a `Cookie` header with no
`Authorization`, and the barrier authenticates it against the one path registered for cookie auth.

**A real catalog-engine integration test is not available at 1.53** — the catalog publishes no
harness, no migration helper and no processing helper; its own rig is monorepo-internal. Say that
plainly rather than leaving it as an open task. The closest honest alternatives are
**extension-point wiring tests** (which close a real hole: the module is the adopter-facing wiring
and has zero coverage) plus a **processor contract test**, with true end-to-end coverage coming from
the Playwright path.

For the nine untested frontend extensions, `@backstage/frontend-test-utils` is **already installed
and already declared** as a devDependency, with an extension tester built for exactly this.

**Effort: M** for the router matrix; S–M for wiring and contract tests.

---

## REL-2 — The Backstage floor below 1.53 is unknown

### Options

| | Approach | Cost | Assurance |
| --- | --- | --- | --- |
| **A** | `versions:bump --release <x>` per matrix leg, full install | ~4–6 min/leg | Highest — it is what a real adopter's app looks like |
| **B** | A `resolutions` matrix | Cheap | Low — pinning a handful of ~120 interlocking packages produces a graph no adopter will ever have, and a failure tells you nothing |
| **C** | Four committed app fixtures | Fast to run | Four Backstage apps to maintain forever |
| **D** | **Type-check-only matrix** | ~3 min/leg | Catches exactly the predicted failure mode |

### Selected: **D as the recurring CI matrix, A once to establish the floor**

§12 argues the constraint is two frontend blueprints — **missing or differently-shaped exports,
which are compile errors, not runtime errors**. The code itself records that one of them "accepts no
string form at all", which is precisely a type-level constraint. So a type-check matrix catches it
for a fraction of the cost: roughly 12 minutes for a three-version type matrix versus ~30 to boot
four apps, for a failure mode that is overwhelmingly compile-time.

Keep one full boot plus the Playwright smoke at the pinned version. And be honest in the README
about what the table means: *"type-checks and smoke-tested at 1.53; type-checks at 1.52 and 1.51"*
is a truthful and useful claim.

**Effort: M.**

---

## REL-3 — Distribution: names, ranges, licence

### The gap, and a finding that contradicts the plan

The plan says: do **not** use caret ranges on `@backstage/*` in published dependencies (`MNT-1`).
Five published Backstage packages were checked. **All of them use caret ranges on their
`@backstage/*` dependencies, and none peer-depend on `@backstage/*` runtime packages** — the only
`@backstage/*` peers in the wild are *optional test-utils* peers on packages that ship test
utilities.

So MNT-1 taken literally would make the Bruno plugins the only Backstage plugins on npm that pin
exactly, and the practical consequence is bad: exact pins duplicate the entire `@backstage/*` tree
in an adopter's `node_modules` the moment their app is one patch ahead, breaking `instanceof` checks,
React context identity and the service registry. **The ecosystem depends on caret ranges deduping to
one copy.**

### Selected: honour MNT-1's concern, reject its remedy

MNT-1's *concern* — that a caret range silently widens the tested baseline — is legitimate. The
remedy that fits the ecosystem is:

- **Keep caret ranges in published `dependencies`**, so deduping works.
- **Commit the lockfile and run CI against it**, so the *tested* baseline is pinned even though the
  *published* range is not. That is exactly the assurance MNT-1 wanted.
- **Add a CI leg that installs with ranges resolved fresh** and runs typecheck and tests. That
  catches caret drift *before* an adopter does — which a pin never would; a pin just defers the
  breakage.
- **Peer-depend only on React and the router**, matching upstream.
- **Publish the compat table** — the real contract, and the one thing a pin cannot give you.

This should be flagged back to whoever owns MNT-1 rather than implemented as written.

Mechanical package changes: drop the `-poc` suffix, remove `private`, add an `exports` map (neither
plugin has one today), point `main`/`types` at `dist`, add `config.d.ts` to `files`, add the plugin
metadata block, and flip the backend's `publishConfig.access` from `restricted` to `public`. The
named `brunoCatalogModule` export and the default export already match the target — no source change.

Two range problems worth more than the carets: `@playwright/test` is declared `^1.32.3` and resolves
to `1.62.1` — 30 minors of silent drift — and the GitHub client is pinned two majors behind current
in both plugins.

**Effort: S** for the package shape; **M** for the repo split and release workflow. **Blocked on
PRD-6** (scope) and **R14** (licence), both decisions rather than engineering.

---

## REL-4 — No CI exists at all

### The gap

No `.github/`, no `.gitlab-ci.yml`, no `.circleci`, no husky. A `lint-staged` block exists but has no
hook to invoke it, **so even the local pre-commit path is dead**. Nothing in this repo has ever been
checked automatically. This is a finding of this study, not of the design doc, and it is the
dependency under DAT-2, REL-1 and REL-2 alike.

### Options

| | Approach | Signal |
| --- | --- | --- |
| **A** | One monolithic job | Slowest feedback; one red X tells you little |
| **B** | Parallel `lint` / `typecheck` / `test` / `e2e` on one trigger | ~4–6 min wall clock, good failure localisation |
| **C** | **B plus a scheduled nightly** for the expensive legs | Keeps PR feedback fast while still covering the compat matrix, Postgres and dependency drift |
| **D** | C plus required checks and a release workflow | The full shape for a published package |

### Selected: **C now, D at publication**

Per-PR: lint, typecheck, test, and e2e. Nightly: the version-compat type matrix (REL-2), the
Postgres leg (DAT-4) and a dependency-drift install (REL-3).

Specific constraints this repo imposes, each verified:

- **ESLint is the formatter of record — do not add a Prettier check to CI.**
- The catalog-generation script does a shallow clone against a public GitHub org, so it is
  network-dependent and rate-limitable. **It must not be a PR gate.**
- Playwright's project generator sets `channel: 'chrome'`, so CI needs real Chrome installed, not
  bundled Chromium; and `webServer` is empty under `CI`, so the workflow must build and boot the
  backend itself.
- Install with `--immutable` so lockfile drift fails the build rather than being silently fixed.
- **Do not ship a red required check.** If the e2e job cannot be green in the same change, gate or
  omit it with a documented note on what must land to enable it.

**Effort: S** for the PR workflow; **M** for nightly.

---

## REL-5 — `yarn install` fails on a clean checkout — **closed**

### The gap

The root `resolutions` block redirected two `@usebruno/*` packages to `portal:` paths under a sibling
checkout. That repository has **one commit and has never contained either directory**, so resolution
died with *"Manifest not found"*. Nothing imports the non-`-poc` names; the backend package merely
carried a dead dependency that the resolution redirected. The existing install survived only because
its `node_modules` predates the breakage.

**This is the hard dependency under everything else in this document** — a pipeline cannot exist if a
clean checkout cannot install.

### Selected: remove the two resolutions and the dead dependency

Landed in `547f66f`, together with two pre-existing `TS6133` errors from an incomplete edit in
`3417d19` that had left `tsc` red. Baseline after that commit: **`tsc` clean, 113 tests across 12
suites green, eslint clean.**

One consequence to note rather than silently absorb: `3417d19` also dropped the deeper `<Helmet
title>` that gave the browser tab `<entity> | <collection> | <app>`. Rendering is unchanged from that
commit; the docblock now records the loss instead of describing behaviour the component no longer
has. **Restoring it is a UI decision, not a cleanup** — flagged rather than taken.

---

## REL-6 — Prior art, the discovery default, and the CDN audit

Three low-severity items from §18, each classified by what would actually settle it:

- **Prior art (§18.8) — needs another repository.** Neither the PagerDuty nor the GitHub Actions
  plugin is in this dependency tree, so the citation cannot be checked from here. One hour of
  reading in `backstage/community-plugins`. Worth doing before citing: given §7.3's independent
  finding that annotation-gated visibility is a UX trap, the GitHub Actions precedent is likely to
  be a **counter-example**.
- **`deferToCatalogInfo: true` (§18.9) — not a test, a field observation.** No experiment settles
  it. Instrument it: count, per install, how many discovered repos produce no collection because no
  descriptor was registered, then decide from data. This is a product call, not a verification task.
- **The renderer's CDN set (§18.10) — now largely settled, and automatable.** The live bundle was
  audited during this study and the origin list is in SEC-3. It must be re-audited against whatever
  production bundle ships, and **that re-audit is automatable as a Playwright test** that records
  every outbound request and derives the CSP from the observed host set. That is the only way the
  pinned CSP stays correct.

---

## Verification tasks needing resources this repo does not have

Separated from the gaps because no amount of engineering in this repository closes them.

| Item | Needs | Experiment |
| --- | --- | --- |
| Private read on GitLab / Bitbucket (§18.3) | **Credentials** | A private repo on each with a real collection; assert `readTree` succeeds and the generated definition matches GitHub's. Cannot run in public CI. **The highest-value unproven item**, since R12 rests on it |
| Multi-replica traffic (§18.2) | **A cluster** | Two backends against one Postgres; count SCM requests at an intercepting proxy. The *scope* assertion alone is automatable and is covered by DAT-5 |
| `integrations.gitlab[].retry` (§18.5) | A stub server | Return 429 then 200; assert the read succeeds and the retry count matches config. Low value next to the private read |
| HTTP-proxy honouring (§18.6) | A container | A logging proxy plus the standard proxy env vars; assert the proxy log shows the request. **Cheap and hermetic, and it settles a claim that currently justifies an architectural choice** over raw Octokit |
| Licence sign-off (R14) | **Legal** | Not an engineering task. Blocks first publication either way |

---

## Corrections this study makes to `TECHNICAL-DESIGN.md`

Recorded separately because they change conclusions, not just wording. Each was verified.

| § | The doc says | Correction |
| --- | --- | --- |
| §5 | Tier-1 revalidation on GitLab/Bitbucket would cost the same quota "for no gain" | **Wrong on both counts.** GitLab tier-1 is 1 call against `readTree`'s 2 — a 50% cut (a 304 is *not* free; measured decrementing by exactly 1). Bitbucket Cloud tier-1 can be **path-scoped**, which its tier-2 cannot be at all, so it avoids whole-repo tarball downloads on monorepos |
| §5 | Bitbucket Server: "❌ no adapter — ref lives in the query string" | **Overstates the blocker.** `normalizeUrl` is already per-provider, `git-url-parse` parses `?at=` correctly, the reader works and the default-branch helper exists. Unscheduled work, not blocked work |
| §5 | Bitbucket Cloud silently drops a bare `token` | True, and **worse**: config validation does not reject it, and `token: null` is the safe spelling that `token: ''` is not |
| §9 S1 | "Any authenticated user may ask the backend to read any URL its integrations can reach" | **Overstated in one direction, understated in the other.** The reader mux blocks arbitrary URLs before a socket opens. What exists is a cross-tenant *existence oracle* over every configured host, plus a quota-burning and memory-amplification primitive |
| §9.4 | Five permissions including `bruno.collection.read` | **Drop the read permission** — every read already resolves through the catalog as the user, so a second gate would blank a tab the catalog happily shows. **Add two `.any` permissions**, which the list is missing, for the admin escape hatch |
| §9 S2 | `GET /collections` and `createdBy` exposure | Already discharged — `createdBy` is stripped for user principals and the links route is service-only |
| §14.1 | Auth passwords, tokens and client secrets are exported verbatim | **The reachable surface is four keys, not forty.** OAuth2, AWS v4, NTLM and WSSE are collapsed at parse time and never reach the catalog |
| §14.3 | "The provider's scheduled task **must be** `scope: 'global'`" | **Already satisfied** by the framework default. Move from "to verify" to "verified" — and set it explicitly, since the code currently relies on a default documented only in a `.d.ts` comment |
| §14.4 | Router tests should cover "the SSRF allowlist" | **The control does not exist.** That line belongs in the SEC-1 hardening work; writing a test now would create false assurance |
| §14.9 | A README line is needed about the dev database | **It already exists in both READMEs.** The real gap is that neither says Postgres is *unverified* |
| §18.7 | Entity size at scale is unmeasured | **Partly measured already** — ~3 KB per request, so the 1 MiB cap is ~350 requests. The unrecorded term is **heap**: 2 probes × 100 entries × `maxBytes` = 200 MiB per replica worst case |
| §8 | `EntityHeaderLayoutBlueprint` accepts no string filter | True, **and worse**: a string in `app-config.yaml` *passes validation* and then silently never matches, giving an invisible header with no diagnostic |
| §8 | Legacy support is "a day of work rather than a fork" | Holds **only after** a route-ref value import is inverted; today it would drag every blueprint into a legacy bundle |
| §10 | T2 requires a renderer change | **A third path exists**: the docs HTML is generated by our own backend under a CSP that already permits inline script, so the receiving half can ship here |
| §11 | Do not use caret ranges on published `@backstage/*` deps (MNT-1) | **Contradicts every published Backstage plugin.** Exact pins duplicate the `@backstage/*` tree and break context identity. Honour the concern via a committed lockfile plus a drift-install CI leg |
| §7.2 | A stranded row may mean an unreadable manifest | **That cause cannot occur** — the provider's emission loop reads nothing. Two real causes (store unreachable, discovery throwing) are omitted instead |
| §13 | PagerDuty / GitHub Actions prior art | Still unverified, and likely a **counter-example** given §7.3's own finding on annotation gating |
