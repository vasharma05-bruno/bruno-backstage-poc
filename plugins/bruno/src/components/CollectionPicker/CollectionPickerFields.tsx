import { Progress } from '@backstage/core-components';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import TextField from '@material-ui/core/TextField';
import MenuItem from '@material-ui/core/MenuItem';
import type { CollectionPickerApi } from './useCollectionPicker';

/**
 * Presentational, host-agnostic fields for the collection picker. Renders the
 * URL input, busy indicator, status messages, the >1 dropdown and the 1-found
 * summary — driven entirely by the hook api. The SCAN/LINK/Connect-GitHub
 * buttons stay host-side so their gesture handlers wire directly to
 * `picker.scanWithGithub` / `picker.linkWithGithub`.
 */
export function CollectionPickerFields(props: {
  picker: CollectionPickerApi;
  disabled?: boolean;
}): JSX.Element {
  const { picker, disabled } = props;
  const { state } = picker;
  const busy = state.status === 'scanning' || state.status === 'connecting';
  const scanned = state.status === 'scanned' ? state : undefined;
  const multiple = (scanned?.collections.length ?? 0) > 1;

  return (
    <>
      <Grid item xs={12}>
        <TextField
          fullWidth
          label="GitHub repository URL"
          placeholder="https://github.com/owner/repo"
          value={picker.url}
          onChange={(e) => picker.setUrl(e.target.value)}
          error={Boolean(picker.urlError)}
          helperText={picker.urlError}
          disabled={busy || disabled}
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
            value={picker.selectedCollectionId}
            onChange={(e) => picker.setSelectedCollectionId(e.target.value)}
            disabled={busy || disabled}
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
    </>
  );
}
