import { useEffect, useRef, useState } from 'react';
import Box from '@material-ui/core/Box';
import CircularProgress from '@material-ui/core/CircularProgress';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { useApiHolder } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntityList } from '@backstage/plugin-catalog-react';
import { brunoApiRef } from '../../api';
import type { StoredCollectionSummary } from '../../api';
import { onCollectionCreated } from '../../lib/collectionEvents';
import { brunoBrand } from '../../theme/brand';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    strip: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: theme.spacing(1, 2),
      borderRadius: theme.shape.borderRadius,
      border: `1px solid ${brand.border}`,
      backgroundColor: brand.wash
    }
  };
});

/**
 * How often the catalog is re-asked, while anything is still pending.
 *
 * Slower than modal 2's 3 s poll on purpose. That dialog is a user staring at
 * one collection they just submitted, where three seconds of lag reads as the
 * app being slow; this is a background strip on a page the user is doing other
 * things on, and the wait it describes is `bruno.schedule.frequencySeconds`
 * long either way. Five seconds keeps the two catalog reads per tick well
 * below anything the dashboard notices.
 */
const PENDING_POLL_MS = 5000;

/** The namespace `POST /collections` records for every row it stores. */
const NAMESPACE = 'default';

/**
 * The catalog ref a stored row will produce once the provider has run.
 *
 * LOWER-CASED, because that is what a ref is: `stringifyEntityRef` lower-cases
 * kind, namespace and name, so `bruno:default/Payments` is not a ref the
 * catalog holds — `bruno:default/payments` is. Asking for the name as the user
 * typed it would report a landed collection as pending forever.
 */
function entityRefFor(row: StoredCollectionSummary): string {
  return `bruno:${NAMESPACE}/${row.name.toLocaleLowerCase('en-US')}`;
}

