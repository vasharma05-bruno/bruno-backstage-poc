import { useEffect, useRef, useState } from 'react';
import { InfoCard, Progress } from '@backstage/core-components';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import TextField from '@material-ui/core/TextField';
import MenuItem from '@material-ui/core/MenuItem';
import Button from '@material-ui/core/Button';
import { brunoApiRef } from '../../../api/BrunoApi';
import type { DiscoveredCollection } from '../../../api/types';

type State
  = | { status: 'idle' }
    | { status: 'scanning' }
    | { status: 'needsGithubScan' }
    | { status: 'scanned'; collections: DiscoveredCollection[] }
    | { status: 'noCollections' }
    | { status: 'connecting' }
    | { status: 'needsGithubLink' }
    | { status: 'linked' }
    | { status: 'error'; errorMsg: string };

/**
 * Right panel of the Link API tab: link the selected catalog API entity to a
 * Bruno collection by GitHub URL. Reuses BrunoCard's gesture-safe two-step
 * connect — public path first, then an explicit "Connect GitHub" that opens the
 * OAuth popup within the click gesture for private repos.
 *
 * The flow is SCAN → pick → LINK: SCAN walks the repo for every collection root,
 * the user picks one (auto-selected when there's exactly one), and LINK stores
 * the connection for the chosen collection's fully-qualified GitHub URL.
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
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  // Guards against concurrent/double submissions (each triggers a real backend
  // fetch and, on the private path, an OAuth popup).
  const inFlight = useRef(false);
  // Holds the user OAuth token from a private scan so the subsequent LINK can
  // reuse it without a second consent popup. Never logged.
  const scanTokenRef = useRef<string | undefined>(undefined);

  // Reset local state whenever the selected entity changes.
  useEffect(() => {
    setState({ status: 'idle' });
    setUrl('');
    setUrlError(undefined);
    setSelectedCollectionId('');
    inFlight.current = false;
    scanTokenRef.current = undefined;
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

  // Resolves a scan result: 0 roots → nothing to link; 1 → auto-select; >1 →
  // show the picker with LINK disabled until the user chooses.
  const resolveScan = (collections: DiscoveredCollection[]) => {
    if (collections.length === 0) {
      setSelectedCollectionId('');
      setState({ status: 'noCollections' });
      return;
    }
    if (collections.length === 1) {
      setSelectedCollectionId(collections[0].collectionId);
    } else {
      setSelectedCollectionId('');
    }
    setState({ status: 'scanned', collections });
  };

  // Step 1: try the public / service-visible path (no user token). If it fails
  // we surface an explicit "Connect GitHub" action rather than opening the
  // OAuth popup here — browsers block popups that aren't in a click handler,
  // and this call is already past an `await`.
  const onScan = async () => {
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
    scanTokenRef.current = undefined;
    inFlight.current = true;
    setState({ status: 'scanning' });
    try {
      const result = await brunoApi.discover(trimmed);
      resolveScan(result.collections);
    } catch {
      setState({ status: 'needsGithubScan' });
    } finally {
      inFlight.current = false;
    }
  };

  // Step 1 (private): fired directly from the "Connect GitHub" button so the
  // OAuth popup opens within the user gesture. `getAccessToken` MUST be the
  // first await — it opens the consent popup when GitHub isn't connected and
  // rejects if the user declines. The token is held for the subsequent LINK.
  const onScanGithub = async () => {
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
      scanTokenRef.current = token;
      setState({ status: 'scanning' });
      const result = await brunoApi.discover(trimmed, token);
      resolveScan(result.collections);
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

  // Step 2: link the chosen collection. Reuses the private-scan token (if any)
  // so private repos don't prompt twice. If the link fails without a token, the
  // repo likely needs GitHub access — surface the Connect GitHub action.
  const onLink = async () => {
    if (inFlight.current || !selectedRef || state.status !== 'scanned') {
      return;
    }
    const chosen = state.collections.find(
      (c) => c.collectionId === selectedCollectionId
    );
    if (!chosen) {
      return;
    }
    inFlight.current = true;
    setState({ status: 'connecting' });
    try {
      await brunoApi.connect(
        selectedRef,
        chosen.githubUrl,
        scanTokenRef.current
      );
      setState({ status: 'linked' });
      onLinked();
    } catch (e) {
      if (scanTokenRef.current) {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      } else {
        setState({ status: 'needsGithubLink' });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Fired from the "Connect GitHub" button after a link failed without a token.
  // `getAccessToken` MUST be the first await so the popup stays within the click
  // gesture. The token is reused for the retry.
  const onLinkGithub = async () => {
    if (inFlight.current || !selectedRef || state.status !== 'needsGithubLink') {
      return;
    }
    inFlight.current = true;
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
      scanTokenRef.current = token;
      // Re-scan with the token so we have the chosen collection's github URL,
      // then link it. The scan is cheap and keeps the chosen path valid.
      const trimmed = url.trim();
      setState({ status: 'connecting' });
      const result = await brunoApi.discover(trimmed, token);
      const chosen = result.collections.find(
        (c) => c.collectionId === selectedCollectionId
      );
      if (!chosen) {
        setState({
          status: 'error',
          errorMsg:
            'The selected collection was no longer found on re-scan. '
            + 'Please scan again and pick a collection.'
        });
        return;
      }
      await brunoApi.connect(selectedRef, chosen.githubUrl, token);
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

  const busy = state.status === 'scanning' || state.status === 'connecting';
  const scanned = state.status === 'scanned' ? state : undefined;
  const multiple = (scanned?.collections.length ?? 0) > 1;

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
              What linking does: SCAN walks the given GitHub repository for Bruno
              collections, then we store a connection from this API entity to the
              one you pick. On the next catalog refresh the Bruno processor
              injects the collection-path annotation and the collection surfaces
              on the entity — no pull request required.
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
              disabled={busy}
            />
          </Grid>

          {busy && (
            <Grid item xs={12}>
              <Progress />
              <Typography variant="body2" color="textSecondary">
                {state.status === 'scanning' ? 'Scanning…' : 'Connecting…'}
              </Typography>
            </Grid>
          )}

          {state.status === 'needsGithubScan' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Couldn't access this repository with the portal's credentials.
                If it's private, connect your GitHub account to continue.
              </Typography>
            </Grid>
          )}

          {state.status === 'noCollections' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                No Bruno collections found in that repository.
              </Typography>
            </Grid>
          )}

          {scanned && multiple && (
            <Grid item xs={12}>
              <TextField
                select
                fullWidth
                label="Collection"
                value={selectedCollectionId}
                onChange={(e) => setSelectedCollectionId(e.target.value)}
                disabled={busy}
              >
                {scanned.collections.map((c) => (
                  <MenuItem key={c.collectionId} value={c.collectionId}>
                    {c.name}
                    <Typography
                      variant="caption"
                      color="textSecondary"
                      style={{ marginLeft: 8 }}
                    >
                      {c.collectionPath || '(root)'} · {c.requestCount} requests
                    </Typography>
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          )}

          {scanned && !multiple && scanned.collections[0] && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Found <strong>{scanned.collections[0].name}</strong> (
                {scanned.collections[0].collectionPath || '(root)'} ·{' '}
                {scanned.collections[0].requestCount} requests).
              </Typography>
            </Grid>
          )}

          {state.status === 'needsGithubLink' && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Couldn't link with the portal's credentials. If the repository is
                private, connect your GitHub account to continue.
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
            {state.status === 'needsGithubScan' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={onScanGithub}
              >
                Connect GitHub
              </Button>
            ) : state.status === 'scanned' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={onLink}
                disabled={busy || !selectedCollectionId}
              >
                LINK
              </Button>
            ) : state.status === 'needsGithubLink' ? (
              <Button
                variant="contained"
                color="primary"
                onClick={onLinkGithub}
              >
                Connect GitHub
              </Button>
            ) : (
              <Button
                variant="contained"
                color="primary"
                onClick={onScan}
                disabled={!selectedRef || busy}
              >
                SCAN
              </Button>
            )}
          </Grid>
        </Grid>
      )}
    </InfoCard>
  );
}
