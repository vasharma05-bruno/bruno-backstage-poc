# N3-P2 — Collection picker in the BrunoCard + private-repo silent-token fix — Execution Plan (LOCKED)

> Replace `BrunoCard`'s direct `brunoApi.connect(entityRef, url)` (no scan — a multi-collection repo silently links whatever the URL resolves to) with a **Scan → pick exactly one → link** flow, mirroring the Link API tab. Extract the shared SCAN→pick→LINK state machine (including the gesture-safe OAuth flow) into a `useCollectionPicker` **hook** under `plugins/bruno/src/components/CollectionPicker/`, and re-implement BOTH `LinkPanel` and `BrunoCard` on top of it so they stay consistent. Add a **"Change collection"** affordance to the card's connected state that re-derives the repo root from the stored collection URL and re-scans/re-links (upsert by `entity_ref`). Ship a private-repo **silent-token** UX fix: use `getAccessToken(['repo'], { optional: true })` as the FIRST await in scan/link so an already-connected GitHub session works with NO popup; only fall back to the explicit "Connect GitHub" gesture when the optional token is empty AND the unauthenticated attempt fails. **Frontend only** (`plugins/bruno/src`). No `packages/*`, no backend change. No tests. Gated by repo-level `yarn tsc` (0 errors) + `yarn lint:bruno plugins/bruno/src/components/...` (clean) — NOT backstage-cli build.
>
> Verified against HEAD `c2e97ab` (re-verified post-N3-P1; N3-P1 touched only `plugins/bruno-backend`, so these frontend line numbers are current):
> - **BrunoCard** (`components/BrunoCard/BrunoCard.tsx`, 353 lines): `State` union `:17-28` (`loading | notConnected | needsGithub | connecting | connected{detail?,collectionId,sourceUrl?} | error`). `onConnect` (`:154-176`) calls `brunoApi.connect(entityRef, trimmed)` directly (NO scan); catch → `needsGithub`. `onConnectGithub` (`:181-210`, gesture): `githubAuth.getAccessToken(['repo'])` is the first await, then `connect(entityRef, trimmed, token)`. `onDisconnect` (`:212-231`) → `disconnect`; `emitConnectionChange(entityRef)` after connect (`:170`,`:201`) and disconnect (`:222`). `validateUrl` local helper `:120-138`. `finishConnected` `:140-148` (getCollection → connected state). `notConnected` render `:252-276`; `needsGithub` render `:278-296`; `connected` render `:298-340` (shows `state.sourceUrl` via `<Link>` `:320-324`, `OpenInBruno` `:329`, Disconnect gated on `!hasAnnotation` `:332-338`). `shorten` `:345-352`. Annotation path (`hasAnnotation`) is provider-materialized and MUST keep its no-picker behavior.
> - **LinkPanel** (`components/BrunoPage/LinkApi/LinkPanel.tsx`, 413 lines): `State` union `:12-21` (`idle | scanning | needsGithubScan | scanned{collections} | noCollections | connecting | needsGithubLink | linked | error`). Props `{ selectedRef?, selectedName?, onLinked }` `:33-37`. `validateUrl` `:63-81` (identical to card's). `resolveScan` `:85-97` (0→noCollections, 1→auto-select, >1→dropdown). `onScan` `:103-125` (public `discover(trimmed)`; catch→needsGithubScan). `onScanGithub` `:131-160` (gesture: `getAccessToken(['repo'])` first await, `scanTokenRef.current = token`, `discover(trimmed, token)`). `onLink` `:165-197` (`connect(selectedRef, chosen.githubUrl, scanTokenRef.current)`; catch: token present→error else→needsGithubLink). `onLinkGithub` `:202-247` (gesture: token, re-`discover`, re-find chosen, `connect`). `scanTokenRef` `:51` reused scan→link. `useEffect([selectedRef])` reset `:54-61`. Render `:253-411`. **`LinkPanel` does NOT currently call `emitConnectionChange`** (the card does; the tab relies on `onLinked` refetch). Consumed once at `LinkApiTab.tsx:103-107` with `selectedRef`/`selectedName`/`onLinked`.
> - **Client** (`api/{BrunoApi.ts,types.ts}`): `discover(url, token?): Promise<DiscoverResult>` (`BrunoApi.ts:27`), `connect(entityRef, url, token?): Promise<ConnectResult>` (`:25`), `getConnection(entityRef): Promise<ConnectionRecord|undefined>` (`:29`). `DiscoveredCollection { collectionPath, name, requestCount, collectionId, githubUrl }` (`types.ts:139-145`); `DiscoverResult { collections }` (`:148-150`); `ConnectResult { collectionId, name, requestCount }` (`:132-136`); `ConnectionRecord { entityRef, collectionId, githubUrl, connectedBy, updatedAt }` (`:153-159`). NO client/API changes needed for P2.
> - **`getAccessToken` silent-token (VERIFIED, `@backstage/frontend-plugin-api@0.17.3`):** `OAuthApi.getAccessToken(scope?, options?: AuthRequestOptions)`; `AuthRequestOptions = { optional?: boolean; instantPopup?: boolean }`. With `{ optional: true }` it returns the existing token **WITHOUT any popup**, or **`''`** if no session. `githubAuthApiRef` extends OAuthApi.
> - **`lib/connectionEvents.ts`:** `emitConnectionChange(entityRef)` / `subscribeConnectionChange`. **`lib/annotations.ts`:** `getCollectionId`/`getSourceUrl`. `lib/` has no github-url helper yet (new file needed). `OpenInBruno` takes `{ sourceUrl?: string }`. `LinkButton` from `@backstage/core-components` is already used at `CollectionCard.tsx:1,77-79` — the house convention for navigation.

## ⚠️ Load-bearing constraints (restate)
- **Frontend only.** Edit only `plugins/bruno/src`. Backend `discover`/`connect`/`getConnection` already exist and are untouched. No `packages/*`.
- **Gesture safety is load-bearing.** Any `getAccessToken` call that MAY open a popup (i.e. WITHOUT `{ optional: true }`) MUST be the FIRST `await` in a user-click handler. An `{ optional: true }` call NEVER opens a popup, so it is safe anywhere — but we still make it the first await in scan/link so the non-optional fallback path stays clean.
- **MUI v4 + core-components.** `import type` for type-only imports. Leading-`|` / leading-`=` multi-line unions (`@stylistic/operator-linebreak`, see `types.ts:39-46`, `LinkPanel.tsx:12-21`). Use core-components `LinkButton` for the OPEN/nav links (never `Button component={Link}`). The existing `<Link>` display in the connected card is fine (it is a text link, not a nav Button).
- **Single-select only for P2.** Shape the picker API so P3 (multi-select Add-collection) can extend it without a rewrite (a `mode` seam), but do NOT build multi now.

## Locked decisions

- **D1 — Shape = a `useCollectionPicker` HOOK (state machine) + tiny presentational `CollectionPickerFields` component; each host owns its chrome.** Rejected the single "`compact?` presentational component" option: the two hosts render in structurally different chrome (LinkPanel = full `InfoCard` panel with an explainer, its own SCAN/LINK/Connect-GitHub button switch, and `onLinked` refetch; BrunoCard = compact entity card with a URL field inside `notConnected`, a `connected` summary with Source link + OpenInBruno + Disconnect, plus a "Change collection" re-entry). A single presentational component with a `compact?` boolean would accrete host-specific branches and re-introduce the divergence we're removing. A **hook** isolates the ONE thing that must not diverge — the SCAN→pick→LINK + silent-token state machine — while letting each host lay out its own MUI. A small shared **`CollectionPickerFields`** renders the parts that are genuinely identical (the URL `TextField`, the >1 dropdown, the 1-found summary line, the busy `Progress`, and the status messages), driven entirely by the hook's return, so even the field markup is shared. Files created: `components/CollectionPicker/useCollectionPicker.ts`, `components/CollectionPicker/CollectionPickerFields.tsx`, `components/CollectionPicker/index.ts`.

- **D2 — Silent-token fix lives at the FRONT of `onScan` and `onLink` inside the hook.** In `onScan`: FIRST await is `githubAuth.getAccessToken(['repo'], { optional: true })` (never a popup). If it returns a non-empty string, pass it straight to `discover(url, token)` and stash it in `scanTokenRef` (private repo just works, no popup, no `needsGithub*` detour). If it returns `''`, call `discover(url)` unauthenticated; on failure → `needsGithubScan` (the explicit gesture path). Same optional-first pattern in `onLink`: if `scanTokenRef.current` is unset, try `getAccessToken(['repo'], { optional: true })` first; use a non-empty result for `connect(..., token)`. The **popup** calls (`onScanGithub`/`onLinkGithub`, plain `getAccessToken(['repo'])`) remain the FIRST await of their own click handlers — gesture-safe. Net effect: an already-GitHub-connected user with a private repo never sees a "Connect GitHub" button.

- **D3 — BrunoCard rewiring.** Replace `onConnect`/`onConnectGithub`/`validateUrl`/`finishConnected` with the hook. `notConnected` renders `<CollectionPickerFields>` + a SCAN/LINK/Connect-GitHub button reflecting the hook state (exactly like LinkPanel's button switch). Auto-select single, dropdown for >1, clean "no collections" message. On the hook's `onLinked(result)`, re-fetch the collection detail and enter the card's `connected` state; the hook emits `emitConnectionChange(entityRef)` on success (see D6). Connected state keeps showing `sourceUrl` (`ConnectionRecord.githubUrl`) via `<Link>` + `OpenInBruno`. Add a **"Change collection"** button in `connected` (only when `!hasAnnotation`) that seeds the picker with the re-derived repo root (D5) and re-scans; re-link overwrites the row (`connect` upserts by `entityRef`). Preserve `onDisconnect` + its `emitConnectionChange` exactly. The annotation (provider-materialized) branch keeps its current no-picker/no-Disconnect behavior untouched.

- **D4 — Frontend repo-root helper (D-A = re-derive, option a).** New `lib/githubUrl.ts` exporting `repoRootFromCollectionUrl(url: string): string`. Strips any stored collection URL (`https://github.com/<owner>/<repo>` or `.../tree/<ref>/<subpath>`) to `https://<host>/<owner>/<repo>` (first two path segments). Defensive: `try { new URL } catch { return url }`. No dependency on the backend's server-only `parseGithubUrl`. No unit test (matches house policy for P2), but written total (never throws).

- **D5 — "Change collection" seeds the picker with the re-derived root and re-scans.** It does NOT reuse a persisted root (option a, per D-A). On click: set the hook's URL to `repoRootFromCollectionUrl(state.sourceUrl)`, transition the card back to the picker view (`notConnected`-style), and call the hook's `scan()`. This re-lists siblings; the user picks and re-links (upsert). No new store field, no backend change.

- **D6 — The hook emits `emitConnectionChange(entityRef)` on successful link.** So the P9 auto-refresh fires for BOTH hosts. This makes `LinkPanel` additionally emit the event (it currently does not — a strict *improvement*, harmless: `LinkApiTab` also still calls `onLinked`, and the event only notifies subscribers of THAT entityRef). The card's existing explicit `emitConnectionChange` in `onConnect`/`onConnectGithub` is removed (now the hook's job); `onDisconnect`'s `emitConnectionChange` stays in the card, unchanged.

- **D7 — `mode`/`selectionMode` seam for P3 (do NOT build multi).** `useCollectionPicker` accepts `mode?: 'single'` defaulting to `'single'`; the return type carries a single `selectedCollectionId`/`setSelectedCollectionId` and calls `onLinked(result: ConnectResult)` once. The `mode` param is accepted and asserted `'single'` for P2 (multi is a future branch), so P3 can add `'multi'` (checkbox set, `onImported(results)`) without changing the single-mode surface. No multi code now.

## Files created

### `plugins/bruno/src/components/CollectionPicker/useCollectionPicker.ts` (NEW)
The extracted SCAN→pick→LINK + silent-token state machine. Owns the `State` union (verbatim from `LinkPanel.tsx:12-21`, leading-`|` style), `url`/`urlError`/`selectedCollectionId` state, `inFlight` + `scanTokenRef` refs, `validateUrl` (moved verbatim from `LinkPanel.tsx:63-81`), `resolveScan` (verbatim `:85-97`), and the four handlers below. `import type` for `DiscoveredCollection`, `ConnectResult`, `DiscoverResult` from `../../api/types`; `useApi` + `brunoApiRef` + `githubAuthApiRef`; `emitConnectionChange` from `../../lib/connectionEvents`.

**Params (options object):**
```
export interface UseCollectionPickerOptions {
  entityRef?: string;                 // link target; undefined disables scan/link
  initialUrl?: string;                // seed the URL field (e.g. re-derived repo root)
  mode?: 'single';                    // D7 seam; only 'single' for P2
  onLinked: (result: ConnectResult) => void | Promise<void>;
}
```

**Return:**
```
export interface CollectionPickerApi {
  state: State;                                   // status machine (exported State type)
  url: string;
  setUrl: (v: string) => void;
  urlError?: string;
  selectedCollectionId: string;
  setSelectedCollectionId: (id: string) => void;
  scan: () => Promise<void>;                      // = onScan (silent-token first)
  scanWithGithub: () => Promise<void>;            // = onScanGithub (popup, gesture)
  link: () => Promise<void>;                      // = onLink (silent-token first)
  linkWithGithub: () => Promise<void>;            // = onLinkGithub (popup, gesture)
  reset: (nextUrl?: string) => void;              // clear state; optionally seed url + status 'idle'
}
```

**Control flow (silent-token, D2 — gesture-safety annotated):**
- `scan()` (was `onScan` `:103-125`): guard `inFlight`/`!entityRef`; `validateUrl`; set `scanning`; **FIRST await** `const t = await githubAuth.getAccessToken(['repo'], { optional: true })` (NO popup, may be `''`). `if (t) { scanTokenRef.current = t; result = await discover(url, t); } else { scanTokenRef.current = undefined; result = await discover(url); }` → `resolveScan(result.collections)`. `catch` → `needsGithubScan` (only reached on the unauthenticated `''` path failing, since an authenticated failure surfaces as a real error). `finally` clears `inFlight`.
- `scanWithGithub()` (was `onScanGithub` `:131-160`): guard; **FIRST await** `getAccessToken(['repo'])` (popup — gesture-safe, this is a click handler); inner try/catch → on reject set `error` "GitHub access needed…"; `scanTokenRef.current = token`; `discover(url, token)`; `resolveScan`.
- `link()` (was `onLink` `:165-197`): guard + `state.status === 'scanned'`; find `chosen` by `selectedCollectionId`; set `connecting`. **Silent-token top-up:** `let token = scanTokenRef.current; if (!token) { token = await getAccessToken(['repo'], { optional: true }) || undefined; scanTokenRef.current = token; }` — the optional call is the first await when no scan token exists (safe, no popup). `await connect(entityRef, chosen.githubUrl, token)`; on success set `linked`, **`emitConnectionChange(entityRef)`** (D6), then `await onLinked(result)`. `catch`: if `token`→`error` else→`needsGithubLink`.
- `linkWithGithub()` (was `onLinkGithub` `:202-247`): guard + `state.status === 'needsGithubLink'`; **FIRST await** `getAccessToken(['repo'])` (popup — gesture-safe); `scanTokenRef.current = token`; re-`discover(url, token)`; re-find `chosen` (else `error` "…re-scan…"); `connect(entityRef, chosen.githubUrl, token)`; on success `linked` + `emitConnectionChange(entityRef)` + `await onLinked(result)`.
- `reset(nextUrl?)`: `setState({status:'idle'})`, `setUrl(nextUrl ?? '')`, clear `urlError`/`selectedCollectionId`, `inFlight.current=false`, `scanTokenRef.current=undefined`.

Export the `State` type and both interfaces. `connect` returns `ConnectResult` — capture it so `onLinked(result)` gets the id (the card needs `result.collectionId` to fetch detail).

### `plugins/bruno/src/components/CollectionPicker/CollectionPickerFields.tsx` (NEW)
Presentational, host-agnostic. Renders the shared inner fields given the hook api. Props: `{ picker: CollectionPickerApi; disabled?: boolean }`. Renders (all wrapped in `<Grid item xs={12}>` blocks so hosts drop them into their own `<Grid container>`):
- URL `TextField` (label "GitHub repository URL", placeholder `https://github.com/owner/repo`, `value={picker.url}`, `onChange`→`picker.setUrl`, `error`/`helperText` from `picker.urlError`, `disabled` when busy) — from `LinkPanel.tsx:271-282`.
- busy `Progress` + "Scanning…/Connecting…" — from `:284-291`.
- `needsGithubScan` message `:293-300`; `noCollections` message `:302-308`; `>1` dropdown `:310-334`; `1-found` summary `:336-344`; `needsGithubLink` message `:346-353`; `error` `:355-361`; `linked` message `:363-370`.
`import type { CollectionPickerApi }` from `./useCollectionPicker`. MUI `Grid`/`Typography`/`TextField`/`MenuItem`, `Progress` from core-components. Buttons stay in the HOST (SCAN/LINK/Connect-GitHub differ per host chrome and are the click handlers — keeping them host-side keeps the gesture handlers wired directly to `picker.scanWithGithub`/`picker.linkWithGithub`).

### `plugins/bruno/src/components/CollectionPicker/index.ts` (NEW)
`export { useCollectionPicker } from './useCollectionPicker';` `export type { CollectionPickerApi, UseCollectionPickerOptions, State as CollectionPickerState } from './useCollectionPicker';` `export { CollectionPickerFields } from './CollectionPickerFields';`

### `plugins/bruno/src/lib/githubUrl.ts` (NEW)
```
/** Reduce a stored collection URL (…/tree/<ref>/<subpath> or bare repo) to its
 *  repo-root URL https://<host>/<owner>/<repo>. Total: never throws. */
export function repoRootFromCollectionUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return url;
    return `${u.origin}/${seg[0]}/${seg[1]}`;
  } catch {
    return url;
  }
}
```

## Files edited

### `plugins/bruno/src/components/BrunoPage/LinkApi/LinkPanel.tsx` (refactor onto the hook)
- **Delete** the local `State` union (`:12-21`), `validateUrl` (`:63-81`), `resolveScan` (`:85-97`), the four handlers `onScan`/`onScanGithub`/`onLink`/`onLinkGithub` (`:103-247`), the `useState`/`useRef` for `state`/`url`/`urlError`/`selectedCollectionId`/`inFlight`/`scanTokenRef` (`:42-51`), and the `useEffect` reset (`:54-61`).
- **Add** `const picker = useCollectionPicker({ entityRef: selectedRef, onLinked: () => onLinked() });` and a `useEffect([selectedRef], () => picker.reset())` to clear on entity change (replacing the old reset). Keep `githubAuth` import removed if now unused (it moves into the hook — verify and drop `githubAuthApiRef` import + `useApi(githubAuthApiRef)`). Keep `brunoApi` only if still referenced (it is not after refactor — drop `brunoApiRef` import + `useApi` too; the hook owns them).
- **Render**: keep the outer `InfoCard` (`:254`), the `!selectedRef` empty message (`:255-258`), and the explainer (`:261-269`). Replace the inner field blocks (`:271-370`) with `<CollectionPickerFields picker={picker} />`. Keep the button switch (`:372-408`) but wire onClicks to `picker.scanWithGithub` / `picker.link` / `picker.linkWithGithub` / `picker.scan`, and disabled logic to `picker.state`/`picker.selectedCollectionId`. `busy` becomes `picker.state.status === 'scanning' || picker.state.status === 'connecting'`. External props/behavior (`selectedRef`, `selectedName`, `onLinked`) UNCHANGED — `LinkApiTab.tsx:103-107` needs no edit.
- Preserve the >1 picker, reused scan token, and gesture-safe steps (now all inside the hook).

### `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx` (rewire to the hook + Change collection)
- **Imports**: add `useCollectionPicker`, `CollectionPickerFields` from `../CollectionPicker`; add `repoRootFromCollectionUrl` from `../../lib/githubUrl`. Drop `githubAuthApiRef` usage (moves into hook) and `ConnectResult` import if now only used by the hook. Keep `emitConnectionChange` (still used by `onDisconnect`).
- **State union** (`:17-28`): keep the card's own `State` (loading/notConnected/needsGithub/connecting/connected/error) — but the picker sub-flow is now driven by the hook, so the card only needs `loading | annotationLoading` handling + `connected` + `error` + a `picking` view. Simplify: keep `loading`, `connected`, `error`; the "not connected / choosing / changing" states are all rendered from the hook's `picker.state`. Replace the `notConnected`/`needsGithub`/`connecting` card statuses with a single `picking` card status that renders the picker UI.
- **Delete** `onConnect` (`:154-176`), `onConnectGithub` (`:181-210`), `validateUrl` (`:120-138`), `finishConnected` (`:140-148` — moved into the `onLinked` callback below), the `url`/`urlError`/`inFlight` `useState`/`useRef` (`:50-54`).
- **Add** the hook:
  ```
  const picker = useCollectionPicker({
    entityRef,
    onLinked: async (result) => {
      const detail = await brunoApi.getCollection(result.collectionId);
      const rec = await brunoApi.getConnection(entityRef);
      setState({ status:'connected', detail, collectionId: result.collectionId,
                 sourceUrl: rec?.githubUrl });
    }
  });
  ```
  (`getConnection` re-fetch gives the sub-path-encoded `githubUrl` for the Source link, exactly as N2-P6 persists it. The hook already emitted `emitConnectionChange` before `onLinked`.)
- **useEffect** (`:56-118`): keep the annotation branch (provider-materialized: `getCollection` → `connected`, no picker) and the runtime branch (`getConnection` → `connected` or `notConnected`). When `notConnected`, set the card to the `picking` status and `picker.reset()`.
- **Render**:
  - `loading`/`error`: keep (`:235`,`:246-250`).
  - `picking`: `<Grid container>` with an intro line + `<CollectionPickerFields picker={picker} />` + the SCAN/LINK/Connect-GitHub button switch (same shape as LinkPanel's `:372-408`, wired to `picker.*`).
  - `connected` (`:298-340`): keep the name/requests/Source `<Link>`/`OpenInBruno`/Disconnect layout. Add, next to Disconnect and gated on `!hasAnnotation`, a **"Change collection"** `Button variant="outlined"` whose onClick does `picker.reset(repoRootFromCollectionUrl(state.sourceUrl ?? '')); setState({status:'picking'}); void picker.scan();`. (Uses D5: seed root, re-scan; re-link upserts.)
- Preserve `onDisconnect` (`:212-231`) verbatim, INCLUDING its `emitConnectionChange(entityRef)` (`:222`).
- Keep `shorten` (`:345-352`). The Source display stays a text `<Link>` (not a nav Button) — unchanged.

## Executor watch-list
1. **Gesture safety (FIRST-await rule):** in `scanWithGithub`/`linkWithGithub` the plain `getAccessToken(['repo'])` (popup) MUST be the first await. In `scan`/`link` the `getAccessToken(['repo'], { optional: true })` is the first await but is popup-free — fine. Do NOT move any real backend fetch (`discover`/`connect`) ahead of the token calls.
2. **`{ optional: true }` returns `''` (empty string), not `null`/`undefined`** — treat empty string as "no session" (`if (token) …`). A non-empty result is a live token → pass it through, no popup.
3. **Preserve `emitConnectionChange`:** hook emits it on every successful link (both hosts). Card's `onDisconnect` keeps its own `emitConnectionChange`. Do NOT double-emit in the card's `onLinked`.
4. **Do NOT touch the backend** or `packages/*`. `discover`/`connect`/`getConnection` are used as-is. No client/`api/*` changes (`discover`/`connect` already carry `token?`).
5. **`LinkButton` for OPEN/nav links** — not needed here (no new navigation button); the Source `<Link>` stays a text link. Do NOT convert it to a Button.
6. **`import type`** for all type-only imports (`DiscoveredCollection`, `ConnectResult`, `DiscoverResult`, `CollectionDetail`, `CollectionPickerApi`). **Leading-`|` / leading-`=` multi-line unions** for the moved `State` type (match `LinkPanel.tsx:12-21`).
7. **Single-select ONLY.** `mode` defaults to `'single'`; do not implement `'multi'`. One `selectedCollectionId`, one `onLinked(result)` call.
8. **Annotation branch untouched:** when `hasAnnotation`, the card must NOT show the picker or Disconnect or Change-collection — provider-materialized behavior is preserved.
9. **LinkPanel external contract unchanged:** props `{ selectedRef, selectedName, onLinked }`; `LinkApiTab.tsx` unedited. Don't regress the >1 dropdown, the reused scan token, or the 4 gesture-safe steps.
10. After edits, `grep -n "githubAuthApiRef\|brunoApiRef\|useApi" LinkPanel.tsx` — confirm the hook now owns those and remove now-unused imports (no unused-import lint errors).

## Risks
- **R-A** Hook now owns `githubAuth`/`brunoApi`; removing them from `LinkPanel`/`BrunoCard` may leave unused imports → lint fail. Mitigation: watch-list #10; the `discover`/`connect`/`getConnection` used by the card's `onLinked` still needs `brunoApi` in the card, so keep `brunoApiRef`+`useApi` there (only `githubAuthApiRef` is fully removable from the card).
- **R-B** The silent-token `optional` call in `scan` could return a token for a repo the user shouldn't scan privately — acceptable: it is the user's own GitHub session, same trust boundary as the explicit path, just without a redundant consent click.
- **R-C** "Change collection" re-scan on a repo whose sibling set changed (a collection was deleted) → picker may not contain the previously-linked id; handled by normal pick flow (LINK disabled until a valid choice). No special-casing.
- **R-D** `LinkPanel` now emits `emitConnectionChange` (new). Harmless: `LinkApiTab` still calls `onLinked` refetch; the event only wakes subscribers for that exact `entityRef` (a card on that entity would refresh — desirable). Note it so a reviewer doesn't flag it as scope creep.
- **R-E** `repoRootFromCollectionUrl` on a non-github or malformed stored URL returns the input unchanged → the subsequent scan surfaces a normal validation/scan error, no crash (total function).

## Gates (authoritative — NOT backstage-cli build)
```
yarn tsc                                                    # 0 errors, repo-level
yarn lint:bruno plugins/bruno/src/components/CollectionPicker plugins/bruno/src/components/BrunoCard plugins/bruno/src/components/BrunoPage/LinkApi plugins/bruno/src/lib   # clean
```
No tests. Minimal changes, reuse existing code — no new deps, no backend/`packages` edits.
