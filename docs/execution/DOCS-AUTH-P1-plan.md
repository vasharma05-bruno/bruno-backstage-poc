# DOCS-AUTH-P1 — Lock the Bruno collection READ endpoints (LOCKED plan)

Branch: `feat/next-steps-runtime-connect`  ·  Backstage 1.53 (new FE + BE systems)  ·  Yarn 4
Feature code only in `plugins/bruno` (frontend) and `plugins/bruno-backend` (backend). No app tests.

## Goal (restated)
The Bruno collection READ endpoints are currently reachable by ALL (unauthenticated) via a
blanket `/collections` prefix policy. Lock them so only authenticated Backstage users can reach
them, closing the "copy/replay a docs URL" hole. The docs page is loaded as an iframe `src`
(a browser GET with NO Authorization header) so it must use the Backstage **user-cookie** flow;
the sibling JSON/YAML reads are fetched via `fetchApi` (bearer token) so they use normal
**bearer** auth (`allow:['user']`). `/health` stays unauthenticated. The full-screen docs page
opens in a NEW TAB (already the case).

---

## VERIFIED MECHANISM (all claims checked against installed node_modules)

### A. `addAuthPolicy` path matching — PREFIX match, params supported
`node_modules/@backstage/backend-defaults/dist/entrypoints/httpRouter/http/createCredentialsBarrier.cjs.js`:
- L5–15 `createPathPolicyPredicate`: special-cases `"/"` and `"*"` -> always true; otherwise
  compiles the policy path with `pathToRegexp.pathToRegexp(policyPath, { end: false })`
  (**`end:false` = PREFIX match**) and returns `path => pathRegex.test(path)`.
- L28–48 `middleware`: for each request it does
  `allowsUnauthenticated = unauthenticatedPredicates.some(p => p(req.path))` (checked FIRST),
  then `allowsCookie = cookiePredicates.some(...)`, then
  `httpAuth.credentials(req, { allow:['user','service'], allowLimitedAccess: allowsCookie })`.
- L49–57 `addAuthPolicy`: `allow:'unauthenticated'` pushes into `unauthenticatedPredicates`;
  `allow:'user-cookie'` pushes into `cookiePredicates`. There is NO "more specific overrides
  broader" logic — it is purely additive `.some()` across all registered predicates, evaluated
  per-request.
- `path-to-regexp` resolved for this module is **v8.4.2**
  (`node_modules/path-to-regexp/package.json`); `:id` param syntax is valid in v8, and the
  bare `*`/`"/"` cases are handled before `pathToRegexp` is ever called, so no v8 wildcard throw.

Contract confirmation in
`node_modules/@backstage/backend-plugin-api/dist/index.d.ts`:
- L509–512 `HttpRouterServiceAuthPolicy = { path: string; allow: 'unauthenticated' | 'user-cookie' }`.
- L526–548 `addAuthPolicy`: paths "can contain placeholders", example `path: '/static/:id', allow:'user-cookie'`.

**Consequence for us (the crux):** because matching is additive-prefix with no override, we must
NOT register any unauthenticated/cookie policy that also prefix-matches the sibling read routes.
`/collections/:id/docs` compiled with `end:false` matches `/collections/<anything>/docs...` and
does NOT match `/collections`, `/collections/:id`, or `/collections/:id/opencollection.yml`.
So registering ONLY `{ path: '/collections/:id/docs', allow:'user-cookie' }` (plus keeping
`/health` unauthenticated) yields exactly:
- `/health*`                              -> unauthenticated
- `/collections/<id>/docs*`               -> user or service token OR limited-access cookie
- everything else under `/collections*`   -> full user/service token required (no predicate matches)

### B. Cookie mint + read
`@backstage/backend-plugin-api/dist/index.d.ts`:
- L472–501 `issueUserCookie(res, options?)`: "Issues a limited access token as a cookie ...
  only possible for requests originally made with user credentials ... must be called before
  sending any payload data." Returns `{ expiresAt: Date }`.
- L445–471 `credentials(req, { allow?, allowLimitedAccess? })`: `allowLimitedAccess:true`
  permits limited-access (cookie) tokens; without it, cookie calls throw `NotAllowedError`.