/** `a` / `a and b` / `a, b and c` / `a, b and 4 more`. */
function describeNames(names: string[]): string {
  if (names.length === 1) {
    return names[0];
  }
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * The sentence the strip shows.
 *
 * No figure for the wait, deliberately. The real interval is
 * `bruno.schedule.frequencySeconds`, which only the backend knows and only
 * reports on a create or a delete response — neither of which the dashboard
 * has. "60 seconds" would be a guess that is wrong on any instance that tuned
 * the schedule, and a wrong number on screen is worse than none: a user told
 * "a minute" on a ten-minute schedule concludes the create failed. What the
 * user can act on is the NAME and the fact that waiting is the right thing to
 * do, and both of those are exact.
 */
function pendingMessage(names: string[]): string {
  const one = names.length === 1;
  return (
    `${describeNames(names)} ${one ? 'has' : 'have'} been added and `
    + `${one ? 'is' : 'are'} not in the catalog yet. `
    + `${one ? 'It appears' : 'They appear'} in this list shortly, on the next `
    + 'catalog refresh.'
  );
}

/**
 * Names the collections that have been added but are not entities yet.
 *
 * THE GAP THIS EXISTS FOR. `POST /collections` stores a row immediately;
 * `BrunoCollectionEntityProvider` turns that row into a catalog entity on its
 * own schedule, up to `bruno.schedule.frequencySeconds` later. Modal 2 explains
 * that wait, but closing modal 2 is meant to be a safe exit — the collection is
 * registered either way — and until now it landed the user on a dashboard whose
 * list was unchanged and which said nothing at all. An unchanged list is
 * indistinguishable from a create that failed.
 *
 * Renders NOTHING in the normal case, and that is a hard requirement rather
 * than a nicety: on a dashboard with no outstanding create this component must
 * be invisible and must not be polling. The strip is a report of an unusual
 * transient state, not furniture.
 *
 * Existence is resolved with `catalogApi.getEntitiesByRefs` and NOT from
 * `useEntityList()`'s entities, even though this renders inside the provider
 * and the entities are right there. Those entities are narrowed by whatever
 * kind/type/owner/tag/user filters are active, so a collection that has landed
 * but is hidden by a filter would be reported as pending — forever, since
 * nothing about waiting longer will bring it into a filter it does not match.
 * The store's rows are unfiltered, so the catalog must be asked an unfiltered
 * question too.
 *
 * Both APIs are read from the holder rather than with `useApi`: a host app need
 * not register either, and a missing one has to cost this strip and nothing
 * else. A failed read is treated the same way — the strip renders nothing. It
 * is an aid, and there is no version of it that is worth an error on a
 * dashboard that is otherwise working.
 */
export function PendingCollections(): JSX.Element | null {
  const classes = useStyles();
  const apis = useApiHolder();
  const brunoApi = apis.get(brunoApiRef);
  const catalogApi = apis.get(catalogApiRef);
  const { backendEntities, refresh } = useEntityList();

  const [pending, setPending] = useState<StoredCollectionSummary[]>([]);

  /**
   * Bumped whenever the Add action reports a create, to wake the effect below.
   *
   * Without it the strip's only wakes are mount and an entity-list refetch, and
   * a create causes NEITHER — the header action is a separate extension and the
   * catalog has nothing new to report yet, which is precisely the case this
   * whole component exists for. A user who submits, closes the second dialog
   * and looks at the table would find it silent until something unrelated
   * refetched. A counter rather than a boolean so two creates in a row are two
   * distinct wakes.
   */
  const [nudges, setNudges] = useState(0);

  useEffect(
    () => onCollectionCreated(() => setNudges((n) => n + 1)),
    []
  );

  /**
   * The names this strip was last waiting on.
   *
   * A ref rather than state because it is read to decide whether a landing
   * JUST happened, and re-rendering on it would be circular. It also survives
   * a read failure, which is what lets the poll keep watching for the landing
   * of a collection whose strip is currently hidden by a backend blip.
   */
  const watching = useRef<Set<string>>(new Set());

  /**
   * Polls until nothing is pending, then stops.
   *
   * The interval is cleared the moment the answer is "nothing", so an idle
   * dashboard — the overwhelmingly common case — holds no timer at all. It is
   * started again by this effect re-running, which happens on three wakes: a
   * create announced by the Add action (`nudges`), an entity-list refetch (a
   * filter change, or the `refresh()` below), and mount. The first is what
   * covers a collection added while the strip is idle; without it that create
   * would wait for an unrelated refetch — the one case this component exists
   * for.
   *
   * Failure is not the same as "nothing pending". A read that throws hides the
   * strip (there is nothing trustworthy to say) but keeps the interval alive
   * IF something was already being watched, so a backend restart mid-wait
   * resolves itself on the next tick instead of going quiet until a wake. With
   * nothing being watched the interval stops, so a backend that rejects this
   * call outright — an older one without the widened route — costs exactly one
   * request per wake rather than one every five seconds.
   */
  useEffect(() => {
    if (!brunoApi || !catalogApi) {
      return undefined;
    }

    let cancelled = false;
    const shown = new Set(
      backendEntities.map((entity) => entity.metadata.name.toLocaleLowerCase('en-US'))
    );

    const settle = (next: StoredCollectionSummary[]): void => {
      setPending(next);
      if (next.length === 0) {
        clearInterval(timer);
      }
    };

    const poll = (): void => {
      void (async () => {
        try {
          const stored = await brunoApi.listCollections();
          if (cancelled) {
            return;
          }
          if (stored.length === 0) {
            watching.current = new Set();
            settle([]);
            return;
          }

          const { items } = await catalogApi.getEntitiesByRefs({
            entityRefs: stored.map(entityRefFor),
            // Presence is the entire question, so the rows come back as a name
            // and nothing else. At one request every five seconds that is
            // worth asking for.
            fields: ['metadata.name']
          });
          if (cancelled) {
            return;
          }

          const next = stored.filter((_row, i) => items[i] === undefined);
          // A row that WAS being watched and now resolves has just landed. A
          // row that has merely vanished from the store has not — it was
          // deleted, and refreshing on a delete would redraw the row that is
          // still in the catalog until the provider's next tick, which reads
          // as the delete having failed. So the transition is read off the
          // rows that are still stored, never off the ones that are gone.
          const landed = stored.filter(
            (row, i) => items[i] !== undefined && watching.current.has(row.name)
          );
          watching.current = new Set(next.map((row) => row.name));

          // Without this the entity exists and the table below still does not
          // show it: `EntityListProvider` fetched once and has no reason to
          // fetch again. Skipped when the table already has the entity — the
          // list may have refetched for its own reasons in the meantime, and a
          // second fetch of a correct list is a flicker for nothing.
          if (landed.some((row) => !shown.has(row.name.toLocaleLowerCase('en-US')))) {
            refresh?.();
          }

          settle(next);
        } catch {
          if (cancelled) {
            return;
          }
          setPending([]);
          if (watching.current.size === 0) {
            clearInterval(timer);
          }
        }
      })();
    };

    // Scheduled BEFORE the first call, so `timer` can be a `const` that the
    // closures above capture without a temporal-dead-zone hazard — the same
    // ordering as the landing poll in `GeneratedYamlDialog`, and free for the
    // same reason: `poll` cannot reach `settle` before this statement has run,
    // because it settles on a promise.
    const timer = setInterval(poll, PENDING_POLL_MS);
    poll();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [backendEntities, brunoApi, catalogApi, refresh, nudges]);

  if (pending.length === 0) {
    return null;
  }

  return (
    <Box mb={2} className={classes.strip}>
      <CircularProgress size={16} />
      <Typography variant="body2">
        {pendingMessage(pending.map((row) => row.name))}
      </Typography>
    </Box>
  );
}
