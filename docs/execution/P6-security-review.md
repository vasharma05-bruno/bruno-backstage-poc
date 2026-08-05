# P6 — Security Review: runtime-connect feature

> Focused review of the runtime GitHub "connect" flow (P2–P5) across `plugins/bruno-backend`, `plugins/bruno`, and the P1 auth harness. Run as part of P6 (the `/security-review` skill assumes a pushed `origin/HEAD` base this un-pushed branch lacks, so the review was run as a dedicated subagent diffing against `main`). · **Last updated:** 2026-08-05

## Verdict

**The credential-isolation design (RISK #1) holds. Safe for the POC as-is.**
- The **service** GitHub PAT (`integrations.github` / `GITHUB_TOKEN`) never leaves the backend — consumed only by `UrlReaderService` and `integrations.github.byUrl(...)` (which returns only `apiBaseUrl`, not the token); it appears in no response, error, or log.
- The **user's** `repo`-scoped OAuth token flows browser → `POST /connections` body → `readUrlTreeViaOctokit` (passed only to the Octokit client) and is then discarded. It is **never logged, returned, or persisted** — `connectionStore` holds only `entityRef/githubUrl/collectionId/connectedBy/updatedAt`.
- No secrets committed: `.env` is gitignored; `app-config.yaml` uses `${...}` placeholders.

No Critical findings. All substantive findings are **production/Beta hardening**, not POC blockers. **Per the active constraint (POC only; no Beta work until authorized), these are documented here and NOT implemented.**

## Findings

| # | Sev | Finding | File | Disposition |
|---|-----|---------|------|-------------|
| **H1** | High | **IDOR / no object-level authZ** on `/connections`: routes gate only on `allow:['user']` (any authenticated user) and key off a caller-supplied `entityRef`. Any signed-in user can read (`GET`), overwrite/repoint (`POST`), or delete (`DELETE`) any entity's connection. Amplified by `dangerouslyAllowSignInWithoutUserInCatalog` (any GitHub/Google account can sign in). | `router.ts:75,103,121` | Pre-Beta: enforce object-level authZ (Backstage permissions / catalog ownership); remove `dangerouslyAllowSignInWithoutUserInCatalog` for prod. |
| **M1** | Med | **Broad `repo` scope** for a read-only fetch — grants full private read/write; widens blast radius of any future logging/dependency bug. | `signInPage.tsx` `getAccessToken(['repo'])`, `app-config.yaml additionalScopes:[repo]` | Pre-Beta: move to a fine-grained GitHub App installation token (`contents:read`); document as short-lived/single-use. (No read-only classic scope exists.) |
| **M2** | Med | **Collection-embedded auth secrets returned** by `GET /collections/:id` (`mapAuth` spreads raw `password`/`token`/`value`). Pre-existing (R9), but the connect path **widens it**: `connectFromUrl` writes into a **global `connectedCache`** and `GET /collections/:id` is unauthenticated, so a private-repo collection one user connects becomes readable cross-user by id (sha256 prefix of the URL). | `collectionService.ts` (`mapAuth`, `connectedCache`), `router.ts:51` | Pre-Beta: redact secret fields in `mapAuth`; per-user/authz-scope `connectedCache`; auth-gate `GET /collections/:id`. **POC exposure is nil today — all sample collections target public hosts with no embedded secrets.** |
| **M3** | Med | **SSRF surface + unbounded fetch** on the Octokit fallback: `url` validated only client-side (bypassable); no server-side host allow-list; recursive blob fetch has no count/size cap (DoS/amplification). SSRF is bounded today (fallback base is public `api.github.com`). | `collectionService.ts` (`readUrlTreeViaOctokit`, `parseGithubUrl`), `router.ts` | Pre-Beta: server-side URL allow-listing (host ∈ configured integrations), enforce https, cap the blob fetch. |
| **L1** | Low | Client-only URL validation (bypassable) — front line for M3. | `BrunoCard.tsx validateUrl` | Pre-Beta (subsumed by M3 server-side validation). |
| **L2** | Low | Backend error text reflected verbatim to the client (Octokit/UrlReader errors); confirmed no token in the logged/returned paths, but repo paths can echo. | `BrunoClient.ts`, `router.ts` error middleware | Pre-Beta: generic client message + detailed server-side log. |

**Confirmed non-issues:** RISK #1 (service PAT isolation), user-token single-use-and-discard, token-in-body transport via the identity-injecting same-origin `FetchApi`, no committed secrets.

## POC vs production summary
- **Safe for POC as-is:** credential isolation, single-use user token, no committed secrets. The current demo is credential-free (public hosts only), so M2's cross-user exposure has no live secrets to leak today.
- **Must fix before production/Beta:** H1 (object-level authZ + drop `dangerouslyAllow…`), M2 (redact secrets + scope the cache + gate the read route), M3 (server-side URL allow-list + fetch caps), M1 (narrow the token). These belong to the Beta-hardening workstream, which is **not authorized** — captured here for when it is.
