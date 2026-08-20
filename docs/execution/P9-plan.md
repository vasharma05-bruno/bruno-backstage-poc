# P9 — Auto-refresh cards after connect/disconnect — Execution Plan (LOCKED)

> Fixes the live-verified gap: after `BrunoCard` connects/disconnects, the other three surfaces (Collection Tree, Collection Overview, API-Docs tab) don't update until a manual page reload, because each fetches independently on mount with no shared signal. Frontend-only, `plugins/bruno`. No tests. Minimal diff.
>
> Anchors verified: `BrunoCard.tsx` success points — `onConnect`→`finishConnected` (~:168), `onConnectGithub`→`finishConnected` (~:198), disconnect success `setState({status:'notConnected'})` (~:218); `entityRef` (:43). All three consumers share fetch-effect deps `[brunoApi, entityRef, annotationCollectionId]` (`CollectionTreeCard.tsx:142`, `CollectionOverviewCard.tsx:79`, `CollectionDocs.tsx:91`). `lib/` holds shared modules.

## Approach: entityRef-keyed module pub/sub
All four components live in one plugin bundle, so a module-level singleton is shared across the (lazily-imported) extensions. `BrunoCard` (the only emitter — it owns connect + disconnect) notifies; the three read-only consumers subscribe and refetch via a nonce bump.

## New file — `plugins/bruno/src/lib/connectionEvents.ts`
```ts
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribe to connect/disconnect changes for one entity. Returns an unsubscribe fn. */
export function subscribeConnectionChange(entityRef: string, cb: Listener): () => void {
  let set = listeners.get(entityRef);
  if (!set) {
    set = new Set();
    listeners.set(entityRef, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(entityRef);
    if (s) {
      s.delete(cb);
      if (s.size === 0) listeners.delete(entityRef);
    }
  };
}

/** Notify subscribers that an entity's Bruno connection changed. */
export function emitConnectionChange(entityRef: string): void {
  const s = listeners.get(entityRef);
  if (s) {
    for (const cb of [...s]) cb();
  }
}
```

## `BrunoCard.tsx` — emit on success
- Import `emitConnectionChange` from `../../lib/connectionEvents`.
- Call `emitConnectionChange(entityRef)` immediately after each successful state transition that changes the connection: in `onConnect` and `onConnectGithub` right after `await finishConnected(...)`, and in the disconnect handler right after `setState({ status: 'notConnected' })`. (BrunoCard drives its own state directly, so it does NOT subscribe.)

## Each consumer — subscribe + refetch (`CollectionTreeCard.tsx`, `CollectionOverviewCard.tsx`, `CollectionDocs.tsx`)
Identical pattern in all three:
- Import `subscribeConnectionChange` from `../../lib/connectionEvents`.
- Add `const [refreshNonce, setRefreshNonce] = useState(0);`.
- Add a subscribe effect: `useEffect(() => subscribeConnectionChange(entityRef, () => setRefreshNonce(n => n + 1)), [entityRef]);` (the subscribe fn returns the unsubscribe, which becomes the effect cleanup).
- Add `refreshNonce` to the existing fetch-effect deps array (so an emit re-runs the mount fetch: `getConnection`→`getCollection`).
- No other logic changes; the cancelled-guard already handles re-entrancy.

## Consumers touched
New `lib/connectionEvents.ts`; edits to `BrunoCard.tsx` (import + up to 3 emit calls), `CollectionTreeCard.tsx`, `CollectionOverviewCard.tsx`, `CollectionDocs.tsx` (import + nonce state + subscribe effect + deps). No backend, no api client, no extensions/plugin registration, no `package.json`, no types change.

## Executor watch-list
1. The subscribe effect's dep is `[entityRef]` only (not the fetch deps) so it isn't torn down on every refetch.
2. `emitConnectionChange` must fire on BOTH connect paths (`onConnect`, `onConnectGithub`) and on disconnect.
3. Verify: `yarn workspace @usebruno/bruno-plugin-poc build`. No tests.
