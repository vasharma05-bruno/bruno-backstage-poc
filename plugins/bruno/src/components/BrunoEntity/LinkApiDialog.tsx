import { useState } from 'react';
import Box from '@material-ui/core/Box';
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
  EntityPicker,
  PartOfPreview,
  useDescriptorAdvice,
  useEntityOptions,
  usePartOfPr,
  usePartOfStyles
} from '../PartOfPr';
import { descriptorLocation } from '../../lib/brunoEntity';
import { useBrandStyles } from '../../theme/brandStyles';

/**
 * "Link an API": attaches this Bruno collection to an existing API entity.
 *
 * The mirror of `BrunoCard`'s `LinkCollectionDialog`, run from the other end of
 * the same relation, and it edits exactly the same file: `spec.partOf` lives on
 * the Bruno entity, so linking from either side means a pull request against
 * THIS collection's `catalog-info.yaml`. See `lib/unlinkPr.ts` for why a pull
 * request rather than a write.
 *
 * One thing genuinely differs from the API-side flow, and the shape of the
 * dialog follows it: here the collection is fixed, so whether a pull request is
 * possible at all is known before anything is picked. That answer is therefore
 * given first, the way `UnlinkDialog` gives it — rather than after a choice, as
 * the API-side dialog must, where each candidate collection brings its own
 * descriptor.
 */
export function LinkApiDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The Bruno collection whose descriptor is edited. */
  collection: Entity;
  /** Refs of APIs already linked, hidden from the picker. */
  linkedRefs: string[];
  /** Called with the API's ref and the pull request URL once one is open. */
  onSubmitted?: (apiRef: string, link: string) => void;
}): JSX.Element {
  const { open, onClose, collection, linkedRefs, onSubmitted } = props;
  const classes = usePartOfStyles();
  const brandClasses = useBrandStyles();

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const pr = usePartOfPr({ direction: 'link', descriptorUrl });
  const options = useEntityOptions('API', open);
  const [selected, setSelected] = useState<Entity | null>(null);

  const { stage } = pr;
  const apiRef = selected ? stringifyEntityRef(selected) : undefined;
  // The collection is fixed here, so this is known before anything is picked:
  // undefined once a pull request is possible, and otherwise the whole dialog.
  const advice = useDescriptorAdvice({ location, apiRef, direction: 'link' });

  const close = (): void => {
    pr.reset();
    setSelected(null);
    onClose();
  };

  let body: JSX.Element;
  let actions: JSX.Element;

  if (advice) {
    body = advice;
    actions = <Button onClick={close}>Close</Button>;
  } else if (stage.status === 'submitted') {
    body = (
      <>
        <Typography variant="body2">
          Pull request opened. The API appears in this card once the pull
          request is merged and Backstage re-reads this collection&apos;s
          descriptor.
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
        <Button onClick={pr.reset} disabled={submitting}>
          Back
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          onClick={() =>
            pr.submit(plan, (link) => onSubmitted?.(plan.apiRef, link))}
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
          Linking adds the API to this collection&apos;s{' '}
          <code>spec.partOf</code>. Catalog relations are generated from source
          control, so this opens a pull request against the collection&apos;s{' '}
          <code>catalog-info.yaml</code>; the API appears here once it is merged
          and Backstage re-reads the file.
        </Typography>
        {descriptorUrl && (
          <Typography variant="body2" className={classes.detail}>
            Descriptor: <Link to={descriptorUrl}>{descriptorUrl}</Link>
          </Typography>
        )}
        <Box className={classes.detail}>
          <EntityPicker
            options={options}
            excluded={linkedRefs}
            value={selected}
            onChange={setSelected}
            disabled={planning}
            name="api-entity"
            label="API"
            placeholder="Search APIs"
            emptyNone="No API entities are registered in this catalog yet."
            emptyAll="Every registered API is already linked to this collection."
            errorTitle="Could not load APIs"
          />
        </Box>
        {selected && (
          <Typography
            variant="body2"
            color="textSecondary"
            className={classes.detail}
          >
            {String(selected.spec?.type ?? 'API')} · <code>{apiRef}</code>
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
          disabled={planning || !apiRef}
          startIcon={planning ? <CircularProgress size={16} /> : undefined}
          onClick={() =>
            pr.prepare({ apiRef: apiRef as string, collectionName })}
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
      <DialogTitle>Link an API</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
