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

/** `A`, `A and B`, `A, B and C` — a list a sentence can hold. */
function nameList(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "Link APIs": attaches this Bruno collection to existing API entities.
 *
 * The mirror of `BrunoCard`'s `LinkCollectionDialog`, run from the other end of
 * the same relation, and it edits exactly the same file: `spec.partOf` lives on
 * the Bruno entity, so linking from either side means a pull request against
 * THIS collection's `catalog-info.yaml`. See `lib/unlinkPr.ts` for why a pull
 * request rather than a write.
 *
 * Several APIs at once, and one pull request for all of them: they add to the
 * same `spec.partOf` in the same file, so a branch each would be noise. The
 * copy names them throughout — in the picker's chips, under it as the refs that
 * will actually land in the YAML, and in the message that reports the pull
 * request — since by then the reader has left the list behind and the pull
 * request is the only thing that can still tell them what they linked.
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
  /** Called with the APIs linked and the pull request URL once one is open. */
  onSubmitted?: (apis: Entity[], link: string) => void;
}): JSX.Element {
  const { open, onClose, collection, linkedRefs, onSubmitted } = props;
  const classes = usePartOfStyles();
  const brandClasses = useBrandStyles();

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const pr = usePartOfPr({ direction: 'link', descriptorUrl });
  const options = useEntityOptions('API', open);
  const [selected, setSelected] = useState<Entity[]>([]);

  const { stage } = pr;
  const apiRefs = selected.map(stringifyEntityRef);
  const names = nameList(
    selected.map((api) => api.metadata.title ?? api.metadata.name)
  );
  // The collection is fixed here, so this is known before anything is picked —
  // and so it is stated without naming a reference, since there is none yet.
  const advice = useDescriptorAdvice({ location, direction: 'link' });

  const close = (): void => {
    pr.reset();
    setSelected([]);
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
          Pull request opened for {names || 'the selected APIs'}.{' '}
          {selected.length === 1 ? 'It appears' : 'They appear'} in this card
          once the pull request is merged and Backstage re-reads this
          collection&apos;s descriptor.
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
            pr.submit(plan, (link) => onSubmitted?.(selected, link))}
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
          Linking adds the APIs you pick to this collection&apos;s{' '}
          <code>spec.partOf</code>, in one pull request. Catalog relations are
          generated from source control, so this opens that pull request against
          the collection&apos;s <code>catalog-info.yaml</code>; the APIs appear
          here once it is merged and Backstage re-reads the file.
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
            multiple
            name="api-entities"
            label="APIs"
            placeholder={selected.length === 0 ? 'Search APIs' : ''}
            emptyNone="No API entities are registered in this catalog yet."
            emptyAll="Every registered API is already linked to this collection."
            errorTitle="Could not load APIs"
          />
        </Box>
        {selected.length > 0 && (
          <Typography
            variant="body2"
            color="textSecondary"
            className={classes.detail}
          >
            Adds{' '}
            {apiRefs.map((ref, index) => (
              <span key={ref}>
                {index > 0 && ', '}
                <code>{ref}</code>
              </span>
            ))}
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
          disabled={planning || apiRefs.length === 0}
          startIcon={planning ? <CircularProgress size={16} /> : undefined}
          onClick={() => pr.prepare({ apiRefs, collectionName })}
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
      <DialogTitle>Link APIs</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
