import { useEffect, useRef, useState } from 'react';
import { InfoCard, Link, Progress } from '@backstage/core-components';
import { githubAuthApiRef, useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import { makeStyles } from '@material-ui/core/styles';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail } from '../../api/types';
import { getCollectionId, getSourceUrl } from '../../lib/annotations';
import { emitConnectionChange } from '../../lib/connectionEvents';
import { repoRootFromCollectionUrl } from '../../lib/githubUrl';
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
    gap: theme.spacing(1)
  }
}));

/**
 * Entity card for an API entity.
 *
 * When the entity carries the `bruno.dev/collection-id` annotation it is
 * provider-materialized: the collection is fetched and rendered directly (no
 * Disconnect). Otherwise it is a runtime candidate — on mount we look up any
 * existing connection (`getConnection`) and either render it (with Disconnect)
 * or show the collection picker to scan, pick and link a GitHub collection.
 */
export function BrunoCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);
  const annotationSourceUrl = getSourceUrl(entity);
  const hasAnnotation = Boolean(annotationCollectionId);

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
        sourceUrl: rec?.githubUrl
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
              sourceUrl: record.githubUrl
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
      const token
        = (await githubAuth.getAccessToken(['repo'], { optional: true }))
          || undefined;
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

  return (
    <InfoCard title="Bruno Collection">
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
              Scan a GitHub repository for Bruno collections, then pick one to
              connect to this entity.
            </Typography>
          </Grid>

          <CollectionPickerFields picker={picker} />

          <Grid item xs={12}>
            {picker.state.status === 'needsGithubScan' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={picker.scanWithGithub}
              >
                Connect GitHub
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
            ) : picker.state.status === 'needsGithubLink' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={picker.linkWithGithub}
              >
                Connect GitHub
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
            <Typography variant="caption" color="textSecondary">
              Requests
            </Typography>
            <Typography variant="h6">
              {state.detail?.requestCount ?? '—'}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="caption" color="textSecondary">
              Source
            </Typography>
            <Typography variant="body2">
              {state.sourceUrl ? (
                <Link to={state.sourceUrl}>{shorten(state.sourceUrl)}</Link>
              ) : (
                '—'
              )}
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <Box mt={1}>
              <OpenInBruno sourceUrl={state.sourceUrl} />
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
              {!hasAnnotation && (
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
    </InfoCard>
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
