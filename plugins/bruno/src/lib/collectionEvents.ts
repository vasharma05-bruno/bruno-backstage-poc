/**
 * The one signal that crosses the gap between the Add action and the dashboard.
 *
 * `AddCollectionAction` is a PLUGIN-scoped header action
 * (`PluginHeaderActionBlueprint`, extensions.tsx:95) rendered into the page
 * LAYOUT's header, while `PendingCollections` lives inside `BrunoPage`'s
 * content. They are mounted by two different extensions and share no common
 * provider, so a React context would have to be hoisted above the blueprint
 * boundary — which is not ours to hoist, and would couple the page's content to
 * a header extension that may not be installed at all.
 *
 * A DOM event on `window` is the smallest thing that actually reaches: both are
 * in one document, neither has to know the other exists, and an absent listener
 * (dashboard closed) or an absent dispatcher (header action not installed) is a
 * no-op rather than an error.
 *
 * This is a NUDGE, never a source of truth. It carries no payload and nothing
 * downstream may trust it: `PendingCollections` re-reads the backend when it
 * fires, exactly as it does on mount and on an entity-list refetch. Losing the
 * event costs latency — the strip appears on the next wake instead of at once —
 * and never correctness. That is why it can be a fire-and-forget DOM event
 * rather than state anyone has to keep in step.
 */

/** Fired after `POST /collections` has stored a row. No payload, by design. */
export const BRUNO_COLLECTION_CREATED_EVENT = 'bruno:collection-created';

/**
 * Announces that a collection was just registered.
 *
 * Guarded on `window` so the module stays importable from a non-DOM context
 * (SSR, a test runner) without the caller having to care.
 */
export function announceCollectionCreated(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(BRUNO_COLLECTION_CREATED_EVENT));
}

/**
 * Subscribes to {@link BRUNO_COLLECTION_CREATED_EVENT}, returning the
 * unsubscribe function an effect's cleanup can hand straight back.
 */
export function onCollectionCreated(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  window.addEventListener(BRUNO_COLLECTION_CREATED_EVENT, listener);
  return () => {
    window.removeEventListener(BRUNO_COLLECTION_CREATED_EVENT, listener);
  };
}
