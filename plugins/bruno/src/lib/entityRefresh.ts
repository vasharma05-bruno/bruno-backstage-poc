import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncEntity } from '@backstage/plugin-catalog-react';

/**
 * How long after a runtime link change to re-read the entity, in milliseconds.
 *
 * Three attempts rather than one because the change is not instant and is not
 * observable either: the backend marks the collection due, the catalog picks it
 * up on its own polling loop, the processor re-reads the link table, and the
 * stitcher rewrites the relations on BOTH entities. That is normally a second
 * or two and occasionally longer under load, and there is nothing to subscribe
 * to. Three cheap reads over nine seconds cover it without turning into a
 * poller — and if they all miss, the pending chip in the card is still on
 * screen saying so.
 */
const REFRESH_DELAYS_MS = [1500, 4000, 9000];

/**
 * Re-reads the entity a few times, for the cards that have just changed a
 * relation on it.
 *
 * The catalog hooks are pull-only: `useRelatedEntities` derives its list from
 * the relations ON the entity object it is handed, so nothing updates until the
 * entity itself is fetched again. `useAsyncEntity().refresh` is that fetch, and
 * this wraps it in the one policy every caller wants — fire a few times, and
 * stop firing when the card unmounts.
 *
 * Takes `refreshRequested` from the backend's response rather than always
 * polling: `false` means the backend could not schedule an immediate reprocess,
 * so the change is minutes away and three reads in the next nine seconds would
 * be three reads that find nothing. The caller says so in the UI instead.
 *
 * Only callable inside an entity context: `useAsyncEntity` throws without one,
 * exactly as `useEntity` does, so this belongs in an entity card and nowhere
 * else. `refresh` itself IS optional — an `AsyncEntityProvider` need not supply
 * one — and the returned function is a no-op in that case rather than a crash.
 */
export function useEntityRelationRefresh(): (
  refreshRequested: boolean
) => void {
  const { refresh } = useAsyncEntity();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
    },
    []
  );

  return useCallback(
    (refreshRequested: boolean) => {
      if (!refresh || !refreshRequested) {
        return;
      }
      for (const delay of REFRESH_DELAYS_MS) {
        timers.current.push(setTimeout(() => refresh(), delay));
      }
    },
    [refresh]
  );
}

/**
 * How long to wait before a declared link that has produced no relation is
 * called dead rather than merely late, in milliseconds.
 *
 * Longer than the last of {@link REFRESH_DELAYS_MS} on purpose: those reads are
 * what makes a late relation appear, so escalating before they have all fired
 * and found nothing would accuse a reference the next one is about to resolve.
 */
const SETTLE_GRACE_MS = 20000;

/**
 * Whether the catalog has been given long enough that an unresolved reference
 * can be reported as broken.
 *
 * On a freshly-registered collection NOTHING is stitched yet: the entity is in
 * the catalog before its descriptor has been processed, so every `spec.partOf`
 * entry is transiently unresolved, and rendering them all as "not found" is a
 * worse lie than the silent omission it replaces. Two things settle it — one
 * relation resolving proves the stitch ran, and failing that the grace period
 * above expires — and until one of them does, the caller shows a neutral state.
 *
 * Takes the COUNT rather than the list so a caller re-deriving its array every
 * render does not restart the timer.
 */
export function useRelationsSettled(resolvedCount: number): boolean {
  const [graceExpired, setGraceExpired] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setGraceExpired(true), SETTLE_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  return resolvedCount > 0 || graceExpired;
}
