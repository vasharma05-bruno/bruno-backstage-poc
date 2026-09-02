import { useEffect, useState } from 'react';
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
import { CodeSnippet, CopyTextButton, Link, Progress } from '@backstage/core-components';
import { useApi, useApiHolder } from '@backstage/core-plugin-api';
import { useRouteRef } from '@backstage/frontend-plugin-api';
import { scmAuthApiRef, scmIntegrationsApiRef } from '@backstage/integration-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import { CatalogAutocomplete, catalogApiRef } from '@backstage/plugin-catalog-react';
import { brunoPageRouteRef } from '../../extensions';
import { descriptorLocation, sourceUrl, version } from '../../lib/brunoEntity';
import type { PartOfPlan } from '../../lib/unlinkPr';
import { planLink, submitLink } from '../../lib/unlinkPr';
import { useBrandStyles } from '../../theme/brandStyles';

const useStyles = makeStyles((theme) => ({
  panes: {
    'display': 'grid',
    'gridTemplateColumns': '1fr 1fr',
    'gap': theme.spacing(2),
    // Two full descriptors side by side would push the dialog past the fold.
    '& > *': {
      maxHeight: 260,
      overflow: 'auto'
    }
  },
  paneLabel: {
    display: 'block',
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  detail: {
    marginTop: theme.spacing(1)
  },
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

/** What the dialog is doing right now. */
type Stage
  = | { status: 'choosing' }
    | { status: 'planning' }
    | { status: 'preview'; plan: PartOfPlan }
    | { status: 'submitting'; plan: PartOfPlan }
    | { status: 'submitted'; link: string }
    | { status: 'error'; message: string };

/** The catalog fetch of every Bruno entity in the instance. */
type Options
  = | { status: 'loading' }
    | { status: 'ready'; entities: Entity[] }
    | { status: 'error'; message: string };

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
 * Deliberately NOT sharing a component with `UnlinkDialog` despite the identical
 * preview/submit tail: this flow leads with a step that one does not have (pick
 * a collection, or go and add one), and the two sets of copy are what make each
 * flow legible. They share what actually matters — the plan/submit module.
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
  const brandClasses = useBrandStyles();
  const catalogApi = useApi(catalogApiRef);
  const navigate = useNavigate();
  const dashboardRoute = useRouteRef(brunoPageRouteRef);
  // `useApiHolder` rather than `useApi`: a host app is not obliged to register
  // either API, and `useApi` throws at RENDER time for a missing one — which
  // would take the whole card down instead of just blocking this action.
  const apis = useApiHolder();
  const scmAuth = apis.get(scmAuthApiRef);
  const scmIntegrations = apis.get(scmIntegrationsApiRef);

  const [options, setOptions] = useState<Options>({ status: 'loading' });
  const [selected, setSelected] = useState<Entity | null>(null);
  const [stage, setStage] = useState<Stage>({ status: 'choosing' });

  const apiRef = stringifyEntityRef(apiEntity);

  /**
   * Loads every Bruno entity, once per opening.
   *
   * All fields, no `fields` projection: the picker needs the title, the version,
   * the source URL and `backstage.io/managed-by-location` (to work out whether a
   * pull request is even possible), which is most of the entity anyway — and
   * collections number in the tens, not the thousands.
   */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let cancelled = false;
    setOptions({ status: 'loading' });
    catalogApi
      .getEntities({ filter: { kind: 'Bruno' } })
      .then((res) => {
        if (!cancelled) {
          setOptions({ status: 'ready', entities: res.items });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setOptions({
            status: 'error',
            message: e instanceof Error ? e.message : String(e)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogApi, open]);

  const close = (): void => {
    setStage({ status: 'choosing' });
    setSelected(null);
    onClose();
  };

  const fail = (e: unknown): void =>
    setStage({
      status: 'error',
      message: e instanceof Error ? e.message : String(e)
    });

  const location = selected ? descriptorLocation(selected) : undefined;
  const descriptorUrl
    = location?.kind === 'url' ? location.target : undefined;
  const isGitHub
    = descriptorUrl !== undefined
      && scmIntegrations?.byUrl(descriptorUrl)?.type === 'github';

  /**
   * The token is read as the FIRST await of the click handler — the browser
   * treats an OAuth popup opened after any other await as unsolicited and blocks
   * it. It is held in a local for the length of the call and is never stored in
   * state, logged, or put in a URL.
   */
  const withToken = async (
    fn: (token: string) => Promise<void>
  ): Promise<void> => {
    if (!scmAuth || !descriptorUrl) {
      fail(
        new Error(
          'No SCM authentication is configured in this Backstage app, so a pull '
          + 'request cannot be opened.'
        )
      );
      return;
    }
    try {
      const { token } = await scmAuth.getCredentials({
        url: descriptorUrl,
        additionalScope: { repoWrite: true }
      });
      if (!token) {
        throw new Error('The SCM provider returned no access token.');
      }
      await fn(token);
    } catch (e) {
      fail(e);
    }
  };

  const onPrepare = (): void => {
    if (!selected) {
      return;
    }
    const collectionName = selected.metadata.title ?? selected.metadata.name;
    setStage({ status: 'planning' });
    void withToken(async (token) => {
      const plan = await planLink({
        descriptorUrl: descriptorUrl as string,
        apiRef,
        collectionName,
        token
      });
      setStage({ status: 'preview', plan });
    });
  };

  const onSubmit = (plan: PartOfPlan): void => {
    setStage({ status: 'submitting', plan });
    void withToken(async (token) => {
      const { link } = await submitLink(plan, token);
      setStage({ status: 'submitted', link });
      if (selected) {
        onSubmitted?.(stringifyEntityRef(selected), link);
      }
    });
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
        <Button onClick={() => setStage({ status: 'choosing' })}>Back</Button>
        <Button onClick={close}>Close</Button>
      </>
    );
  } else if (stage.status === 'preview' || stage.status === 'submitting') {
    const { plan } = stage;
    body = (
      <>
        <Typography variant="body2">
          The pull request updates <code>{plan.path}</code> in{' '}
          <Link to={plan.repoUrl}>
            {plan.owner}/{plan.repo}
          </Link>{' '}
          on a new branch <code>{plan.branch}</code>, based on{' '}
          <code>{plan.baseBranch}</code>.
        </Typography>
        <Box className={classes.detail}>
          <Box className={classes.panes}>
            <Box>
              <Typography
                variant="caption"
                color="textSecondary"
                className={classes.paneLabel}
              >
                Before
              </Typography>
              <CodeSnippet text={plan.before} language="yaml" />
            </Box>
            <Box>
              <Typography
                variant="caption"
                color="textSecondary"
                className={classes.paneLabel}
              >
                After
              </Typography>
              <CodeSnippet text={plan.after} language="yaml" />
            </Box>
          </Box>
        </Box>
      </>
    );
    actions = (
      <>
        <Button
          onClick={() => setStage({ status: 'choosing' })}
          disabled={stage.status === 'submitting'}
        >
          Back
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={stage.status === 'submitting'}
          startIcon={
            stage.status === 'submitting'
              ? <CircularProgress size={16} />
              : undefined
          }
          onClick={() => onSubmit(plan)}
        >
          {stage.status === 'submitting'
            ? 'Opening pull request…'
            : 'Open pull request'}
        </Button>
      </>
    );
  } else {
    // Choosing (or reading the descriptor after a choice).
    const planning = stage.status === 'planning';
    const linked = new Set(linkedRefs);
    const available
      = options.status === 'ready'
        ? options.entities.filter(
            (e) => !linked.has(stringifyEntityRef(e))
          )
        : [];

    let picker: JSX.Element;
    if (options.status === 'loading') {
      picker = <Progress />;
    } else if (options.status === 'error') {
      picker = (
        <Typography variant="body2" color="error">
          Could not load Bruno collections: {options.message}
        </Typography>
      );
    } else if (available.length === 0) {
      picker = (
        <Typography variant="body2" color="textSecondary">
          {options.entities.length === 0
            ? 'No Bruno collections are registered in this catalog yet.'
            : 'Every registered Bruno collection is already linked to this API.'}
        </Typography>
      );
    } else {
      picker = (
        <CatalogAutocomplete<Entity>
          name="bruno-collection"
          label="Bruno collection"
          options={available}
          value={selected}
          disabled={planning}
          getOptionLabel={(option) =>
            option.metadata.title ?? option.metadata.name}
          onChange={(_event, value) => setSelected(value ?? null)}
          TextFieldProps={{ placeholder: 'Search collections' }}
        />
      );
    }

    body = (
      <>
        <Typography variant="body2">
          Linking adds <code>{apiRef}</code> to the collection&apos;s{' '}
          <code>spec.partOf</code>. Catalog relations are generated from source
          control, so this opens a pull request against the collection&apos;s{' '}
          <code>catalog-info.yaml</code>; the collection appears here once it is
          merged and Backstage re-reads the file.
        </Typography>
        <Box className={classes.detail}>{picker}</Box>

        {selected && (
          <Box className={classes.detail}>
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
            {/* The same four "no descriptor to edit" cases UnlinkDialog
                explains, checked here BEFORE a pull request is attempted. */}
            {location?.kind === 'none' && location.reason === 'provider' && (
              <Typography variant="body2" color="error" className={classes.detail}>
                This collection is defined by <code>bruno.collections[]</code> in
                your Backstage <code>app-config.yaml</code>, not by a{' '}
                <code>catalog-info.yaml</code>. Add <code>{apiRef}</code> to that
                entry&apos;s <code>partOf</code> list and restart Backstage.
              </Typography>
            )}
            {location?.kind === 'none' && location.reason === 'discovery' && (
              <Typography variant="body2" color="error" className={classes.detail}>
                This collection was discovered in its repository by{' '}
                <code>bruno.discovery</code>, so it has neither a{' '}
                <code>catalog-info.yaml</code> nor a{' '}
                <code>bruno.collections[]</code> entry to add{' '}
                <code>{apiRef}</code> to. Author a{' '}
                <code>catalog-info.yaml</code> declaring <code>kind: Bruno</code>{' '}
                in that repository — discovery defers to it — and link from
                there.
              </Typography>
            )}
            {location?.kind === 'none' && location.reason === 'file' && (
              <Typography variant="body2" color="error" className={classes.detail}>
                This collection is registered from a local file on the Backstage
                host&apos;s disk rather than from source control. Add{' '}
                <code>{apiRef}</code> to its <code>spec.partOf</code> directly.
              </Typography>
            )}
            {location?.kind === 'none' && location.reason === 'absent' && (
              <Typography variant="body2" color="error" className={classes.detail}>
                This collection carries no{' '}
                <code>backstage.io/managed-by-location</code>, so the file that
                declares it cannot be identified.
              </Typography>
            )}
            {location?.kind === 'url' && !isGitHub && (
              <Typography variant="body2" color="error" className={classes.detail}>
                Automatic pull requests are supported on GitHub only. In{' '}
                <Link to={location.target}>{location.target}</Link>, add{' '}
                <code>{apiRef}</code> to the <code>spec.partOf</code> list
                yourself.
              </Typography>
            )}
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
        <Button onClick={close} disabled={planning}>
          Cancel
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={planning || !selected || !isGitHub}
          startIcon={planning ? <CircularProgress size={16} /> : undefined}
          onClick={onPrepare}
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
