import { useState } from 'react';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api';

const useStyles = makeStyles((theme) => ({
  section: {
    marginTop: theme.spacing(2)
  },
  danger: {
    color: theme.palette.error.main
  }
}));

/** What the dialog is doing right now. */
type Stage
  = | { status: 'confirm' }
    | { status: 'deleting' }
    | { status: 'deleted'; refreshSeconds: number }
    | { status: 'error'; message: string };

/** The sentence both the `deleted` stage and the alert say. */
function removedMessage(name: string, refreshSeconds: number): string {
  return (
    `${name} removed. It disappears from this list within `
    + `${refreshSeconds} seconds.`
  );
}

/**
 * Confirms removing a collection that was added from this dashboard.
 *
 * Only ever opened for a `usebruno.com/origin: ui` entity — see the action's
 * `hidden` gate in `BrunoPage` — because this deletes the STORE ROW that
 * produces the entity, and a collection that came from `app-config.yaml` or
 * from a committed descriptor has no such row.
 *
 * Two things the copy has to be straight about, because both are counter to
 * what a delete button normally means:
 *
 *  - Nothing in source control is touched. The collection folder stays, and so
 *    does any `catalog-info.yaml` the user committed for it through modal 2.
 *    All that goes is Backstage's record of it.
 *  - The row does not vanish from the table. `BrunoCollectionEntityProvider`
 *    emits its `full` mutation on a schedule, and only then does the catalog
 *    prune the entity, so the collection the user just deleted is still listed
 *    for up to `bruno.schedule.frequencySeconds` afterwards. Saying so before
 *    the click is the difference between a wait and a bug report.
 *
 * The confirm copy quotes "about a minute" rather than the configured figure:
 * the dashboard has no create response to read it from, and the alternatives
 * are a config read or a round trip made purely to fill in a number. The
 * `DELETE` response carries the real interval, so the confirmation that follows
 * the click quotes it exactly.
 */
export function DeleteCollectionDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The Bruno entity whose stored row is to be removed. */
  entity: Entity;
}): JSX.Element {
  const { open, onClose, entity } = props;
  const classes = useStyles();
  const brunoApi = useApi(brunoApiRef);
  const alertApi = useApi(alertApiRef);

  const [stage, setStage] = useState<Stage>({ status: 'confirm' });

  const name = entity.metadata.name;

  const close = (): void => {
    setStage({ status: 'confirm' });
    onClose();
  };

  /**
   * Deletes, then hands the outcome to the alert bar rather than to this
   * dialog.
   *
   * The dialog closes on success on purpose: what the user needs afterwards is
   * a durable sentence about a list that has NOT changed yet, and an alert
   * outlives the dialog while a modal confirmation would have to be dismissed
   * before the table it is talking about is visible again.
   *
   * Deliberately NOT followed by `useEntityList().refresh()`. The entity is
   * still in the catalog until the provider's next tick, so refreshing would
   * refetch the same row and redraw it — which reads as the delete having
   * failed. Leaving the stale row alone and explaining it in the alert is the
   * accurate thing to show.
   */
  const remove = async (): Promise<void> => {
    setStage({ status: 'deleting' });
    try {
      const { refreshSeconds } = await brunoApi.deleteCollection(name);
      setStage({ status: 'deleted', refreshSeconds });
      alertApi.post({
        message: removedMessage(name, refreshSeconds),
        severity: 'success',
        display: 'transient'
      });
      onClose();
    } catch (e) {
      setStage({
        status: 'error',
        message: e instanceof Error ? e.message : String(e)
      });
    }
  };

  const deleting = stage.status === 'deleting';

  let content: JSX.Element;
  if (stage.status === 'deleted') {
    // Normally unseen — the parent unmounts this on `onClose`. Rendered anyway
    // so the dialog does not depend on the parent doing so to stop offering a
    // Remove button for a collection that is already gone.
    content = (
      <Typography variant="body2">
        {removedMessage(name, stage.refreshSeconds)}
      </Typography>
    );
  } else {
    content = (
      <>
        <Typography variant="body2">
          Removing <strong>{name}</strong> deletes the record Backstage created
          when you added it from this dashboard. The collection in source
          control is untouched, and any <code>catalog-info.yaml</code> you
          committed for it is untouched. The entity disappears from the catalog
          on the next refresh — about a minute by default.
        </Typography>
        {stage.status === 'error' && (
          // Verbatim, because the message is the diagnosis. A 404 here means
          // the entity claims `usebruno.com/origin: ui` but has no stored row —
          // a hand-authored descriptor is allowed to declare that origin — and
          // the route's own wording says which file to edit instead.
          <Typography
            variant="body2"
            color="error"
            className={classes.section}
          >
            {stage.message}
          </Typography>
        )}
      </>
    );
  }

  return (
    <Dialog
      open={open}
      maxWidth="sm"
      fullWidth
      disableBackdropClick={deleting}
      disableEscapeKeyDown={deleting}
      onClose={close}
    >
      <DialogTitle>Remove {name}?</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={deleting}>
          Cancel
        </Button>
        <Button
          className={classes.danger}
          disabled={deleting || stage.status === 'deleted'}
          startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          onClick={() => void remove()}
        >
          {deleting ? 'Removing…' : 'Remove'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
