import { useEffect, useRef, useState } from 'react';
import { Link, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import LaunchIcon from '@material-ui/icons/Launch';
import { makeStyles } from '@material-ui/core/styles';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail } from '../../api/types';
import {
  getCollectionId,
  getSourceUrl,
  isProviderManaged
} from '../../lib/annotations';
import { emitConnectionChange } from '../../lib/connectionEvents';
import { repoRootFromCollectionUrl } from '../../lib/scmUrl';
import { useScmToken } from '../../lib/useScmToken';
import { useBrandStyles } from '../../theme/brandStyles';
import { BrunoInfoCard } from '../BrunoInfoCard';
import { CollectionPickerFields, useCollectionPicker } from '../CollectionPicker';
import { OpenInBruno } from '../OpenInBruno';

type State
  = | { status: 'loading' }
    | { status: 'picking' }
    | { status: 'connecting' }
    | {
      status: 'connected';
      detail?: CollectionDetail;
      collectionId: string;
      sourceUrl?: string;
    }
    | { status: 'error'; errorMsg: string };

const useStyles = makeStyles((theme) => ({
  actionRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1)
  },
  metricLabel: {
    display: 'block',
    letterSpacing: 0.6,
    textTransform: 'uppercase'
  }
}));

/**
 * Entity card for an API entity.
 *
 * When the entity carries the `bruno.dev/collection-id` annotation the
 * collection is fetched and rendered directly; otherwise it is a runtime
 * candidate and on mount we look up any existing connection (`getConnection`)
 * and either render it or show the collection picker to scan, pick and link a
 * collection from any configured SCM provider.
 *
 * Whether the Disconnect / Change collection actions render is a SEPARATE
 * question, answered by provenance (`isProviderManaged`) rather than by the
 * annotation — see the note there.
 */
