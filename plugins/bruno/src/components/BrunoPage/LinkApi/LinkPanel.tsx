import { useEffect, useRef, useState } from 'react';
import { InfoCard } from '@backstage/core-components';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Button from '@material-ui/core/Button';
import TextField from '@material-ui/core/TextField';
import MenuItem from '@material-ui/core/MenuItem';
import Divider from '@material-ui/core/Divider';
import {
  CollectionPickerFields,
  useCollectionPicker
} from '../../CollectionPicker';
import { brunoApiRef } from '../../../api/BrunoApi';
import type { ImportedCollection } from '../../../api/types';
import { emitConnectionChange } from '../../../lib/connectionEvents';
import { classifyLinkError } from '../../../lib/linkErrors';

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
  preselectImportedCollectionId?: string;
}): JSX.Element {
  const {
    selectedRef,
    selectedName,
    onLinked,
    preselectImportedCollectionId
  } = props;
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);
  const picker = useCollectionPicker({
    entityRef: selectedRef,
    onLinked: () => onLinked()
  });

  // D10 additive path: link an already-imported collection directly by its
  // stored GitHub URL (no scan). Fetched once on mount; independent of the
  // manual-URL picker above, which is left untouched.
  const [imported, setImported] = useState<ImportedCollection[]>([]);
  const [chosenId, setChosenId] = useState('');
  const [importedBusy, setImportedBusy] = useState(false);
  const [importedError, setImportedError] = useState<string | undefined>();
  const [importedLinked, setImportedLinked] = useState(false);
  const [importedNeedsGithub, setImportedNeedsGithub] = useState(false);
  const importInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    brunoApi
      .getImportedCollections()
      .then((rows) => {
        if (!cancelled) {
          setImported(rows);
        }
      })
      .catch(() => {
        // Non-fatal: the imported dropdown just stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi]);

  // Preselect the deep-linked imported collection once its row is loaded.
  useEffect(() => {
    if (
      preselectImportedCollectionId
      && imported.some(
        (c) => c.collectionId === preselectImportedCollectionId
      )
    ) {
      setChosenId(preselectImportedCollectionId);
    }
  }, [preselectImportedCollectionId, imported]);

  // Reset local state whenever the selected entity changes.
  useEffect(() => {
    picker.reset();
    setChosenId('');
    setImportedError(undefined);
    setImportedLinked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRef]);

  const busy
    = picker.state.status === 'scanning'
      || picker.state.status === 'connecting';

  // Shared tail of the imported-link flow. `token` is whatever the caller
  // already resolved, so this never awaits `getAccessToken` itself and can be
  // called from either the silent or the gesture-bound path. Never logs the
  // token.
  const runLinkImported = async (entityRef: string, token?: string) => {
    const chosen = imported.find((c) => c.collectionId === chosenId);
    if (!chosen) {
      return;
    }
    setImportedError(undefined);
    setImportedNeedsGithub(false);
    try {
      await brunoApi.connect(entityRef, chosen.sourceUrl, token);
      setImportedLinked(true);
      emitConnectionChange(entityRef);
      onLinked();
    } catch (e) {
      const kind = classifyLinkError(e);
      // With no token in play a 404/403 is ambiguous: a private repo the
      // anonymous read can't see is indistinguishable from a missing one. Offer
      // the Connect GitHub action instead of dead-ending on the raw message.
      if (!token && (kind === 'notFound' || kind === 'needsAuth')) {
        setImportedNeedsGithub(true);
      } else {
        setImportedError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // Link a chosen imported collection directly (no scan): the imported row
  // already carries the fully-qualified sourceUrl. Silent-token first (no
  // popup); import stored a public/private URL, connect tops up if a session
  // exists.
  const linkImported = async () => {
    if (importInFlight.current || !selectedRef) {
      return;
    }
    importInFlight.current = true;
    setImportedBusy(true);
    try {
      const token
        = (await githubAuth.getAccessToken(['repo'], { optional: true }))
          || undefined;
      await runLinkImported(selectedRef, token);
    } finally {
      importInFlight.current = false;
      setImportedBusy(false);
    }
  };

  // Fired from the "Connect GitHub" button after an imported link failed with no
  // token. `getAccessToken` MUST be the first await so the consent popup opens
  // inside the click gesture; the token is reused for the retry.
  const linkImportedWithGithub = async () => {
    if (importInFlight.current || !selectedRef) {
      return;
    }
    importInFlight.current = true;
    try {
      let token: string;
      try {
        token = await githubAuth.getAccessToken(['repo']);
      } catch {
        setImportedError(
          'GitHub access needed for private repos — Connect GitHub.'
        );
        return;
      }
      setImportedBusy(true);
      await runLinkImported(selectedRef, token);
    } finally {
      importInFlight.current = false;
      setImportedBusy(false);
    }
  };

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
                LINK
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
                disabled={!selectedRef || busy}
              >
                SCAN
              </Button>
            )}
          </Grid>

          <Grid item xs={12}>
            <Divider />
          </Grid>

          <Grid item xs={12}>
            <Typography variant="subtitle2" gutterBottom>
              Link an already-imported collection
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Pick a collection imported via "Add collection" to link it to
              this API directly — no scan needed.
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <TextField
              select
              fullWidth
              label="Imported collection"
              value={chosenId}
              onChange={(e) => setChosenId(e.target.value)}
              disabled={importedBusy || imported.length === 0}
              helperText={
                imported.length === 0
                  ? 'No imported collections yet.'
                  : undefined
              }
            >
              {imported.map((c) => (
                <MenuItem key={c.collectionId} value={c.collectionId}>
                  {c.name}
                  <Typography
                    variant="caption"
                    color="textSecondary"
                    style={{ marginLeft: 8 }}
                  >
                    {c.sourceUrl}
                  </Typography>
                </MenuItem>
              ))}
            </TextField>
          </Grid>

          {importedError && (
            <Grid item xs={12}>
              <Typography variant="body2" color="error">
                {importedError}
              </Typography>
            </Grid>
          )}

          {importedNeedsGithub && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Couldn't read that repository anonymously — it's most likely
                private. Connect GitHub to link it with your own access.
              </Typography>
            </Grid>
          )}

          {importedLinked && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Linked. The collection will surface on this entity after the
                next catalog refresh.
              </Typography>
            </Grid>
          )}

          <Grid item xs={12}>
            {importedNeedsGithub ? (
              <Button
                variant="contained"
                color="primary"
                onClick={linkImportedWithGithub}
                disabled={importedBusy || !chosenId}
              >
                Connect GitHub
              </Button>
            ) : (
              <Button
                variant="contained"
                color="primary"
                onClick={linkImported}
                disabled={importedBusy || !chosenId}
              >
                Link this collection
              </Button>
            )}
          </Grid>
        </Grid>
      )}
    </InfoCard>
  );
}
