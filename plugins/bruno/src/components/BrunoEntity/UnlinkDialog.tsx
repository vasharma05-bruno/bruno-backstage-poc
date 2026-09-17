import { useState } from 'react';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import Typography from '@material-ui/core/Typography';
import { CopyTextButton, Link } from '@backstage/core-components';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import {
  PartOfPreview,
  useDescriptorAdvice,
  usePartOfPr,
  usePartOfStyles,
  useRuntimeLink
} from '../PartOfPr';
import { InlineNotice } from '../InlineNotice';
import { useBrandStyles } from '../../theme/brandStyles';
import { descriptorLocation, linkSource } from '../../lib/brunoEntity';
import { useCanDeleteLink } from '../../lib/permissions';

/**
 * The Unlink flow: removing an API from a Bruno collection's `partOf`.
 *
 * WHICH `partOf` is the first thing this dialog has to work out, because there
 * are two and they are undone in completely different ways:
 *
 *  - `spec.partOf` in the collection's descriptor. Source control is the source
 *    of truth, so there is nothing to delete at runtime — the removal is a pull
 *    request against that file, and the relation stays visible until it is
 *    merged and Backstage re-reads it. For a `bruno.collections[]` entry, a
 *    discovered collection or a `file:` location there is no pull request to
 *    open at all, and `useDescriptorAdvice` says what to edit instead.
 *  - a RUNTIME link, a row in the `bruno` backend. One call removes it and the
 *    relation is gone within seconds. No file, no review, nothing to preview.
 *
 * `linkSource` decides, off the collection entity itself. It can also answer
 * `both` — a descriptor that grew an entry a runtime link already covered — and
 * that case is why the dialog cannot simply pick one flow and run it: the
 * relation survives removing either half alone, so the user has to be walked
 * through both.
 *
 * Shared with the Bruno Collections card on API entity pages, which runs the
 * same flow from the other side of the relation.
 */