Whether the docs handler must ALSO call `credentials({allowLimitedAccess:true})`:
**No.** The credentials barrier middleware runs BEFORE plugin route handlers
(`httpRouterServiceFactory.cjs.js` L57 `router.use(credentialsBarrier.middleware)` then L59–60
`pluginRoutes`), and it already performs the enforced `httpAuth.credentials(...,
{ allowLimitedAccess: allowsCookie })` call (barrier L41–47). The `user-cookie` policy alone
enforces "authenticated (token or cookie)". The docs handler renders HTML only and needs no
user identity, so it does NOT need an in-handler `credentials` call. (Adding one is optional and
would have to pass `allowLimitedAccess:true` to avoid rejecting the very cookie we want to allow
— we choose NOT to add it, to avoid a double-read and a footgun.)

### C. Cookie refresh endpoint is AUTO-registered per plugin
`node_modules/@backstage/backend-defaults/dist/entrypoints/httpRouter/http/createCookieAuthRefreshMiddleware.cjs.js`:
- L9 `WELL_KNOWN_COOKIE_PATH_V1 = "/.backstage/auth/v1/cookie"`.
- L13–16 GET handler: `const { expiresAt } = await httpAuth.issueUserCookie(res); res.json({ expiresAt: expiresAt.toISOString() })`.
- L17–21 DELETE handler: issues a "none" cookie (clears it).
`httpRouterServiceFactory.cjs.js` L58 wires it for EVERY plugin unconditionally
(`router.use(createCookieAuthRefreshMiddleware(...))`). So `bruno` already serves
`GET <backendBaseUrl>/api/bruno/.backstage/auth/v1/cookie`. **No explicit registration needed.**
Note it is mounted AFTER the credentials barrier (L57 before L58), so hitting it requires a full
user/service token — which `fetchApi.fetch` supplies via bearer. Good: the mint call authenticates
via bearer, and the response `Set-Cookie` establishes the limited-access cookie.

Base URL note: `discoveryApi.getBaseUrl('bruno')` returns `<backendBaseUrl>/api/bruno`, so the
cookie URL the frontend hits is `${brunoBase}/.backstage/auth/v1/cookie`. This is the SAME origin
the iframe `src` points at (`${brunoBase}/collections/:id/docs`), so the minted cookie's domain
covers the iframe request.

### D. Cookie attributes (cross-origin behavior)
`node_modules/@backstage/backend-defaults/dist/entrypoints/httpAuth/httpAuthServiceFactory.cjs.js`:
- L143–146 `res.cookie(BACKSTAGE_AUTH_COOKIE, token, { ...cookieOptions, expires: expiresAt })`.
- L149–162 `#getCookieOptions`: `externalBaseUrl = discovery.getExternalBaseUrl('bruno')`;
  `secure = protocol==='https:' || hostname==='localhost'`; returns
  `{ domain: hostname, httpOnly:true, secure, priority:'high', sameSite: secure ? 'none' : 'lax' }`.

Interpretation:
- Prod (single https origin): `secure=true`, `sameSite='none'`, `domain=<host>`. The iframe GET
  (a cross-site subresource request from the app page) sends the cookie. Works.
