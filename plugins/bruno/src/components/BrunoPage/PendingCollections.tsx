import { useEffect, useRef, useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import ErrorOutlineIcon from '@material-ui/icons/ErrorOutline';
import { alertApiRef, useApiHolder } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntityList } from '@backstage/plugin-catalog-react';
import { brunoApiRef } from '../../api';
import type { StoredCollectionSummary } from '../../api';
import { onCollectionCreated } from '../../lib/collectionEvents';
import { landingTimeoutSeconds } from '../../lib/landingWindow';
import { brunoBrand } from '../../theme/brand';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    strip: {
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
      padding: theme.spacing(1, 2),
      borderRadius: theme.shape.borderRadius,
      border: `1px solid ${brand.border}`,
      backgroundColor: brand.wash
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5)
    },
    message: {
      flex: 1
    },
    stalledIcon: {
      color: theme.palette.warning.main,
      fontSize: 18
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
 *
 * It doubles as this component's clock. The waiting/stalled split below is a
 * function of the current time, and re-rendering it is exactly what each poll
 * already does, so a row crosses from one state to the other within five
 * seconds of doing so without a second timer existing to say when.
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

/**
 * Which side of the provider's landing window a stored row is on.
 *
 * `waiting` is ordinary latency: the row exists, the entity does not yet, and
 * the next tick produces it. `stalled` is the case the provider cannot fix and
 * the strip previously mis-described — the entity is not coming, because
 * `BrunoCollectionEntityProvider` skipped this collection and will skip it
 * again on every tick until something changes.
 */
type RowState = 'waiting' | 'stalled';

/**
 * Classifies a row by how long it has been stored.
 *
 * The clock is `createdAt` off the row, NOT a timer started when this component
 * first saw it. A client-side timer restarts on every reload and every remount
 * — navigating away from the dashboard and back would reset a stalled row to
 * "arriving shortly", which is the exact false statement this split exists to
 * remove — whereas `createdAt` is when the collection was actually registered
 * and says the same thing to every tab, forever.
 *
 * `refreshSeconds` is undefined only before the first successful read, which is
 * also before any row can be on screen; an unclassifiable row counts as waiting
 * so that the strip never accuses one of being stuck on a guess. A `createdAt`
 * that will not parse is treated the same way, for the same reason.
 */
function rowState(
  row: StoredCollectionSummary,
  refreshSeconds: number | undefined
): RowState {
  if (refreshSeconds === undefined) {
    return 'waiting';
  }
  const added = Date.parse(row.createdAt);
  if (Number.isNaN(added)) {
    return 'waiting';
  }
  const grace = landingTimeoutSeconds(refreshSeconds) * 1000;
  return Date.now() - added > grace ? 'stalled' : 'waiting';
}

/**
 * The sentence a row that is still landing shows.
 *
 * No figure for the wait, deliberately — and this is not for want of one, since
 * `refreshSeconds` is now on the response. The strip cannot know WHERE in the
 * current tick the collection was added, so any number it quoted would be an
 * upper bound dressed up as an estimate. What the user can act on is the NAME
 * and the fact that waiting is the right thing to do, and both of those are
 * exact. The row that has waited too long gets a different sentence instead of
 * a number.
 */
function waitingMessage(name: string): string {
  return (
    `${name} has been added and is not in the catalog yet. It appears in this `
    + 'list shortly, on the next catalog refresh.'
  );
}

/**
 * The sentence a row that is past the landing window shows.
 *
 * THE DEFECT THIS FIXES. Every stored row used to be described as arriving "on
 * the next catalog refresh", which for these rows is permanently false: the
 * provider skipped the collection and will skip it on every future tick too.
 * Left saying that, the strip is an instruction to keep waiting for something
 * that is not coming.
 *
 * THE CAUSES ARE THE PROVIDER'S, NOT THE REPOSITORY'S. This used to offer an
 * unreadable manifest as the first explanation, which cannot strand a row at
 * all: `BrunoCollectionEntityProvider`'s emission loop reads no SCM host, so a
 * row whose URL points nowhere still becomes an entity — a degraded one,
 * without `spec.definition` and with a processing error against it. Naming that
 * cause sends a user to fix the one thing that is not the problem.
 *
 * What genuinely strands a row is a name a `bruno.collections[]` entry claimed
 * first — config is swept first and the claim guard is first-wins — or a tick
 * that never reaches `applyMutation`. The provider returns early when it cannot
 * read the stored collections (a service-to-service call to this plugin) and
 * when a `bruno.discovery` sweep throws, because emitting a partial set would
 * delete by set difference; either bailout holds back every UI-created
 * collection rather than this one. Which of the three it is lives in the
 * provider's own log lines, so pointing at a log stays right — it just has to
 * point at the right one.
 *
 * Deliberately not an error: the row is stored, nothing is lost, and the Remove
 * control beside it is a complete resolution on its own.
 */
function stalledMessage(name: string): string {
  return (
    `${name} was added but has not appeared in the catalog, and will not `
    + 'appear on its own. Either a collection configured in app-config.yaml has '
    + 'taken the same name, or the provider is not finishing its refreshes — it '
    + 'skips a whole tick when it cannot reach this plugin, or when a '
    + 'bruno.discovery sweep fails. The backend log says which, under '
    + 'BrunoCollectionEntityProvider. Fix that, or remove it here.'
  );
}

/** The confirmation posted after a pending row has been removed. */
function removedMessage(name: string): string {
  return (
    `${name} removed. It had not reached the catalog, so nothing else changes.`
  );
}

/**
 * Names the collections that have been added but are not entities yet, and says
 * which of them are still on their way and which are stuck.
 *
 * THE GAP THIS EXISTS FOR. `POST /collections` stores a row immediately;
 * `BrunoCollectionEntityProvider` turns that row into a catalog entity on its
 * own schedule, up to `bruno.schedule.frequencySeconds` later. Modal 2 explains
 * that wait, but closing modal 2 is meant to be a safe exit — the collection is
 * registered either way — and until now it landed the user on a dashboard whose
 * list was unchanged and which said nothing at all. An unchanged list is
 * indistinguishable from a create that failed.
 *
 * TWO STATES, not one, and the second is the whole reason this component grew
 * a control. A row whose name a `bruno.collections[]` entry has taken is
 * skipped by the provider on every tick — the operator's file wins, by design —
 * so it is stored forever and never becomes an entity. Describing that as
 * "appears in this list shortly" is a sentence that never comes true, and the
 * user has no other route to the row: the dashboard's Remove action is on the
 * table, gated on the ENTITY's `usebruno.com/origin`, and there is no entity.
 * So every row here — waiting or stalled — carries its own Remove, which for a
 * stalled row is the only way to clear it and for a waiting one is an immediate
 * undo of a URL typed wrong.
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
 * All three APIs are read from the holder rather than with `useApi`: a host app
 * need not register any of them, and a missing one has to cost this strip and
 * nothing else. A failed read is treated the same way — the strip renders
 * nothing. It is an aid, and there is no version of it that is worth an error
 * on a dashboard that is otherwise working.
 */
export function PendingCollections(): JSX.Element | null {
  const classes = useStyles();
  const apis = useApiHolder();
  const brunoApi = apis.get(brunoApiRef);
  const catalogApi = apis.get(catalogApiRef);
  const alertApi = apis.get(alertApiRef);
  const { backendEntities, refresh } = useEntityList();

  const [pending, setPending] = useState<StoredCollectionSummary[]>([]);

  /**
   * The provider's tick, as the backend reports it, and the only thing that
   * turns `createdAt` into a verdict. Undefined until the first successful
   * read — which is also before there is anything to classify.
   */
  const [refreshSeconds, setRefreshSeconds] = useState<number | undefined>();

  /** The row a Remove click is currently waiting on, and any message a Remove
   *  came back with. Keyed by name so a failure stays attached to the row it
   *  belongs to rather than to the strip as a whole. */
  const [removing, setRemoving] = useState<string | undefined>();
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

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
   * Names this strip has deleted and the backend has not caught up on yet.
   *
   * A poll issued BEFORE a Remove resolved still answers with the row in it,
   * and letting that answer through would redraw the row the user just removed
   * — which reads as the delete having failed, the same mistake the delete
   * dialog avoids by not refreshing the table. A name is dropped from here as
   * soon as the store stops reporting it, so this cannot mask a row that comes
   * back for a real reason.
   */
  const removedLocally = useRef<Set<string>>(new Set());

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
   * A STALLED row keeps the interval alive, which is deliberate even though
   * nothing about it is going to change on its own: the poll is also what
   * re-renders the strip, so it is what moves a row from waiting to stalled in
   * the first place, and it is what notices the row disappearing when the cause
   * is fixed elsewhere. The cost is one request every five seconds while a
   * stuck row is on screen and the Remove beside it is unclicked.
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
          const listed = await brunoApi.listCollections();
          if (cancelled) {
            return;
          }
          setRefreshSeconds(listed.refreshSeconds);

          // Pruned against the server's answer first, so a name only stays
          // suppressed for as long as the store still reports it.
          removedLocally.current = new Set(
            [...removedLocally.current].filter((name) =>
              listed.collections.some((row) => row.name === name)
            )
          );
          const stored = listed.collections.filter(
            (row) => !removedLocally.current.has(row.name)
          );

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

  /**
   * Removes a pending row.
   *
   * The row leaves the strip on success and the confirmation goes to the alert
   * bar, as it does for the table's own delete — but the sentence is a
   * different one, and has to be. That dialog warns that the entity keeps
   * appearing until the provider's next tick; here there IS no entity, which is
   * the entire reason the row was in this strip, so quoting a wait would invent
   * one.
   *
   * A failure leaves the row exactly where it is and shows the backend's
   * message against it. The message is the diagnosis — a 404 means the row went
   * while this was in flight — and there is nothing to gain from replacing it
   * with a status code.
   */
  const remove = async (name: string): Promise<void> => {
    if (!brunoApi) {
      return;
    }
    setRemoving(name);
    setRemoveErrors((errors) => {
      const { [name]: _cleared, ...rest } = errors;
      return rest;
    });
    try {
      await brunoApi.deleteCollection(name);
      removedLocally.current.add(name);
      setPending((rows) => rows.filter((row) => row.name !== name));
      watching.current.delete(name);
      alertApi?.post({
        message: removedMessage(name),
        severity: 'success',
        display: 'transient'
      });
    } catch (e) {
      setRemoveErrors((errors) => ({
        ...errors,
        [name]: e instanceof Error ? e.message : String(e)
      }));
    } finally {
      setRemoving(undefined);
    }
  };

  if (pending.length === 0) {
    return null;
  }

  return (
    <Box mb={2} className={classes.strip}>
      {pending.map((row) => {
        const stalled = rowState(row, refreshSeconds) === 'stalled';
        const error = removeErrors[row.name];
        const busy = removing === row.name;

        return (
          <div key={row.name} className={classes.row}>
            {stalled ? (
              <ErrorOutlineIcon className={classes.stalledIcon} />
            ) : (
              <CircularProgress size={16} />
            )}
            <div className={classes.message}>
              <Typography variant="body2">
                {stalled ? stalledMessage(row.name) : waitingMessage(row.name)}
              </Typography>
              {error && (
                <Typography variant="body2" color="error">
                  {error}
                </Typography>
              )}
            </div>
            <Button
              size="small"
              disabled={busy}
              onClick={() => void remove(row.name)}
            >
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        );
      })}
    </Box>
  );
}