export function UnlinkDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The Bruno collection whose link is being removed. */
  collection: Entity;
  /** The API entity reference being removed from `partOf`. */
  apiRef: string;
  /** Called with the pull request URL once one is open. */
  onPrOpened?: (link: string) => void;
  /**
   * Called once a runtime link row has been removed.
   *
   * `refreshRequested` says whether the relation is seconds away or a full
   * catalog cycle away, which is the difference between a card that can
   * usefully re-read the entity and one that should just say so.
   */
  onRuntimeUnlinked?: (refreshRequested: boolean) => void;
}): JSX.Element {
  const { open, onClose, collection, apiRef, onPrOpened, onRuntimeUnlinked }
    = props;
  const classes = usePartOfStyles();
  const brandClasses = useBrandStyles();

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const collectionRef = stringifyEntityRef(collection);
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const pr = usePartOfPr({ direction: 'unlink', descriptorUrl });
  const runtime = useRuntimeLink();
  const mayRemoveRuntime = useCanDeleteLink();
  // Undefined once a pull request is actually possible; until then it is both
  // the explanation and the reason no pull request is offered.
  const advice = useDescriptorAdvice({ location, apiRef, direction: 'unlink' });

  /**
   * Whether the runtime half of a `both` link has already been removed in this
   * dialog.
   *
   * Kept in state rather than re-derived from the entity, because the entity
   * this dialog was handed does not change: the annotation `linkSource` reads
   * is rewritten by the next processing cycle, seconds after the call returns,
   * and until then it would keep answering `both` and keep asking the user to
   * remove a row that is already gone.
   */
  const [runtimeRemoved, setRuntimeRemoved] = useState(false);

  const source = linkSource(collection, apiRef);
  /** A row to delete, and it has not been deleted yet in this dialog. */
  const hasRuntimeHalf
    = (source === 'runtime' || source === 'both') && !runtimeRemoved;
  /**
   * A descriptor entry to remove. `none` counts: the relation was read off the
   * catalog and the spec was not, so a link the annotation cannot explain is
   * most likely a descriptor entry from a stitch this entity has not caught up
   * with — and the pull-request flow's own "not listed in spec.partOf" message
   * is a far better answer than this dialog guessing.
   */
  const hasDescriptorHalf
    = source === 'descriptor' || source === 'both' || source === 'none';

  const close = (): void => {
    pr.reset();
    runtime.reset();
    setRuntimeRemoved(false);
    onClose();
  };

  /** True while either write is in flight, which is what blocks the dialog. */
  const inFlight
    = pr.stage.status === 'submitting' || runtime.stage.status === 'working';

  /**
   * Removes the runtime row.
   *
   * When that is the whole link the dialog is finished and says so. When the
   * descriptor declares it too, it drops back to the first step with
   * `runtimeRemoved` set, so the second half is presented as the next step
   * rather than as a separate visit — the relation is still there, and a dialog
   * that closed here would look like it had failed.
   */
  const removeRuntime = (): void =>
    runtime.unlink({
      collectionRef,
      apiRef,
      onUnlinked: (refreshRequested) => {
        onRuntimeUnlinked?.(refreshRequested);
        if (hasDescriptorHalf) {
          setRuntimeRemoved(true);
          runtime.reset();
        }
      }
    });

  let body: JSX.Element;
  let actions: JSX.Element;

  if (pr.stage.status === 'submitted') {
    const { link } = pr.stage;
    body = (
      <>
        <Typography variant="body2">
          Pull request opened. The <code>{apiRef}</code> relation stays visible
          here until it is merged and Backstage re-reads the collection.
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          <Link to={link}>{link}</Link>
        </Typography>
      </>
    );
    actions = (
      <>
        <CopyTextButton text={link} tooltipText="Pull request link copied" />
        <Button onClick={close}>Close</Button>
      </>
    );
  } else if (runtime.stage.status === 'unlinked') {
    const { refreshRequested } = runtime.stage;
    body = (
      <>
        <Typography variant="body2">
          The link in this Backstage instance has been removed.{' '}
          {refreshRequested
            ? 'The relation disappears within a few seconds, as soon as '
            + 'Backstage has finished re-reading the collection.'
            : 'Backstage could not be asked to re-read the collection straight '
              + 'away, so the relation disappears on the next catalog '
              + 'processing cycle.'}
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          Nothing in source control changed — there was nothing there to change.
        </Typography>
      </>
    );
    actions = <Button onClick={close}>Close</Button>;
  } else if (pr.stage.status === 'error' || runtime.stage.status === 'error') {
    const message
      = pr.stage.status === 'error'
        ? pr.stage.message
        : (runtime.stage as { message: string }).message;
    body = (
      <Typography variant="body2" color="error">
        {message}
      </Typography>
    );
    actions = (
      <>
        <Button
          onClick={() => {
            pr.reset();
            runtime.reset();
          }}
        >
          Back
        </Button>
        <Button onClick={close}>Close</Button>
      </>
    );
  } else if (
    pr.stage.status === 'preview'
    || pr.stage.status === 'submitting'
  ) {
    const { plan } = pr.stage;
    const submitting = pr.stage.status === 'submitting';
    body = <PartOfPreview plan={plan} />;
    actions = (
      <>
        <Button onClick={close} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          onClick={() => pr.submit(plan, onPrOpened)}
        >
          {submitting ? 'Opening pull request…' : 'Open pull request'}
        </Button>
      </>
    );
  } else if (hasRuntimeHalf) {
    // The runtime row comes FIRST when the link has both halves: it is the one
    // this app can actually remove, so doing it first means the user leaves
    // having made progress even if they abandon the pull request.
    const working = runtime.stage.status === 'working';
    body = (
      <>
        <Typography variant="body2">
          {hasDescriptorHalf
            ? 'This link is recorded twice — in this Backstage instance, and in '
            + 'the collection descriptor in source control. The relation '
            + 'stays as long as either one is there, so removing it takes '
            + 'both.'
            : 'This link was made in this Backstage instance rather than in '
              + 'source control, so removing it is immediate: it deletes the '
              + 'row the Bruno backend keeps, and the relation goes on the '
              + 'next re-read of the collection — a few seconds.'}
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          Removing <code>{apiRef}</code> from <strong>{collectionName}</strong>{' '}
          changes nothing in source control.
        </Typography>
        {hasDescriptorHalf && mayRemoveRuntime && (
          <InlineNotice className={classes.detail}>
            Start here. The descriptor half needs a pull request, and this
            dialog moves on to it once the runtime link is gone.
          </InlineNotice>
        )}
        {/*
          The screen still EXPLAINS the runtime half when the policy refuses
          it — the relation is there and the user is entitled to know why it
          will not go — and only the button that would 403 is taken away.
        */}
        {!mayRemoveRuntime && (
          <InlineNotice className={classes.detail}>
            You do not have permission to remove links made in this Backstage
            instance. Ask someone who does, or an administrator.
          </InlineNotice>
        )}
      </>
    );
    actions = (
      <>
        <Button onClick={close} disabled={working}>
          Cancel
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={working || !mayRemoveRuntime}
          startIcon={working ? <CircularProgress size={16} /> : undefined}
          onClick={removeRuntime}
        >
          {working
            ? 'Removing…'
            : hasDescriptorHalf
              ? 'Remove the runtime link'
              : 'Remove link'}
        </Button>
      </>
    );
  } else {
    /**
     * The descriptor half.
     *
     * `runtimeNote` rides on top of both endings: when the user has just
     * removed a runtime half in this same dialog, the screen has to acknowledge
     * it, or the advice below reads as though nothing had happened yet.
     */
    const runtimeNote = runtimeRemoved
      ? (
          <InlineNotice className={classes.detail}>
            The link in this Backstage instance is gone. What is left is the{' '}
            <code>spec.partOf</code> entry, which lives in source control.
          </InlineNotice>
        )
      : undefined;

    if (advice) {
      body = (
        <>
          {advice}
          {runtimeNote}
        </>
      );
      actions = <Button onClick={close}>Close</Button>;
    } else {
      const planning = pr.stage.status === 'planning';
      body = (
        <>
          <Typography variant="body2">
            This link is declared in source control, so it is removed there.
            Unlinking opens a pull request that takes <code>{apiRef}</code> out
            of <code>spec.partOf</code> in this collection&apos;s{' '}
            <code>catalog-info.yaml</code>; the relation disappears once that
            pull request is merged and Backstage re-reads the file.
          </Typography>
          {descriptorUrl && (
            <Typography variant="body2" className={classes.detail}>
              Descriptor: <Link to={descriptorUrl}>{descriptorUrl}</Link>
            </Typography>
          )}
          {runtimeNote}
        </>
      );
      actions = (
        <>
          <Button onClick={close} disabled={planning}>
            Cancel
          </Button>
          <Button
            variant="contained"
            className={brandClasses.accentButton}
            disabled={planning}
            startIcon={planning ? <CircularProgress size={16} /> : undefined}
            onClick={() => pr.prepare({ apiRefs: [apiRef], collectionName })}
          >
            {planning ? 'Reading descriptor…' : 'Prepare pull request'}
          </Button>
        </>
      );
    }
  }

  return (
    <Dialog
      open={open}
      maxWidth="md"
      fullWidth
      // A half-created branch is confusing, and so is a half-removed link, so
      // the dialog is not dismissable while either call is in flight.
      disableBackdropClick={inFlight}
      disableEscapeKeyDown={inFlight}
      onClose={close}
    >
      <DialogTitle>Unlink {apiRef}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