- Dev (`backend.baseUrl=http://localhost:7007`): hostname is `localhost` -> `secure=true`,
  `sameSite='none'`, `domain=localhost`. Modern browsers grant `localhost` a secure-context
  exemption, so a `Secure` cookie is accepted over http on localhost; and app(:3000)↔backend(:7007)
  are the SAME site (ports don't change registrable domain), so `SameSite=None` cross-port send
  works. `backend.cors.credentials: true` is already set (app-config.yaml L43). => Dev SHOULD work
  on Chrome/Edge/Firefox. Flagged as a verification step, NOT a blocker.

### E. startCookieAuthRefresh is UNSUITABLE here — use a manual handshake
`node_modules/@backstage/core-app-api/dist/apis/implementations/IdentityApi/startCookieAuthRefresh.esm.js`:
- L1/L24 hardcodes `PLUGIN_ID = "app"` and resolves `discoveryApi.getBaseUrl('app') +
  '/.backstage/auth/v1/cookie'` — the APP plugin's cookie, not `bruno`'s.
- It is NOT exported from the public surface (`grep startCookieAuthRefresh index.d.ts` in
  core-app-api / core-plugin-api => no match). Importing it is unsupported deep-path usage.
=> We do a MANUAL `fetchApi.fetch(cookieUrl, { credentials:'include' })` against the `bruno` base,
mirroring the same request shape (esm L25–28: GET `${base}/.backstage/auth/v1/cookie`,
`credentials:'include'`, JSON `{ expiresAt }`), and drive our own refresh timer.

`fetchApiRef`, `discoveryApiRef`, `identityApiRef`, `errorApiRef` are all public in
`@backstage/core-plugin-api` (index.d.ts L4 re-export from `@backstage/frontend-plugin-api`) and
retrievable via `useApi(...)`. `fetchApi.fetch` injects the Backstage bearer token automatically
(the app's default `FetchApi` middleware), so the mint call is authenticated.

---

## CHANGE 1 — Backend `plugins/bruno-backend/src/plugin.ts` (auth policies)

Current (L76–87): a POC comment plus two policies — `/health` unauthenticated and `/collections`
unauthenticated (the blanket prefix that opens the whole tree).

Replace the two `addAuthPolicy` calls (and the stale POC comment) with:

```ts
// /health is a liveness probe with no data — keep it open.
httpRouter.addAuthPolicy({
  path: '/health',
  allow: 'unauthenticated'
});
// The docs page is loaded as an iframe `src` (a browser GET with NO Authorization
// header), so it cannot use bearer auth. Allow the Backstage limited-access
// USER-COOKIE on this exact route only. Path matching is prefix-based
// (path-to-regexp `end:false`) and additive, so this matches
// `/collections/<id>/docs*` and NOTHING ELSE under /collections — the sibling
// read routes (list, :id, opencollection.yml) fall through to the default
// barrier and require a full user/service token.
httpRouter.addAuthPolicy({
  path: '/collections/:id/docs',
  allow: 'user-cookie'
});
```

- REMOVE the `{ path: '/collections', allow: 'unauthenticated' }` policy entirely.
- REMOVE the stale POC comment block (L76–79) that justified the open prefix.
- Result: list/detail/yaml under `/collections` now require a token; `/collections/:id/docs`
  accepts token OR cookie; `/health` open. All other routes already require tokens in-handler
  and are unaffected by policies.

## CHANGE 2 — Backend `plugins/bruno-backend/src/service/router.ts` (in-handler bearer reads)

The barrier already enforces "authenticated" for these routes once Change 1 removes the open
prefix. To make the routes self-documenting AND to pin `allow:['user']` (barrier default is
`['user','service']`), add an explicit in-handler credentials read to the three sibling reads.
(These handlers are currently synchronous; convert to `async` to await the credentials call.)

- `GET /collections` (L68–70): make `async`; first line
  `await httpAuth.credentials(req, { allow: ['user'] });` then existing `res.json(...)`.
- `GET /collections/:id` (L126–137): make `async`; first line
  `await httpAuth.credentials(req, { allow: ['user'] });` then existing 404/redact logic.
- `GET /collections/:id/opencollection.yml` (L162–169): make `async`; first line
  `await httpAuth.credentials(req, { allow: ['user'] });` then existing 404/yaml logic.

- `GET /collections/:id/docs` (L139–160): **NO in-handler credentials call.** The `user-cookie`
  policy (Change 1) already enforces token-or-cookie via the barrier; adding a bearer-only
  `credentials` here (without `allowLimitedAccess:true`) would REJECT the very cookie we intend
  to accept. Leave the handler exactly as-is (keeps `applyDocsEmbeddingHeaders` + `theme` +
  `generateOcDocsHtml`, and the 404 HTML branch). Rename/trim the misleading L132–135 and
  L329/L348-349 "unauthenticated prefix" / "move behind user-cookie auth" comments to reflect
  that the route is now cookie-gated (comment-only; optional but recommended for accuracy).

Confirmed UNAFFECTED (they already call `httpAuth.credentials` in-handler and are covered by the
default barrier now that the open prefix is gone):
`POST /collections/import` (L72), `GET /collections/imported` (L101),
`DELETE /collections/imported/:id` (L115), `POST /collections/:id/sync` (L171),
`GET /dashboard` (L195), all `/connections*` routes (L202–287), `POST /refresh` (L290).
(`POST /refresh` has no in-handler creds and no policy -> now requires a token, which is fine.)

## CHANGE 3 — Frontend `plugins/bruno/src/components/BrunoDocsPage/BrunoDocsPage.tsx`

Add the cookie handshake BEFORE setting the iframe `src`, and a refresh timer cleared on unmount.

APIs to inject (all via `useApi`, all public in `@backstage/core-plugin-api`):
- `brunoApiRef` (already) — for `getDocsUrl`.
- `fetchApiRef` — to call the cookie endpoint with the bearer token attached.
- `discoveryApiRef` — to resolve `getBaseUrl('bruno')` for the cookie URL (same base
  `BrunoClient` uses; keeps the cookie domain aligned with the iframe origin).
- `errorApiRef` — optional, to surface refresh failures.

Sequence inside the existing `useEffect` (keyed on `[brunoApi, collectionId, themeMode]`), still
respecting the `cancelled` guard and returning a cleanup that clears the guard AND the timer:
1. If no `collectionId`, set the missing-id error (unchanged).
2. `const base = await discoveryApi.getBaseUrl('bruno');`
   `const cookieUrl = `${base}/.backstage/auth/v1/cookie`;`
3. Handshake helper:
   `const res = await fetchApi.fetch(cookieUrl, { credentials: 'include' });`
   if `!res.ok` throw an Error with status; else `const { expiresAt } = await res.json();`.
   (`credentials:'include'` makes the browser accept/store the Set-Cookie; the bearer is added by
   `fetchApi`.)
4. AWAIT the first handshake, THEN `const url = await brunoApi.getDocsUrl(collectionId, themeMode);`
   and `if (!cancelled) setSrc(url);`. Order matters: cookie must be set before the iframe issues
   its no-Authorization GET.
5. Schedule refresh: `setTimeout` at ~ (Date.parse(expiresAt) - Date.now() - 60s margin), min a
   few minutes, that re-calls the handshake helper and re-schedules. Store the timer id in a ref
   or effect-local variable.
6. Cleanup (returned from effect): `cancelled = true; clearTimeout(timer);`. On `.catch`, set the
   existing `error` state (unchanged UI) and optionally `errorApi.post`.

Keep everything else: the `?c=` param read, `themeMode` from MUI theme, the loading `<Progress/>`
gate on `!src`, the error `<Box>`, and the iframe element/attributes
(`sandbox="allow-scripts allow-same-origin"`, `title`, `className`). Do NOT add
`allow-same-origin` removal — the bundle needs it; unchanged.

Rationale for handshake living in `BrunoDocsPage` (not `BrunoClient.getDocsUrl`): `getDocsUrl`
returns a plain string and is also consumable elsewhere; the cookie lifecycle (mint + timed
refresh + cleanup) is component-scoped and belongs with the iframe that depends on it.

## CHANGE 4 — `plugins/bruno/src/components/CollectionDocs/OcDocsFrame.tsx`
NO CHANGE. It is only a launcher: it resolves the collection id and
`window.open('/bruno/docs?c=<id>', '_blank', 'noopener,noreferrer')`. It never loads the iframe
or touches auth. The cookie handshake happens inside the opened `BrunoDocsPage`. `noopener` is
fine — the new tab establishes its own cookie via its own `fetchApi` bearer.

## CHANGE 5 — app-config
NO REQUIRED CHANGE for the mechanism. `backend.cors.credentials: true` and
`cors.origin: http://localhost:3000` are already present (app-config.yaml L40–43), which is what a
cross-origin credentialed cookie fetch needs. `app.baseUrl`/`backend.baseUrl` are already set
(L3, L24). Do NOT set `backend.auth.dangerouslyDisableDefaultAuthPolicy` (that would short-circuit
the whole barrier — createCredentialsBarrier L18–27 — and reopen everything).
Prod note (documentation only): deploy app+backend under a single https origin (or ensure
`backend.baseUrl` is https and the app can reach `${brunoBase}/.backstage/auth/v1/cookie`
same-site) so the `Secure; SameSite=None` cookie is accepted and sent on the iframe request.

---

## RISK LIST
1. **addAuthPolicy param support** — RESOLVED. `end:false` prefix + `path-to-regexp` v8 param
   syntax verified; `/collections/:id/docs` matches only the docs subtree, siblings fall through.
   No override logic exists, so correctness depends on NOT registering any broader `/collections`
   policy (Change 1 removes it). LOW.
2. **Cross-origin cookie in dev (http)** — cookie is `Secure; SameSite=None; Domain=localhost`
   (httpAuthServiceFactory L154–160). localhost secure-context exemption + same-site ports mean it
   should work on modern browsers; verify in Chrome/Firefox that the docs iframe renders (not 401)
   and DevTools > Application shows the `backstage-auth-cookie` for the backend origin. If a
   hardened browser blocks it, the fallback is a single-origin dev setup or an https dev proxy.
   MEDIUM (dev only; prod single-origin is fine).
3. **Cookie expiry / refresh races** — the iframe GET could fire in the sub-second window before
   the first mint completes; mitigated by AWAITing the first handshake before setting `src`
   (Change 3 step 4). Long-lived tabs: the refresh timer re-mints before expiry; a missed refresh
   causes the next iframe reload (or a subsequent docs open) to re-mint. Refresh failures surface
   via `error`/`errorApi`. LOW–MEDIUM.
4. **Read routes breaking existing card fetches** — VERIFIED SAFE. `BrunoClient.getCollections`,
   `getCollection`, `getOpenCollectionYaml`, `getImportedCollections` all go through
   `fetchApi.fetch` (BrunoClient L37–47, L57–79, L169–185), which attaches the bearer; the new
   `allow:['user']` in-handler reads accept user bearer. No card uses an unauthenticated read.
   LOW.
5. **Docs 404-in-iframe path** — `GET /collections/:id/docs` for an unknown id returns 404 HTML
   (router L139–149) AFTER passing the cookie barrier; the iframe shows the 404 page. If the
   cookie is missing/invalid, the barrier returns 401 BEFORE the handler and the iframe shows a
   blank/error frame — indistinguishable from a real 404 to the user. Verify the handshake
   succeeds first (risk #2) so 401 is not mistaken for 404. LOW.
6. **Handler comments now stale** — the `applyDocsEmbeddingHeaders` doc + the `/collections/:id`
   "reachable on the unauthenticated prefix" comment (router L132–135, L329, L348–349) claim the
   route is unauthenticated; update them for accuracy (comment-only). COSMETIC.

## Verification checklist (post-implementation, manual — no app tests)
- `yarn tsc` / plugin build clean.
- Unauthenticated `curl <backendBaseUrl>/api/bruno/collections` -> 401; `/api/bruno/health` -> 200.
- Unauthenticated `curl .../collections/<id>/docs` -> 401 (no cookie); with a valid limited cookie
  -> 200 HTML.
- In-app: open an entity's "API Docs" tab -> click launcher -> new tab renders docs (network shows
  a successful `/.backstage/auth/v1/cookie` GET then the `/collections/:id/docs` GET carrying the
  cookie). Overview Bruno card still lists collections (bearer reads still 200).

## Critical Files for Implementation
- /Users/vasharma05_bruno/Projects/usebruno-backstage/plugins/bruno-backend/src/plugin.ts
- /Users/vasharma05_bruno/Projects/usebruno-backstage/plugins/bruno-backend/src/service/router.ts
- /Users/vasharma05_bruno/Projects/usebruno-backstage/plugins/bruno/src/components/BrunoDocsPage/BrunoDocsPage.tsx
- /Users/vasharma05_bruno/Projects/usebruno-backstage/plugins/bruno/src/api/BrunoClient.ts
- /Users/vasharma05_bruno/Projects/usebruno-backstage/app-config.yaml
