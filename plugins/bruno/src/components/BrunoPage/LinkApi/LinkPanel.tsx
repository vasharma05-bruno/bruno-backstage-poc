import { useEffect } from 'react';
import { InfoCard } from '@backstage/core-components';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Button from '@material-ui/core/Button';
import {
  CollectionPickerFields,
  useCollectionPicker
} from '../../CollectionPicker';

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
  const picker = useCollectionPicker({
    entityRef: selectedRef,
    onLinked: () => onLinked()
  });

  // Reset local state whenever the selected entity changes.
  useEffect(() => {
    picker.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRef]);

  const busy
    = picker.state.status === 'scanning'
      || picker.state.status === 'connecting';

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
        </Grid>
      )}
    </InfoCard>
  );
}
