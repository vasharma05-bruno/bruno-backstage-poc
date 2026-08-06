import { useEffect, useRef, useState } from 'react';
import { InfoCard, Progress } from '@backstage/core-components';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import { brunoApiRef } from '../../../api/BrunoApi';

type State
  = | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'needsGithub' }
    | { status: 'linked' }
    | { status: 'error'; errorMsg: string };

/**
 * Right panel of the Link API tab: link the selected catalog API entity to a
 * Bruno collection by GitHub URL. Reuses BrunoCard's gesture-safe two-step
 * connect — public path first, then an explicit "Connect GitHub" that opens the
 * OAuth popup within the click gesture for private repos.
 */
export function LinkPanel(props: {
  selectedRef?: string;
  selectedName?: string;
  onLinked: () => void;
}): JSX.Element {
  const { selectedRef, selectedName, onLinked } = props;
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);

  const [state, setState] = useState<State>({ status: 'idle' });
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>();
  // Guards against concurrent/double submissions (each triggers a real backend
  // fetch and, on the private path, an OAuth popup).
  const inFlight = useRef(false);

  // Reset local state whenever the selected entity changes.
  useEffect(() => {
    setState({ status: 'idle' });
    setUrl('');
    setUrlError(undefined);
    inFlight.current = false;
  }, [selectedRef]);

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

  // Step 1: try the public / service-visible path (no user token). If it fails
  // we surface an explicit "Connect GitHub" action rather than opening the
  // OAuth popup here — browsers block popups that aren't in a click handler,
  // and this call is already past an `await`.
  const onConnect = async () => {
    if (inFlight.current || !selectedRef) {
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
      await brunoApi.connect(selectedRef, trimmed);
      setState({ status: 'linked' });
      onLinked();
    } catch {
      setState({ status: 'needsGithub' });
    } finally {
      inFlight.current = false;
    }
  };

  // Step 2 (private): fired directly from the "Connect GitHub" button so the
  // OAuth popup opens within the user gesture. `getAccessToken` MUST be the
  // first await — it opens the consent popup when GitHub isn't connected and
  // rejects if the user declines.
  const onConnectGithub = async () => {
    if (inFlight.current || !selectedRef) {
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
      await brunoApi.connect(selectedRef, trimmed, token);
      setState({ status: 'linked' });
      onLinked();
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

  const connecting = state.status === 'connecting';

  return (
    <InfoCard title={`Link a Bruno collection to ${selectedName ?? '…'}`}>
      {!selectedRef ? (
        <Typography variant="body2" color="textSecondary">
          Select an API on the left to link it to a Bruno collection.
        </Typography>
      ) : (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              What linking does: we store a connection from this API entity to
              the Bruno collection at the given GitHub repository. On the next
              catalog refresh the Bruno processor injects the
              collection-path annotation and the collection surfaces on the
              entity — no pull request required.
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
              disabled={connecting}
            />
          </Grid>

          {connecting && (
            <Grid item xs={12}>
              <Progress />
              <Typography variant="body2" color="textSecondary">
                Connecting…
              </Typography>
            </Grid>
          )}

          {state.status === 'needsGithub' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Couldn't access this repository with the portal's credentials.
                If it's private, connect your GitHub account to continue.
              </Typography>
            </Grid>
          )}

          {state.status === 'error' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="error">
                {state.errorMsg}
              </Typography>
            </Grid>
          )}

          {state.status === 'linked' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Linked. The collection will surface on this entity after the
                next catalog refresh.
              </Typography>
            </Grid>
          )}

          <Grid item xs={12}>
            {state.status === 'needsGithub' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={onConnectGithub}
              >
                Connect GitHub
              </Button>
            ) : (
              <Button
                variant="contained"
                color="primary"
                onClick={onConnect}
                disabled={!selectedRef || connecting}
              >
                LINK
              </Button>
            )}
          </Grid>
        </Grid>
      )}
    </InfoCard>
  );
}
