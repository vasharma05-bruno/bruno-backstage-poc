import { useEffect, useRef, useState } from 'react';
import { InfoCard, Link, Progress } from '@backstage/core-components';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail, ConnectResult } from '../../api/types';
import { getCollectionId, getSourceUrl } from '../../lib/annotations';
import { OpenInBruno } from '../OpenInBruno';

type State =
  | { status: 'loading' }
  | { status: 'notConnected' }
  | { status: 'needsGithub' }
  | { status: 'connecting' }
  | {
      status: 'connected';
      detail?: CollectionDetail;
      collectionId: string;
      sourceUrl?: string;
    }
  | { status: 'error'; errorMsg: string };

/**
 * Entity card for an API entity.
 *
 * When the entity carries the `bruno.dev/collection-id` annotation it is
 * provider-materialized: the collection is fetched and rendered directly (no
 * Disconnect). Otherwise it is a runtime candidate — on mount we look up any
 * existing connection (`getConnection`) and either render it (with Disconnect)
 * or show a prompt to connect a GitHub collection URL.
 */
export function BrunoCard() {
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);
  const annotationSourceUrl = getSourceUrl(entity);
  const hasAnnotation = Boolean(annotationCollectionId);

  const [state, setState] = useState<State>({ status: 'loading' });
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>();
  // Guards against concurrent/double submissions (each triggers a real backend
  // fetch and, on the private path, an OAuth popup).
  const inFlight = useRef(false);

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
          setState({ status: 'notConnected' });
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
  }, [brunoApi, entityRef, annotationCollectionId, annotationSourceUrl]);

  const validateUrl = (value: string): string | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return 'Enter a valid URL.';
    }
    if (!parsed.hostname.includes('github')) {
      return 'Enter a GitHub repository URL.';
    }
    if (parsed.pathname.includes('/blob/')) {
      return 'Enter a repository URL, not a file (/blob/) URL.';
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return 'URL must include owner and repository (owner/repo).';
    }
    return undefined;
  };

  const finishConnected = async (result: ConnectResult, sourceUrl: string) => {
    const detail = await brunoApi.getCollection(result.collectionId);
    setState({
      status: 'connected',
      detail,
      collectionId: result.collectionId,
      sourceUrl
    });
  };

  // Step 1: try the public / service-visible path (no user token). If it fails
  // we surface an explicit "Connect GitHub" action rather than opening the
  // OAuth popup here — browsers block popups that aren't in a click handler,
  // and this call is already past an `await`.
  const onConnect = async () => {
    if (inFlight.current) {
      return;
    }
    const trimmed = url.trim();
    const validationError = validateUrl(trimmed);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    setUrlError(undefined);
    inFlight.current = true;
    setState({ status: 'connecting' });
    try {
      const result = await brunoApi.connect(entityRef, trimmed);
      await finishConnected(result, trimmed);
    } catch {
      setState({ status: 'needsGithub' });
    } finally {
      inFlight.current = false;
    }
  };

  // Step 2 (private): fired directly from the "Connect GitHub" button so the
  // OAuth popup opens within the user gesture. `getAccessToken` opens the
  // consent popup when GitHub isn't connected and rejects if the user declines.
  const onConnectGithub = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    const trimmed = url.trim();
    try {
      let token: string;
      try {
        token = await githubAuth.getAccessToken(['repo']);
      } catch {
        setState({
          status: 'error',
          errorMsg: 'GitHub access needed for private repos — Connect GitHub.'
        });
        return;
      }
      setState({ status: 'connecting' });
      const result = await brunoApi.connect(entityRef, trimmed, token);
      await finishConnected(result, trimmed);
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

  const onDisconnect = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setState({ status: 'connecting' });
    try {
      await brunoApi.disconnect(entityRef);
      setUrl('');
      setState({ status: 'notConnected' });
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

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

      {state.status === 'notConnected' && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              Connect a Bruno collection from a public GitHub repository URL.
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <TextField
              fullWidth
              label="GitHub repository URL"
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              error={Boolean(urlError)}
              helperText={urlError}
            />
          </Grid>
          <Grid item xs={12}>
            <Button variant="contained" color="primary" onClick={onConnect}>
              Connect
            </Button>
          </Grid>
        </Grid>
      )}

      {state.status === 'needsGithub' && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              Couldn't access this repository with the portal's credentials. If
              it's private, connect your GitHub account to continue.
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <Button
              variant="contained"
              color="primary"
              onClick={onConnectGithub}
            >
              Connect GitHub
            </Button>
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
          {!hasAnnotation && (
            <Grid item xs={12}>
              <Button variant="outlined" onClick={onDisconnect}>
                Disconnect
              </Button>
            </Grid>
          )}
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
