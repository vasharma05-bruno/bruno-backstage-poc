import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import Divider from '@material-ui/core/Divider';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import AddIcon from '@material-ui/icons/Add';
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
import { descriptorLocation, sourceUrl, version } from '../../lib/brunoEntity';
import { useCanCreateLink } from '../../lib/permissions';
import { useRuntimeWritesEnabled } from '../../lib/runtimeWrites';
import { useBrandStyles } from '../../theme/brandStyles';

const useStyles = makeStyles((theme) => ({
  addRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2)
  },
  divider: {
    marginTop: theme.spacing(2)
  }
}));

/**
 * "Link a collection": attaches an existing Bruno collection to this API entity.
 *
 * A link is `partOf` on the COLLECTION, never on the API. That asymmetry is
 * forced by the model: `partOf` lives on the Bruno entity, and the `hasPart`
 * relation this card reads is derived from it by `BrunoKindProcessor`. Editing
 * the API's own descriptor would create nothing.
 *
 * There are two places that `partOf` can be recorded, and the dialog offers
 * both — see `LinkMethodChoice`. The pull request against the collection's
 * `catalog-info.yaml` is the default wherever it can run; a runtime link is the
 * only option for a collection with no descriptor to edit, and the fast one
 * when a review is not what the user wants. This dialog used to end in those
 * cases with the advice and a Close button; the advice is now the reason the
 * pull-request option is unavailable rather than the end of the flow.
 *
 * Unlike its mirror `LinkApiDialog`, this dialog cannot say up front whether a
 * pull request is possible: each candidate collection brings its own descriptor,
 * so that answer arrives with the choice and is rendered under the picker.
 */
