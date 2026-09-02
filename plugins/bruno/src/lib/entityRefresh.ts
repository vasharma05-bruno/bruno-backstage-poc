import { useCallback, useEffect, useRef } from 'react';
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