export function BrunoCard() {
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);
  const tokens = useScmToken();

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);
  const annotationSourceUrl = getSourceUrl(entity);
  // Whether the USER owns this link. Deliberately NOT "does the entity carry a
  // bruno.dev annotation": BrunoLinkProcessor injects the same annotations onto
  // runtime-connected entities, so that test flipped to true ~30s after any
  // connect and silently removed Disconnect / Change collection from the card.
  const userOwnsLink = !isProviderManaged(entity);

  const [state, setState] = useState<State>({ status: 'loading' });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | undefined>();
  // Guards against concurrent/double disconnects.
  const inFlight = useRef(false);

  const picker = useCollectionPicker({
    entityRef,
    onLinked: async (result) => {
      const detail = await brunoApi.getCollection(result.collectionId);
      const rec = await brunoApi.getConnection(entityRef);
      setState({
        status: 'connected',
        detail,
        collectionId: result.collectionId,
        sourceUrl: rec?.sourceUrl
      });
    }
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    if (annotationCollectionId) {
      brunoApi
        .getCollection(annotationCollectionId)
        .then((d) => {
          if (!cancelled) {
            setState({
              status: 'connected',
              detail: d,
              collectionId: annotationCollectionId,
              sourceUrl: annotationSourceUrl
            });
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setState({
              status: 'error',
              errorMsg: e instanceof Error ? e.message : String(e)
            });
          }
        });
      return () => {
        cancelled = true;
      };
    }

    brunoApi
      .getConnection(entityRef)
      .then((record) => {
        if (cancelled) {
          return undefined;
        }
        if (!record) {
          setState({ status: 'picking' });
          picker.reset();
          return undefined;
        }
        return brunoApi.getCollection(record.collectionId).then((d) => {
          if (!cancelled) {
            setState({
              status: 'connected',
              detail: d,
              collectionId: record.collectionId,
              sourceUrl: record.sourceUrl
            });
          }
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({
            status: 'error',
            errorMsg: e instanceof Error ? e.message : String(e)
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brunoApi, entityRef, annotationCollectionId, annotationSourceUrl]);

  const onDisconnect = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setState({ status: 'connecting' });
    try {
      await brunoApi.disconnect(entityRef);
      picker.reset();
      setState({ status: 'picking' });
      emitConnectionChange(entityRef);
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

  const onSync = async () => {
    if (inFlight.current || state.status !== 'connected') {
      return;
    }
    inFlight.current = true;
    setSyncing(true);
    setSyncError(undefined);
    try {
      const token = state.sourceUrl
        ? await tokens.silent(state.sourceUrl)
        : undefined;
      await brunoApi.sync(state.collectionId, token);
      const d = await brunoApi.getCollection(state.collectionId);
      setState({
        status: 'connected',
        detail: d,
        collectionId: state.collectionId,
        sourceUrl: state.sourceUrl
      });
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      inFlight.current = false;
    }
  };

  const busy
    = picker.state.status === 'scanning'
      || picker.state.status === 'connecting';

  const connectedSourceUrl
    = state.status === 'connected' ? state.sourceUrl : undefined;
  const repoUrl = connectedSourceUrl
    ? repoRootFromCollectionUrl(connectedSourceUrl)
    : undefined;
  // Only show Source separately when it points somewhere deeper than the repo
  // root (e.g. a /tree/<ref>/<subpath> collection); otherwise Repo says it all.
  const showSource = Boolean(
    connectedSourceUrl && connectedSourceUrl !== repoUrl
  );

  return (
    <BrunoInfoCard title="Bruno Collection">
      {state.status === 'loading' && <Progress />}

      {state.status === 'connecting' && (
        <>
          <Progress />
          <Typography variant="body2" color="textSecondary">
            Connecting…
          </Typography>
        </>
      )}

      {state.status === 'error' && (
        <Typography variant="body2" color="error">
          {state.errorMsg}
        </Typography>
      )}

      {state.status === 'picking' && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              Scan a GitHub, GitLab or Bitbucket repository for Bruno
              collections, then pick one to connect to this entity.
            </Typography>
          </Grid>

          <CollectionPickerFields picker={picker} />

          <Grid item xs={12}>
            {picker.state.status === 'needsAuthScan' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={picker.scanWithAuth}
              >
                Connect {picker.providerLabel}
              </Button>
            ) : picker.state.status === 'scanned' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={picker.link}
                disabled={busy || !picker.selectedCollectionId}
              >
                Link
              </Button>
            ) : picker.state.status === 'needsAuthLink' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={picker.linkWithAuth}
              >
                Connect {picker.providerLabel}
              </Button>
            ) : (
              <Button
                variant="contained"
                color="primary"
                onClick={() => picker.scan()}
                disabled={busy}
              >
                Scan
              </Button>
            )}
          </Grid>
        </Grid>
      )}

      {state.status === 'connected' && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="subtitle1">
              {state.detail?.name
                ?? entity.metadata.title
                ?? entity.metadata.name}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography
              variant="caption"
              color="textSecondary"
              className={classes.metricLabel}
            >
              Requests
            </Typography>
            <Typography variant="h5" className={brandClasses.accentFigure}>
              {state.detail?.requestCount ?? '—'}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography
              variant="caption"
              color="textSecondary"
              className={classes.metricLabel}
            >
              Repo
            </Typography>
            <Typography variant="body2">
              {repoUrl ? (
                <Link to={repoUrl}>{shorten(repoUrl)}</Link>
              ) : (
                '—'
              )}
            </Typography>
            {showSource && connectedSourceUrl && (
              <Box mt={1}>
                <Typography variant="caption" color="textSecondary">
                  Source
                </Typography>
                <Typography variant="body2">
                  <Link to={connectedSourceUrl}>
                    {shorten(connectedSourceUrl)}
                  </Link>
                </Typography>
              </Box>
            )}
          </Grid>
          <Grid item xs={12}>
            <Box mt={1} className={classes.actionRow}>
              <OpenInBruno sourceUrl={state.sourceUrl} />
              <Button
                variant="outlined"
                className={brandClasses.accentOutlinedButton}
                startIcon={<LaunchIcon />}
                onClick={() =>
                  window.open(
                    `/bruno/docs/${encodeURIComponent(state.collectionId)}`,
                    '_blank',
                    'noopener,noreferrer'
                  )}
              >
                View collection
              </Button>
            </Box>
          </Grid>
          <Grid item xs={12}>
            <Box className={classes.actionRow}>
              <Button
                variant="outlined"
                onClick={onSync}
                disabled={syncing}
              >
                Sync
              </Button>
              {userOwnsLink && (
                <>
                  <Button variant="outlined" onClick={onDisconnect}>
                    Disconnect
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => {
                      const root = repoRootFromCollectionUrl(
                        state.sourceUrl ?? ''
                      );
                      picker.reset(root);
                      setState({ status: 'picking' });
                      void picker.scan(root);
                    }}
                  >
                    Change collection
                  </Button>
                </>
              )}
            </Box>
            {syncError && (
              <Typography variant="body2" color="error">
                {syncError}
              </Typography>
            )}
          </Grid>
        </Grid>
      )}
    </BrunoInfoCard>
  );
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}
