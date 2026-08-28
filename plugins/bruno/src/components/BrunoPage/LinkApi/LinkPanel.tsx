import { useEffect, useRef, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Button from '@material-ui/core/Button';
import TextField from '@material-ui/core/TextField';
import MenuItem from '@material-ui/core/MenuItem';
import Divider from '@material-ui/core/Divider';
import { BrunoInfoCard } from '../../BrunoInfoCard';
import {
  CollectionPickerFields,
  useCollectionPicker
} from '../../CollectionPicker';
import { brunoApiRef } from '../../../api/BrunoApi';
import type { ImportedCollection } from '../../../api/types';
import { emitConnectionChange } from '../../../lib/connectionEvents';
import { classifyLinkError } from '../../../lib/linkErrors';
import { scmProviderLabel } from '../../../lib/scmProviders';
import { useScmToken } from '../../../lib/useScmToken';

/**
 * Right panel of the Link API tab: link the selected catalog API entity to a
 * Bruno collection by repository URL. Reuses BrunoCard's gesture-safe two-step
 * connect — public path first, then an explicit "Connect <provider>" that opens the
 * OAuth popup within the click gesture for private repos.
 *
 * The flow is SCAN → pick → LINK: SCAN walks the repo for every collection root,
 * the user picks one (auto-selected when there's exactly one), and LINK stores
 * the connection for the chosen collection's fully-qualified source URL.
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
  const tokens = useScmToken();
  const picker = useCollectionPicker({
    entityRef: selectedRef,
    onLinked: () => onLinked()
  });

  // D10 additive path: link an already-imported collection directly by its
  // stored source URL (no scan). Fetched once on mount; independent of the
  // manual-URL picker above, which is left untouched.
  const [imported, setImported] = useState<ImportedCollection[]>([]);
  const [chosenId, setChosenId] = useState('');
  const [importedBusy, setImportedBusy] = useState(false);
  const [importedError, setImportedError] = useState<string | undefined>();
  const [importedLinked, setImportedLinked] = useState(false);
  const [importedNeedsAuth, setImportedNeedsAuth] = useState(false);
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

  // The imported-collection path has its own URL (the stored `sourceUrl` of the
  // row picked in the dropdown), so its provider is independent of the one in
  // the manual-URL picker above.
  const importedProviderLabel = scmProviderLabel(
    imported.find((c) => c.collectionId === chosenId)?.sourceUrl
  );

  // Shared tail of the imported-link flow. `token` is whatever the caller
  // already resolved, so this never requests a token itself and can be
  // called from either the silent or the gesture-bound path. Never logs the
  // token.
  const runLinkImported = async (entityRef: string, token?: string) => {
    const chosen = imported.find((c) => c.collectionId === chosenId);
    if (!chosen) {
      return;
    }
    setImportedError(undefined);
    setImportedNeedsAuth(false);
    try {
      await brunoApi.connect(entityRef, chosen.sourceUrl, token);
      setImportedLinked(true);
      emitConnectionChange(entityRef);
      onLinked();
    } catch (e) {
      const kind = classifyLinkError(e);
      // With no token in play a 404/403 is ambiguous: a private repo the
      // anonymous read can't see is indistinguishable from a missing one. Offer
      // the connect action instead of dead-ending on the raw message.
      if (!token && (kind === 'notFound' || kind === 'needsAuth')) {
        setImportedNeedsAuth(true);
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
      const chosen = imported.find((c) => c.collectionId === chosenId);
      const token = chosen ? await tokens.silent(chosen.sourceUrl) : undefined;
      await runLinkImported(selectedRef, token);
    } finally {
      importInFlight.current = false;
      setImportedBusy(false);
    }
  };

  // Fired from the "Connect <provider>" button after an imported link failed
  // with no token. `tokens.interactive` MUST be the first await so the consent
  // popup opens inside the click gesture; the token is reused for the retry.
  const linkImportedWithAuth = async () => {
    if (importInFlight.current || !selectedRef) {
      return;
    }
    const chosen = imported.find((c) => c.collectionId === chosenId);
    if (!chosen) {
      return;
    }
    importInFlight.current = true;
    try {
      let token: string;
      try {
        token = await tokens.interactive(chosen.sourceUrl);
      } catch (e) {
        setImportedError(
          e instanceof Error && e.message.includes('No SCM authentication')
            ? e.message
            : `${importedProviderLabel} access is needed for private `
              + `repositories — connect ${importedProviderLabel}.`
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
    <BrunoInfoCard title={`Link a Bruno collection to ${selectedName ?? '…'}`}>
      {!selectedRef ? (
        <Typography variant="body2" color="textSecondary">
          Select an API on the left to link it to a Bruno collection.
        </Typography>
      ) : (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              What linking does: SCAN walks the given GitHub, GitLab or
              Bitbucket repository for Bruno collections, then we store a
              connection from this API entity to the one you pick. On the next catalog refresh the Bruno processor
              injects the collection-path annotation and the collection surfaces
              on the entity — no pull request required.
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
                LINK
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

          {importedNeedsAuth && (
            <Grid item xs={12}>
              <Typography variant="body2" color="textSecondary">
                Couldn't read that repository anonymously — it's most likely
                private. Connect {importedProviderLabel} to link it with your
                own access.
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
            {importedNeedsAuth ? (
              <Button
                variant="contained"
                color="primary"
                onClick={linkImportedWithAuth}
                disabled={importedBusy || !chosenId}
              >
                Connect {importedProviderLabel}
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
    </BrunoInfoCard>
  );
}
