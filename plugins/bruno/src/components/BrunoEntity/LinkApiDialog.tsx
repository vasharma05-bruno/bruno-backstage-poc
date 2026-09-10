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
  LinkMethodChoice,
  PartOfPreview,
  useDescriptorAdvice,
  useEntityOptions,
  useLinkMethod,
  usePartOfPr,
  usePartOfStyles,
  useRuntimeLink
} from '../PartOfPr';
import { descriptorLocation } from '../../lib/brunoEntity';
import { useRuntimeWritesEnabled } from '../../lib/runtimeWrites';
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
 * the same relation, and it records the link in exactly the same two places:
 * `partOf` lives on the Bruno entity, so linking from either side means either
 * a pull request against THIS collection's `catalog-info.yaml` or a row in the
 * `bruno` backend for this collection. See `LinkMethodChoice` for the choice,
 * and `lib/unlinkPr.ts` for why the first is a pull request rather than a write.
 *
 * Several APIs at once, and ONE of whichever it is for all of them: the pull
 * request because they add to the same `spec.partOf` in the same file, so a
 * branch each would be noise; the runtime link because the backend writes the
 * rows in one statement, so a selection is never half-applied. The copy names
 * them throughout — in the picker's chips, under it as the refs that will
 * actually land, and in the message that reports the result — since by then the
 * reader has left the list behind and that message is the only thing that can
 * still tell them what they linked.
 *
 * One thing genuinely differs from the API-side flow, and the shape of the
 * dialog follows it: here the collection is fixed, so whether a pull request is
 * possible at all is known before anything is picked. That answer therefore
 * sits on the method chooser from the start, rather than arriving with a choice
 * as it must on the API side, where each candidate collection brings its own
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
  onPrOpened?: (apis: Entity[], link: string) => void;
  /**
   * Called with the APIs linked once the runtime rows are written.
   *
   * Separate from `onPrOpened` for the reason `LinkCollectionDialog` gives:
   * a pull request is a promise about a review, a runtime link has already
   * happened. `refreshRequested` says whether re-reading the entity now will
   * find anything.
   */
  onRuntimeLinked?: (apis: Entity[], refreshRequested: boolean) => void;
}): JSX.Element {
  const {
    open,
    onClose,
    collection,
    linkedRefs,
    onPrOpened,
    onRuntimeLinked
  } = props;
  const classes = usePartOfStyles();
  const brandClasses = useBrandStyles();

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const pr = usePartOfPr({ direction: 'link', descriptorUrl });
  const runtime = useRuntimeLink();
  const [selected, setSelected] = useState<Entity[]>([]);

  const collectionRef = stringifyEntityRef(collection);
  const apiRefs = selected.map(stringifyEntityRef);
  const names = nameList(
    selected.map((api) => api.metadata.title ?? api.metadata.name)
  );
  // The collection is fixed here, so this is known before anything is picked —
  // and so it is stated without naming a reference, since there is none yet.
  const advice = useDescriptorAdvice({ location, direction: 'link' });
  const runtimeAvailable = useRuntimeWritesEnabled();
  // `advice` is `undefined` exactly when a pull request can be opened, so it is
  // the whole test — no second reading of the location. `method` comes back
  // undefined when neither way of recording the link is open, which is what
  // turns this dialog back into the explanation-and-Close it used to be for a
  // collection with no descriptor.
  const { method, setMethod, reset: resetMethod } = useLinkMethod({
    prPossible: !advice,
    runtimePossible: runtimeAvailable
  });
  /**
   * Whether this collection can be linked at all.
   *
   * Known before anything is picked, because the collection is fixed — which
   * is what lets the dialog skip the picker AND the catalog sweep behind it
   * rather than offering a selection with nowhere to send it. Its mirror on
   * the API side cannot do this: there the descriptor arrives with the choice,
   * so the picker has to stay.
   */
  const canLink = method !== undefined;
  // AFTER `canLink`, and gated on it: this sweeps every API in the catalog to
  // fill a picker the dead end does not render.
  const options = useEntityOptions('API', open && canLink);

  const close = (): void => {
    pr.reset();
    runtime.reset();
    resetMethod();
    setSelected([]);
    onClose();
  };

  /** True while either write is in flight, which is what blocks the dialog. */
  const inFlight
    = pr.stage.status === 'submitting' || runtime.stage.status === 'working';

  let body: JSX.Element;
  let actions: JSX.Element;

  if (pr.stage.status === 'submitted') {
    const { link } = pr.stage;
    body = (
      <>
        <Typography variant="body2">
          Pull request opened for {names || 'the selected APIs'}.{' '}
          {selected.length === 1 ? 'It appears' : 'They appear'} in this card
          once the pull request is merged and Backstage re-reads this
          collection&apos;s descriptor.
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
  } else if (runtime.stage.status === 'linked') {
    const { refreshRequested } = runtime.stage;
    body = (
      <>
        <Typography variant="body2">
          {names || 'The selected APIs'} linked in this Backstage instance.{' '}
          {refreshRequested
            ? `${selected.length === 1 ? 'It appears' : 'They appear'} in this `
            + 'card within a few seconds, as soon as Backstage has finished '
            + 're-reading this collection.'
            : `Backstage could not be asked to re-read this collection `
              + `straight away, so ${
                selected.length === 1 ? 'it appears' : 'they appear'
              } on the next catalog processing cycle.`}
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          Nothing in source control changed. The links live in this instance
          only — <strong>Unlink</strong> on a row removes one again, and they
          are not carried by this collection&apos;s repository.
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
        <Button onClick={pr.reset} disabled={submitting}>
          Back
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          onClick={() =>
            pr.submit(plan, (link) => onPrOpened?.(selected, link))}
        >
          {submitting ? 'Opening pull request…' : 'Open pull request'}
        </Button>
      </>
    );
  } else {
    const planning = pr.stage.status === 'planning';
    const working = runtime.stage.status === 'working';
    const busy = planning || working;
    body = (
      <>
        <Typography variant="body2">
          Linking adds the APIs you pick to this collection&apos;s{' '}
          <code>partOf</code>, which is what the catalog turns into the
          relations shown on both entities.{' '}
          {/*
            Silent in the dead end. Both endings of this sentence are a claim
            about THIS collection — the one fixed thing in this dialog — and
            neither is true of one that can be linked no way at all; the
            explanation there belongs to `LinkMethodChoice`, which has the
            reason.
          */}
          {canLink
            && (runtimeAvailable
              ? 'It can be recorded in this collection\u2019s '
              + 'catalog-info.yaml \u2014 where it is reviewed and travels '
              + 'with the repository \u2014 or in this Backstage instance, '
              + 'which is immediate and the only option for a collection with '
              + 'no descriptor.'
              : 'It is recorded in this collection\u2019s catalog-info.yaml, '
                + 'by a pull request against the repository that holds it.')}
        </Typography>
        {descriptorUrl && (
          <Typography variant="body2" className={classes.detail}>
            Descriptor: <Link to={descriptorUrl}>{descriptorUrl}</Link>
          </Typography>
        )}
        {canLink && (
          <Box className={classes.detail}>
            <EntityPicker
              options={options}
              excluded={linkedRefs}
              value={selected}
              onChange={setSelected}
              disabled={busy}
              multiple
              name="api-entities"
              label="APIs"
              placeholder={selected.length === 0 ? 'Search APIs' : ''}
              emptyNone="No API entities are registered in this catalog yet."
              emptyAll="Every registered API is already linked to this collection."
              errorTitle="Could not load APIs"
            />
          </Box>
        )}
        <LinkMethodChoice
          method={method}
          onChange={setMethod}
          advice={advice}
          runtimeAvailable={runtimeAvailable}
          disabled={busy}
          target={
            apiRefs.length > 0
              ? (
                  <>
                    {apiRefs.map((ref, index) => (
                      <span key={ref}>
                        {index > 0 && ', '}
                        <code>{ref}</code>
                      </span>
                    ))}
                  </>
                )
              : <>the APIs you pick</>
          }
        />
      </>
    );
    actions = !canLink
      ? <Button onClick={close}>Close</Button>
      : (
          <>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="contained"
              className={brandClasses.accentButton}
              disabled={busy || apiRefs.length === 0}
              startIcon={busy ? <CircularProgress size={16} /> : undefined}
              onClick={() => {
                if (method === 'pr') {
                  pr.prepare({ apiRefs, collectionName });
                  return;
                }
                if (method !== 'runtime') {
                  return;
                }
                runtime.link({
                  collectionRef,
                  apiRefs,
                  onLinked: (refreshRequested) =>
                    onRuntimeLinked?.(selected, refreshRequested)
                });
              }}
            >
              {planning
                ? 'Reading descriptor…'
                : working
                  ? 'Linking…'
                  : method === 'runtime'
                    ? 'Link APIs'
                    : 'Prepare pull request'}
            </Button>
          </>
        );
  }

  return (
    <Dialog
      open={open}
      maxWidth="md"
      fullWidth
      // A half-created branch is confusing, and so is a half-written link, so
      // the dialog is not dismissable while either is in flight.
      disableBackdropClick={inFlight}
      disableEscapeKeyDown={inFlight}
      onClose={close}
    >
      <DialogTitle>Link APIs</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