export function LinkCollectionDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The API entity being linked TO. Its ref is what lands in `partOf`. */
  apiEntity: Entity;
  /** Refs of collections already linked, hidden from the picker. */
  linkedRefs: string[];
  /** Called with the collection's ref and the pull request URL once one is open. */
  onPrOpened?: (collectionRef: string, link: string) => void;
  /**
   * Called with the collection's ref once a runtime link is written.
   *
   * Separate from `onPrOpened` rather than one callback with an optional link,
   * because the two mean opposite things to the card: a pull request is a
   * promise that something MIGHT change after a review, while a runtime link
   * has already happened and the relation is seconds away. The card shows a
   * standing chip for the first and re-reads the entity for the second —
   * which is what `refreshRequested` is for, since it says whether there will
   * be anything to find.
   */
  onRuntimeLinked?: (collectionRef: string, refreshRequested: boolean) => void;
  /**
   * Concrete path of the Bruno dashboard, for the "Add a new Bruno Collection"
   * escape hatch; omitted when the page is not mounted in this app, which
   * disables that button.
   *
   * A resolved path rather than a `useRouteRef` call of our own, because the two
   * frontend systems resolve routes through different hooks and this dialog has
   * to render under either. Whoever mounts the component knows which system it
   * is in and passes the answer down; see `src/extensions.tsx` and
   * `src/legacy.ts`.
   */
  brunoPagePath?: string;
}): JSX.Element {
  const {
    open,
    onClose,
    apiEntity,
    linkedRefs,
    onPrOpened,
    onRuntimeLinked,
    brunoPagePath
  } = props;
  const classes = useStyles();
  const partOfClasses = usePartOfStyles();
  const brandClasses = useBrandStyles();
  const navigate = useNavigate();

  const options = useEntityOptions('Bruno', open);
  const [selected, setSelected] = useState<Entity | null>(null);

  const apiRef = stringifyEntityRef(apiEntity);
  // The descriptor being edited is the SELECTED collection's, so everything
  // below re-derives as the choice changes.
  const location = selected
    ? descriptorLocation(selected)
    : ({ kind: 'none', reason: 'absent' } as const);
  const pr = usePartOfPr({
    direction: 'link',
    descriptorUrl: location.kind === 'url' ? location.target : undefined
  });
  const runtime = useRuntimeLink();
  const advice = useDescriptorAdvice({
    location,
    apiRef,
    direction: 'link',
    // What lets the advice show the finished YAML rather than describe it, on a
    // host no pull request can reach. Re-derived with the selection, like
    // everything else here.
    currentPartOf: selected?.spec?.partOf
  });
  // Both hooks are called unconditionally and combined afterwards — `&&` on
  // the call expressions would short-circuit the second one, which is a
  // conditional hook. They answer the same question between them: would
  // `POST /links` accept this. A method the backend would refuse is not offered
  // as a choice.
  const writesEnabled = useRuntimeWritesEnabled();
  const mayCreateLink = useCanCreateLink();
  const runtimeAvailable = writesEnabled && mayCreateLink;
  // `advice` is `undefined` exactly when a pull request can be opened, so it is
  // the whole test — no second reading of the location, and no way for the two
  // to disagree. `method` is undefined when the chosen collection can be linked
  // neither way, which the primary button below reads as "nothing to press".
  const { method, setMethod, reset: resetMethod } = useLinkMethod({
    prPossible: !advice,
    runtimePossible: runtimeAvailable
  });

  const close = (): void => {
    pr.reset();
    runtime.reset();
    resetMethod();
    setSelected(null);
    onClose();
  };

  /** True while either write is in flight, which is what blocks the dialog. */
  const inFlight
    = pr.stage.status === 'submitting' || runtime.stage.status === 'working';

  /** The "go and register one" escape hatch, in both the picker and the empty list. */
  const addCollectionButton = (
    <Button
      variant="outlined"
      className={brandClasses.accentOutlinedButton}
      startIcon={<AddIcon />}
      // The path is absent when the page is not mounted in this app, and a dead
      // button is worse than a disabled one.
      disabled={!brunoPagePath}
      onClick={() => {
        if (brunoPagePath) {
          close();
          // The add-collection flow lives on the dashboard, so this API has to
          // travel with the navigation rather than as a prop. `AddCollectionAction`
          // reads both parameters and strips them from the URL.
          navigate(
            `${brunoPagePath}?add=1&partOf=${encodeURIComponent(apiRef)}`
          );
        }
      }}
    >
      Add a new Bruno Collection
    </Button>
  );

  let body: JSX.Element;
  let actions: JSX.Element;

  if (pr.stage.status === 'submitted') {
    const { link } = pr.stage;
    body = (
      <>
        <Typography variant="body2">
          Pull request opened. The collection appears in this card once the pull
          request is merged and Backstage re-reads the collection&apos;s
          descriptor.
        </Typography>
        <Typography variant="body2" className={partOfClasses.detail}>
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
          Linked in this Backstage instance.{' '}
          {refreshRequested
            ? 'The collection appears in this card within a few seconds, as '
            + 'soon as Backstage has finished re-reading it.'
            : 'Backstage could not be asked to re-read the collection straight '
              + 'away, so it appears in this card on the next catalog '
              + 'processing cycle.'}
        </Typography>
        <Typography variant="body2" className={partOfClasses.detail}>
          Nothing in source control changed. The link lives in this instance
          only — <strong>Unlink</strong> on the collection&apos;s row removes it
          again, and it is not carried by the collection&apos;s repository.
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
            pr.submit(plan, (link) =>
              onPrOpened?.(stringifyEntityRef(selected as Entity), link))}
        >
          {submitting ? 'Opening pull request…' : 'Open pull request'}
        </Button>
      </>
    );
  } else {
    // Choosing (or reading the descriptor / writing the row after a choice).
    const planning = pr.stage.status === 'planning';
    const working = runtime.stage.status === 'working';
    const busy = planning || working;

    body = (
      <>
        <Typography variant="body2">
          Linking adds <code>{apiRef}</code> to the collection&apos;s{' '}
          <code>partOf</code>, which is what the catalog turns into the relation
          shown on both entities.{' '}
          {runtimeAvailable
            ? 'It can be recorded in the collection\u2019s catalog-info.yaml '
            + '\u2014 where it is reviewed and travels with the repository '
            + '\u2014 or in this Backstage instance, which is immediate and '
            + 'the only option for a collection with no descriptor.'
            : 'It is recorded in the collection\u2019s catalog-info.yaml, by a '
              + 'pull request against the repository that holds it.'}
        </Typography>
        <Box className={partOfClasses.detail}>
          <EntityPicker
            options={options}
            excluded={linkedRefs}
            value={selected}
            onChange={setSelected}
            disabled={busy}
            name="bruno-collection"
            label="Bruno collection"
            placeholder="Search collections"
            emptyNone="No Bruno collections are registered in this catalog yet."
            emptyAll="Every registered Bruno collection is already linked to this API."
            errorTitle="Could not load Bruno collections"
          />
        </Box>

        {selected && (
          <Box className={partOfClasses.detail}>
            <Typography variant="body2" color="textSecondary">
              Version {version(selected) ?? '—'}
              {sourceUrl(selected) && (
                <>
                  {' · '}
                  <Link to={sourceUrl(selected) as string}>
                    {sourceUrl(selected)}
                  </Link>
                </>
              )}
            </Typography>
            <LinkMethodChoice
              method={method}
              onChange={setMethod}
              advice={advice}
              runtimeAvailable={runtimeAvailable}
              disabled={busy}
              target={<code>{apiRef}</code>}
            />
          </Box>
        )}

        <Divider className={classes.divider} />
        <Box className={classes.addRow}>
          <Typography variant="body2" color="textSecondary">
            Not listed? Register the collection as a Bruno entity first.
          </Typography>
          {addCollectionButton}
        </Box>
      </>
    );
    actions = (
      <>
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        {/*
          Absent, not disabled, when the CHOSEN collection can be linked
          neither way — no descriptor to open a pull request against and no
          instance-local links. Unlike its mirror, this dialog keeps the picker:
          the dead end belongs to one candidate, and the next one may have a
          descriptor. A greyed primary button would read as the dialog being
          broken rather than as this collection being unreachable, and the
          reason is already spelled out under the picker.
        */}
        {method && (
          <Button
            variant="contained"
            className={brandClasses.accentButton}
            disabled={busy || !selected}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
            onClick={() => {
              const collection = selected as Entity;
              if (method === 'pr') {
                pr.prepare({
                  apiRefs: [apiRef],
                  collectionName:
                  collection.metadata.title ?? collection.metadata.name
                });
                return;
              }
              if (method !== 'runtime') {
                return;
              }
              const collectionRef = stringifyEntityRef(collection);
              runtime.link({
                collectionRef,
                apiRefs: [apiRef],
                onLinked: (refreshRequested) =>
                  onRuntimeLinked?.(collectionRef, refreshRequested)
              });
            }}
          >
            {planning
              ? 'Reading descriptor…'
              : working
                ? 'Linking…'
                : method === 'runtime'
                  ? 'Link collection'
                  : 'Prepare pull request'}
          </Button>
        )}
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
      <DialogTitle>Link a Bruno collection</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
