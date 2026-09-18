import { useEffect, useState } from 'react';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import ErrorOutlineIcon from '@material-ui/icons/ErrorOutline';
import { useApiHolder } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api';
import type { IncompleteRepositorySummary } from '../../api';
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
    icon: {
      color: theme.palette.warning.main,
      fontSize: 18
    }
  };
});

/**
 * The sentence one incomplete repository shows.
 *
 * THE WORD "TRUNCATED" IS DELIBERATELY ABSENT. That is GitHub's word for its
 * own API's behaviour, it appears in no screen a Backstage user has ever seen,
 * and a reader who does not already know the tree endpoint learns nothing from
 * it. What they can act on is three things, and all three are here: what was
 * lost, how much of the repository was nonetheless found, and the one
 * documented way to reach a collection past the limit.
 *
 * The count is load-bearing rather than decorative. "Some collections are
 * missing" is unactionable; "2 were found" tells an operator who knows the
 * repository whether they are missing one collection or fifty, and it is the
 * only figure available on either side — the ones that were NOT found have no
 * count, by definition.
 *
 * `found: 0` gets its own clause instead of "0 collections were found", which
 * reads as a bug rather than as a fact.
 */
function incompleteMessage(row: IncompleteRepositorySummary): string {
  const found
    = row.found === 0
      ? 'No collection was found there at all'
      : `${row.found} collection${row.found === 1 ? ' was' : 's were'} found `
        + 'there';
  return (
    `${row.repository} has more files than ${row.host} will list in one `
    + `request, so Bruno autodiscovery could not read all of it. ${found}, and `
    + 'any others in that repository are missing from this page and from the '
    + 'catalog. Add those by URL under `bruno.collections` in app-config.yaml, '
    + 'which reaches a collection directly and does not depend on the listing.'
  );
}

/**
 * Names the repositories autodiscovery read successfully and could not read all
 * of.
 *
 * THE GAP THIS EXISTS FOR. GitHub caps a recursive file listing. Past that cap
 * `bruno.discovery[]` simply stops finding collections, silently: the sweep
 * logs a warning and emits what it did find, so the dashboard shows a plausible
 * list that is quietly short. Nobody looking at the catalog can tell, because
 * the evidence is an ABSENCE.
 *
 * WHY THIS IS NOT AN ANNOTATION on an entity, which would have been the cheaper
 * build. Two reasons, and the second is decisive. Catalog processing stamps
 * annotations a cycle late, which this repository has a standing rule against
 * gating UI on — but more than that, an incomplete listing is a property of a
 * REPOSITORY, and the collections it cost do not exist as entities. There is
 * nothing to annotate. Annotating the ones that WERE found would mark exactly
 * the wrong thing: those are fine, and they are the only ones on screen.
 *
 * Renders NOTHING in the normal case, on the same terms as `PendingCollections`
 * beside it: a report of an unusual state, not furniture. An empty report, a
 * report that does not exist because `bruno.discovery[]` is unconfigured, and a
 * read that failed are all the same on screen — silence — but they are NOT the
 * same thing, and only the backend can tell them apart, which is why
 * `getDiscoveryReport` distinguishes them rather than answering `[]` for all
 * three.
 *
 * THE ONE PLACE IT DOES NOT FOLLOW THAT PRECEDENT is the timer, and it is a
 * hard difference rather than a simplification. The pending strip polls because
 * what it watches resolves on its own within a tick or two; truncation is
 * PERSISTENT — it lasts until somebody splits the repository or names its
 * collections in config — so a copied five-second poll would hold a timer on
 * every open dashboard forever to re-learn the same sentence. This fetches once
 * per mount. Nothing is lost by that: the condition cannot clear while the user
 * watches, and the fix they are being told to apply requires an
 * `app-config.yaml` edit and a restart, which reloads the page anyway.
 *
 * The API is read from the holder rather than with `useApi`, exactly as the
 * pending strip does: a host app need not have registered it, and a missing
 * registration has to cost this strip and nothing else.
 */
export function IncompleteDiscovery(): JSX.Element | null {
  const classes = useStyles();
  const apis = useApiHolder();
  const brunoApi = apis.get(brunoApiRef);

  const [incomplete, setIncomplete] = useState<IncompleteRepositorySummary[]>(
    []
  );

  useEffect(() => {
    if (!brunoApi) {
      return undefined;
    }
    let cancelled = false;

    void (async () => {
      try {
        const report = await brunoApi.getDiscoveryReport();
        if (!cancelled) {
          // `undefined` — no sweep recorded — lands here as an empty list and
          // therefore as silence, which is right: there is nothing to report.
          // What matters is that the BACKEND did not have to guess, so it never
          // told anyone that an unswept instance was a clean one.
          setIncomplete(report?.incomplete ?? []);
        }
      } catch {
        // An aid, not a feature. There is no version of this worth an error on
        // a dashboard that is otherwise working.
        if (!cancelled) {
          setIncomplete([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [brunoApi]);

  if (incomplete.length === 0) {
    return null;
  }

  return (
    <Box mb={2} className={classes.strip}>
      {incomplete.map((row) => (
        <div key={`${row.host}/${row.repository}`} className={classes.row}>
          <ErrorOutlineIcon className={classes.icon} />
          <Typography variant="body2">{incompleteMessage(row)}</Typography>
        </div>
      ))}
    </Box>
  );
}
