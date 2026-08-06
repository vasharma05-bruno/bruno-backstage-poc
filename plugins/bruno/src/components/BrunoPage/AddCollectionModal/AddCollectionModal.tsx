import { useRef, useState } from 'react';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import { Progress } from '@backstage/core-components';
import Dialog from '@material-ui/core/Dialog';
import DialogTitle from '@material-ui/core/DialogTitle';
import DialogContent from '@material-ui/core/DialogContent';
import DialogActions from '@material-ui/core/DialogActions';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import Checkbox from '@material-ui/core/Checkbox';
import FormControlLabel from '@material-ui/core/FormControlLabel';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import { brunoApiRef } from '../../../api/BrunoApi';
import type { DiscoveredCollection } from '../../../api/types';

type State
  = | { status: 'idle' }
    | { status: 'scanning' }
    | { status: 'needsGithub' }
    | { status: 'scanned'; collections: DiscoveredCollection[] }
    | { status: 'noCollections' }
    | { status: 'importing' }
    | { status: 'error'; errorMsg: string };

/** Light GitHub-repo URL check (mirrors useCollectionPicker.validateUrl). */
function validateUrl(value: string): string | undefined {
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
}

/**
 * Add-collection modal (N3-P3, Feature B): scan a GitHub repository for Bruno
 * collections and import one or more as imported-but-unlinked records. A
 * dedicated component that reuses only `brunoApi.discover` + `importCollections`
 * (NOT `useCollectionPicker`, which is a single-entity SCAN→pick→LINK machine).
 *
 * The scan is gesture-safe: it tries a silent (`{ optional: true }`) token as the
 * first await; if that fails it surfaces an explicit "Connect GitHub" button
 * whose handler makes `getAccessToken(['repo'])` its first await so the OAuth
 * popup stays within the user gesture. The token is held locally and never
 * logged. Import itself needs no token — it stores only name + URL.
 */
export function AddCollectionModal(props: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}): JSX.Element {
  const { open, onClose, onImported } = props;
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);

  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>();
  const [state, setState] = useState<State>({ status: 'idle' });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const inFlight = useRef(false);

  const collections
    = state.status === 'scanned' ? state.collections : [];
  const selectedCollections = collections.filter(
    (c) => selected[c.collectionId]
  );
  const allSelected
    = collections.length > 0
      && collections.every((c) => selected[c.collectionId]);

  const resolveScan = (found: DiscoveredCollection[]) => {
    setSelected({});
    if (found.length === 0) {
      setState({ status: 'noCollections' });
      return;
    }
    setState({ status: 'scanned', collections: found });
  };

  // Silent-token path: the FIRST await is an optional token fetch that never
  // opens a popup (returns '' with no session). On failure, surface the explicit
  // "Connect GitHub" action.
  const scan = async () => {
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
    setState({ status: 'scanning' });
    try {
      const token = await githubAuth.getAccessToken(['repo'], {
        optional: true
      });
      const result = token
        ? await brunoApi.discover(trimmed, token)
        : await brunoApi.discover(trimmed);
      resolveScan(result.collections);
    } catch {
      setState({ status: 'needsGithub' });
    } finally {
      inFlight.current = false;
    }
  };

  // Explicit gesture path: fired from the "Connect GitHub" button so the OAuth
  // popup opens within the click gesture. `getAccessToken(['repo'])` MUST be the
  // first await — it opens consent when GitHub isn't connected and rejects if the
  // user declines.
  const scanWithGithub = async () => {
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

  const toggleOne = (collectionId: string) => {
    setSelected((prev) => ({
      ...prev,
      [collectionId]: !prev[collectionId]
    }));
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const c of collections) {
      next[c.collectionId] = true;
    }
    setSelected(next);
  };

  const importSelected = async () => {
    if (inFlight.current || selectedCollections.length === 0) {
      return;
    }
    inFlight.current = true;
    setState({ status: 'importing' });
    try {
      await brunoApi.importCollections(
        selectedCollections.map((c) => ({
          githubUrl: c.githubUrl,
          name: c.name
        }))
      );
      onImported();
      handleClose();
    } catch (e) {
      setState({
        status: 'error',
        errorMsg: e instanceof Error ? e.message : String(e)
      });
    } finally {
      inFlight.current = false;
    }
  };

  const handleClose = () => {
    setUrl('');
    setUrlError(undefined);
    setState({ status: 'idle' });
    setSelected({});
    inFlight.current = false;
    onClose();
  };

  const busy
    = state.status === 'scanning' || state.status === 'importing';

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add collection</DialogTitle>
      <DialogContent>
        <Box mb={2}>
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
        </Box>

        {busy && (
          <Box mb={2}>
            <Progress />
            <Typography variant="body2" color="textSecondary">
              {state.status === 'scanning' ? 'Scanning…' : 'Importing…'}
            </Typography>
          </Box>
        )}

        {state.status === 'needsGithub' && (
          <Box mb={2}>
            <Typography variant="body2" color="textSecondary">
              Couldn't access this repository with the portal's credentials.
              If it's private, connect your GitHub account to continue.
            </Typography>
          </Box>
        )}

        {state.status === 'noCollections' && (
          <Box mb={2}>
            <Typography variant="body2" color="textSecondary">
              No Bruno collections found in that repository.
            </Typography>
          </Box>
        )}

        {state.status === 'error' && (
          <Box mb={2}>
            <Typography variant="body2" color="error">
              {state.errorMsg}
            </Typography>
          </Box>
        )}

        {collections.length > 0 && (
          <Box>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={allSelected}
                  indeterminate={
                    selectedCollections.length > 0 && !allSelected
                  }
                  onChange={toggleAll}
                />
              )}
              label="Select all"
            />
            <List dense>
              {collections.map((c) => (
                <ListItem key={c.collectionId} disableGutters>
                  <FormControlLabel
                    control={(
                      <Checkbox
                        checked={Boolean(selected[c.collectionId])}
                        onChange={() => toggleOne(c.collectionId)}
                      />
                    )}
                    label={(
                      <span>
                        {c.name}
                        <Typography
                          variant="caption"
                          color="textSecondary"
                          style={{ marginLeft: 8 }}
                        >
                          {c.collectionPath || '(root)'} · {c.requestCount}{' '}
                          requests
                        </Typography>
                      </span>
                    )}
                  />
                </ListItem>
              ))}
            </List>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        {state.status === 'needsGithub' ? (
          <Button
            variant="contained"
            color="primary"
            onClick={scanWithGithub}
          >
            Connect GitHub
          </Button>
        ) : collections.length > 0 ? (
          <Button
            variant="contained"
            color="primary"
            onClick={importSelected}
            disabled={busy || selectedCollections.length === 0}
          >
            Import selected
          </Button>
        ) : (
          <Button
            variant="contained"
            color="primary"
            onClick={scan}
            disabled={busy || !url.trim()}
          >
            Scan
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
