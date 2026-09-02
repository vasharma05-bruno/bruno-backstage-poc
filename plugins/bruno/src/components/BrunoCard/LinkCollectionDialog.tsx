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
import { useRouteRef } from '@backstage/frontend-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import { brunoPageRouteRef } from '../../extensions';
import {
  EntityPicker,
  PartOfPreview,
  useDescriptorAdvice,
  useEntityOptions,
  usePartOfPr,
  usePartOfStyles
} from '../PartOfPr';
import { descriptorLocation, sourceUrl, version } from '../../lib/brunoEntity';
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
 * The link is written the same way the unlink is — as a pull request against the
 * COLLECTION's `catalog-info.yaml`, adding this API to its `spec.partOf`. That
 * asymmetry is deliberate and is forced by the model: `partOf` lives on the
 * Bruno entity, and the `hasPart` relation this card reads is derived from it by
 * `BrunoKindProcessor`. Editing the API's own descriptor would create nothing.
 * See `lib/unlinkPr.ts` for why a pull request rather than a write.
 *
 * Unlike its mirror `LinkApiDialog`, this dialog cannot say up front whether a
 * pull request is possible: each candidate collection brings its own descriptor,
 * so that answer arrives with the choice and is rendered under the picker.
 */
export function LinkCollectionDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The API entity being linked TO. Its ref is what lands in `spec.partOf`. */
  apiEntity: Entity;
  /** Refs of collections already linked, hidden from the picker. */
  linkedRefs: string[];
  /** Called with the collection's ref and the pull request URL once one is open. */
  onSubmitted?: (collectionRef: string, link: string) => void;
}): JSX.Element {
  const { open, onClose, apiEntity, linkedRefs, onSubmitted } = props;
  const classes = useStyles();
  const partOfClasses = usePartOfStyles();
  const brandClasses = useBrandStyles();
  const navigate = useNavigate();
  const dashboardRoute = useRouteRef(brunoPageRouteRef);

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
  const { stage } = pr;
  const advice = useDescriptorAdvice({
    location,
    apiRef,
    direction: 'link',
    className: partOfClasses.detail
  });

  const close = (): void => {
    pr.reset();
    setSelected(null);
    onClose();
  };

  /** The "go and register one" escape hatch, in both the picker and the empty list. */
  const addCollectionButton = (
    <Button
      variant="outlined"
      className={brandClasses.accentOutlinedButton}
      startIcon={<AddIcon />}
      // `useRouteRef` returns undefined when the page is not mounted in this
      // app, and a dead button is worse than a disabled one.
      disabled={!dashboardRoute}
      onClick={() => {
        if (dashboardRoute) {
          close();
          // The add-collection flow lives on the dashboard, so this API has to
          // travel with the navigation rather than as a prop. `AddCollectionAction`
          // reads both parameters and strips them from the URL.
          navigate(
            `${dashboardRoute()}?add=1&partOf=${encodeURIComponent(apiRef)}`
          );
        }
      }}
    >
      Add a new Bruno Collection
    </Button>
  );

  let body: JSX.Element;
  let actions: JSX.Element;

  if (stage.status === 'submitted') {
    body = (
      <>
        <Typography variant="body2">
          Pull request opened. The collection appears in this card once the pull
          request is merged and Backstage re-reads the collection&apos;s
          descriptor.
        </Typography>
        <Typography variant="body2" className={partOfClasses.detail}>
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
            pr.submit(plan, (link) =>
              onSubmitted?.(stringifyEntityRef(selected as Entity), link))}
        >
          {submitting ? 'Opening pull request…' : 'Open pull request'}
        </Button>
      </>
    );
  } else {
    // Choosing (or reading the descriptor after a choice).
    const planning = stage.status === 'planning';
    /**
     * The two origins whose pull request button is WITHHELD rather than merely
     * disabled: an `app-config.yaml` entry and a local file on the host's disk.
     * There is no file for the button to edit, so offering it at all
     * misdescribes the flow.
     *
     * `discovery` is the same shape and is deliberately NOT included: the copy
     * for it is still an error paragraph beside a disabled button, and moving
     * it over is a separate decision from this one.
     */
    const withheld
      = location.kind === 'none'
        && (location.reason === 'provider' || location.reason === 'file');

    body = (
      <>
        <Typography variant="body2">
          Linking adds <code>{apiRef}</code> to the collection&apos;s{' '}
          <code>spec.partOf</code>. Catalog relations are generated from source
          control, so this opens a pull request against the collection&apos;s{' '}
          <code>catalog-info.yaml</code>; the collection appears here once it is
          merged and Backstage re-reads the file.
        </Typography>
        <Box className={partOfClasses.detail}>
          <EntityPicker
            options={options}
            excluded={linkedRefs}
            value={selected}
            onChange={setSelected}
            disabled={planning}
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
            {advice}
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
    actions = selected && withheld
      ? <Button onClick={close}>Close</Button>
      : (
          <>
            <Button onClick={close} disabled={planning}>
              Cancel
            </Button>
            <Button
              variant="contained"
              className={brandClasses.accentButton}
              disabled={planning || !selected || Boolean(advice)}
              startIcon={planning ? <CircularProgress size={16} /> : undefined}
              onClick={() =>
                pr.prepare({
                  apiRef,
                  collectionName:
                    (selected as Entity).metadata.title
                    ?? (selected as Entity).metadata.name
                })}
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
      <DialogTitle>Link a Bruno collection</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
