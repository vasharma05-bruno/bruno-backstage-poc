import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import Typography from '@material-ui/core/Typography';
import { CopyTextButton, Link } from '@backstage/core-components';
import type { Entity } from '@backstage/catalog-model';
import {
  PartOfPreview,
  useDescriptorAdvice,
  usePartOfPr,
  usePartOfStyles
} from '../PartOfPr';
import { useBrandStyles } from '../../theme/brandStyles';
import { descriptorLocation } from '../../lib/brunoEntity';

/**
 * The Unlink flow: removing an API from a Bruno collection's `spec.partOf` by
 * opening a pull request against the collection's `catalog-info.yaml`.
 *
 * It cannot be instant, and the dialog is built around saying so. Catalog
 * relations are derived output — recomputed and rewritten on every stitch — so
 * there is nothing to delete at runtime; the link only exists in source control.
 * Every state below therefore either explains what file will change, or explains
 * precisely why no file can.
 *
 * Shared with the Bruno Collections card on API entity pages, which runs the
 * same flow from the other side of the relation.
 */
export function UnlinkDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The Bruno collection whose descriptor is edited. */
  collection: Entity;
  /** The API entity reference being removed from `spec.partOf`. */
  apiRef: string;
  /** Called with the pull request URL once one is open. */
  onSubmitted?: (link: string) => void;
}): JSX.Element {
  const { open, onClose, collection, apiRef, onSubmitted } = props;
  const classes = usePartOfStyles();
  const brandClasses = useBrandStyles();

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const pr = usePartOfPr({ direction: 'unlink', descriptorUrl });
  const { stage } = pr;
  // Undefined once a pull request is actually possible; until then it is both
  // the explanation and the reason no action is offered.
  const advice = useDescriptorAdvice({ location, apiRef, direction: 'unlink' });

  const close = (): void => {
    pr.reset();
    onClose();
  };

  let body: JSX.Element | null;
  let actions: JSX.Element;

  if (advice) {
    body = advice;
    actions = <Button onClick={close}>Close</Button>;
  } else if (stage.status === 'submitted') {
    body = (
      <>
        <Typography variant="body2">
          Pull request opened. The <code>{apiRef}</code> relation stays visible
          here until it is merged and Backstage re-reads the collection.
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          <Link to={stage.link}>{stage.link}</Link>
        </Typography>
      </>
    );
    actions = (
      <>
        <CopyTextButton text={stage.link} tooltipText="Pull request link copied" />
        <Button onClick={close}>Close</Button>
      </>
    );
  } else if (stage.status === 'error') {
    body = (
      <Typography variant="body2" color="error">
        {stage.message}
      </Typography>
    );
    actions = (
      <>
        <Button onClick={pr.reset}>Back</Button>
        <Button onClick={close}>Close</Button>
      </>
    );
  } else if (stage.status === 'preview' || stage.status === 'submitting') {
    const { plan } = stage;
    const submitting = stage.status === 'submitting';
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
          onClick={() => pr.submit(plan, onSubmitted)}
        >
          {submitting ? 'Opening pull request…' : 'Open pull request'}
        </Button>
      </>
    );
  } else {
    const planning = stage.status === 'planning';
    body = (
      <>
        <Typography variant="body2">
          Catalog relations are generated from source control. Unlinking opens a
          pull request that removes <code>{apiRef}</code> from{' '}
          <code>spec.partOf</code> in this collection&apos;s{' '}
          <code>catalog-info.yaml</code>. The relation disappears once that pull
          request is merged and Backstage re-reads the file.
        </Typography>
        {descriptorUrl && (
          <Typography variant="body2" className={classes.detail}>
            Descriptor: <Link to={descriptorUrl}>{descriptorUrl}</Link>
          </Typography>
        )}
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

  return (
    <Dialog
      open={open}
      maxWidth="md"
      fullWidth
      // A half-created branch is confusing, so the dialog is not dismissable
      // while the pull request is being opened.
      disableBackdropClick={stage.status === 'submitting'}
      disableEscapeKeyDown={stage.status === 'submitting'}
      onClose={close}
    >
      <DialogTitle>Unlink {apiRef}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
