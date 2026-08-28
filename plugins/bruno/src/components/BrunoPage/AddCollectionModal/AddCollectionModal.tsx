import { useRef, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
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
import { makeStyles } from '@material-ui/core/styles';
import { brunoApiRef } from '../../../api/BrunoApi';
import { classifyLinkError } from '../../../lib/linkErrors';
import {
  scmProviderLabel,
  validateScmRepoUrl
} from '../../../lib/scmProviders';
import { useScmToken } from '../../../lib/useScmToken';
import { brunoBrand } from '../../../theme/brand';
import { useBrandStyles } from '../../../theme/brandStyles';
import { BrunoIcon } from '../../BrunoLogo';
import type { DiscoveredCollection } from '../../../api/types';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    // Same accent rule the Bruno cards carry, so the modal reads as Bruno's
    // without dressing up the stock Material-UI dialog any further.
    paper: {
      borderTop: `3px solid ${brand.accent}`
    },
    titleRow: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1)
    },
    titleMark: {
      fontSize: 24
    }
  };
});

type State
  = | { status: 'idle' }
    | { status: 'scanning' }
    | { status: 'needsAuth' }
    | { status: 'scanned'; collections: DiscoveredCollection[] }
    | { status: 'noCollections' }
    | { status: 'importing' }
    | { status: 'error'; errorMsg: string };

/**
 * Add-collection modal (N3-P3, Feature B): scan a GitHub, GitLab or Bitbucket
 * repository for Bruno collections and import one or more as
 * imported-but-unlinked records. A
 * dedicated component that reuses only `brunoApi.discover` + `importCollections`
 * (NOT `useCollectionPicker`, which is a single-entity SCAN→pick→LINK machine).
 *
 * The scan is gesture-safe: it tries a silent token as the first await; if that
 * fails it surfaces an explicit "Connect <provider>" button whose handler makes
 * `tokens.interactive(url)` its first await so the OAuth popup stays within the
 * user gesture. The token is held locally and never
 * logged. Import itself needs no token — it stores only name + URL.
 */
export function AddCollectionModal(props: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}): JSX.Element {
  const { open, onClose, onImported } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const brunoApi = useApi(brunoApiRef);
  const tokens = useScmToken();

  const [url, setUrl] = useState('');
  const providerLabel = scmProviderLabel(url.trim());
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
  // opens a popup (yields undefined with no session). On failure, surface the
  // explicit "Connect <provider>" action.
  const scan = async () => {
    if (inFlight.current) {
      return;
    }
    const trimmed = url.trim();
    const validationError = validateScmRepoUrl(trimmed);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    setUrlError(undefined);
    inFlight.current = true;
    setState({ status: 'scanning' });
    // Declared outside the try so the catch can tell "failed anonymously"
    // (ambiguous — offer the connect gate) from "failed with the user's own
    // token" (a real error worth showing).
    let token: string | undefined;
    try {
      token = await tokens.silent(trimmed);
      const result = token
        ? await brunoApi.discover(trimmed, token)
        : await brunoApi.discover(trimmed);
      resolveScan(result.collections);
    } catch (e) {
      // A failure with no token in play is ambiguous — most likely a private
      // repo — so offer the connect gate. A failure WITH a token, or one that is
      // a provider/configuration problem no consent can fix, is a real error and
      // its message is what helps; re-offering consent would just loop. (Private
      // Bitbucket Cloud lands here: its reader cannot use a per-user token.)
      setState(
        token || classifyLinkError(e) === 'configError'
          ? {
              status: 'error',
              errorMsg: e instanceof Error ? e.message : String(e)
            }
          : { status: 'needsAuth' }
      );
    } finally {
      inFlight.current = false;
    }
  };

  // Explicit gesture path: fired from the "Connect <provider>" button so the
  // OAuth popup opens within the click gesture. `tokens.interactive` MUST be the
  // first await — it opens consent when the provider isn't connected and rejects
  // if the user declines.
  const scanWithAuth = async () => {
    if (inFlight.current) {
      return;
    }
    const trimmed = url.trim();
    // Validate BEFORE the token request: a malformed URL cannot be fixed by
    // consent, and this keeps the popup from opening for nothing. Synchronous,
    // so `tokens.interactive` remains the handler's first await.
    const validationError = validateScmRepoUrl(trimmed);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    inFlight.current = true;
    try {
      let token: string;
      try {
        token = await tokens.interactive(trimmed);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        setState({
          status: 'error',
          errorMsg: detail.includes('No SCM authentication')
            ? detail
            : `${providerLabel} access is needed for private repositories `
              + `— connect ${providerLabel}.`
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
          sourceUrl: c.sourceUrl,
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
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ className: classes.paper }}
    >
      <DialogTitle disableTypography>
        <Box className={classes.titleRow}>
          <BrunoIcon className={classes.titleMark} />
          <Typography variant="h6">Add collection</Typography>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Box mb={2}>
          <TextField
            fullWidth
            label="Repository URL"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={Boolean(urlError)}
            helperText={
              urlError ?? 'A GitHub, GitLab or Bitbucket repository URL.'
            }
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

        {state.status === 'needsAuth' && (
          <Box mb={2}>
            <Typography variant="body2" color="textSecondary">
              Couldn't access this repository with the portal's credentials.
              If it's private, connect your {providerLabel} account to continue.
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
        {state.status === 'needsAuth' ? (
          <Button
            variant="contained"
            color="primary"
            onClick={scanWithAuth}
          >
            Connect {providerLabel}
          </Button>
        ) : collections.length > 0 ? (
          <Button
            variant="contained"
            className={brandClasses.accentButton}
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
