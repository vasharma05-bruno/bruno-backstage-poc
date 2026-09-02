import { useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { CodeSnippet, CopyTextButton, Link } from '@backstage/core-components';
import { useApiHolder } from '@backstage/core-plugin-api';
import { scmAuthApiRef, scmIntegrationsApiRef } from '@backstage/integration-react';
import type { Entity } from '@backstage/catalog-model';
import { InlineNotice } from '../InlineNotice';
import { useBrandStyles } from '../../theme/brandStyles';
import { descriptorLocation } from '../../lib/brunoEntity';
import type { UnlinkPlan } from '../../lib/unlinkPr';
import { planUnlink, submitUnlink } from '../../lib/unlinkPr';

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
  }
}));

/** What the dialog is doing right now. */
type Stage
  = | { status: 'preflight' }
    | { status: 'planning' }
    | { status: 'preview'; plan: UnlinkPlan }
    | { status: 'submitting'; plan: UnlinkPlan }
    | { status: 'submitted'; link: string }
    | { status: 'error'; message: string };

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
 * Shared with UI-P4's Bruno Collections card on API entity pages, which runs the
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
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  // `useApiHolder` rather than `useApi`: a host app is not obliged to register
  // either API, and `useApi` throws at RENDER time for a missing one — which
  // would take the whole card down instead of just blocking this action.
  const apis = useApiHolder();
  const scmAuth = apis.get(scmAuthApiRef);
  const scmIntegrations = apis.get(scmIntegrationsApiRef);

  const [stage, setStage] = useState<Stage>({ status: 'preflight' });

  const location = descriptorLocation(collection);
  const collectionName = collection.metadata.title ?? collection.metadata.name;
  const descriptorUrl = location.kind === 'url' ? location.target : undefined;
  const isGitHub
    = descriptorUrl !== undefined
      && scmIntegrations?.byUrl(descriptorUrl)?.type === 'github';

  const close = (): void => {
    setStage({ status: 'preflight' });
    onClose();
  };

  const fail = (e: unknown): void =>
    setStage({
      status: 'error',
      message: e instanceof Error ? e.message : String(e)
    });

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
    setStage({ status: 'planning' });
    void withToken(async (token) => {
      const plan = await planUnlink({
        descriptorUrl: descriptorUrl as string,
        apiRef,
        collectionName,
        token
      });
      setStage({ status: 'preview', plan });
    });
  };

  const onSubmit = (plan: UnlinkPlan): void => {
    setStage({ status: 'submitting', plan });
    void withToken(async (token) => {
      const { link } = await submitUnlink(plan, token);
      setStage({ status: 'submitted', link });
      onSubmitted?.(link);
    });
  };

  let body: JSX.Element;
  let actions: JSX.Element;

  if (location.kind === 'none' && location.reason === 'provider') {
    // A `bruno.collections[]` entry: the provider stamps the collection FOLDER
    // as the managed-by-location, so there is no descriptor file anywhere.
    // Stated as the same standing notice the link flow uses, for the same
    // reason: the collection is registered and healthy, and being configured
    // this way is not a fault to be reported.
    body = (
      <InlineNotice>
        Declared by <code>bruno.collections[]</code> in{' '}
        <code>app-config.yaml</code>, so there is no descriptor to open a pull
        request against. Remove <code>{apiRef}</code> from that entry&apos;s{' '}
        <code>partOf</code> list and restart Backstage.
      </InlineNotice>
    );
    actions = <Button onClick={close}>Close</Button>;
  } else if (location.kind === 'none' && location.reason === 'discovery') {
    // Discovered by `bruno.discovery[]`: no descriptor, and no config entry to
    // edit either — the entity is re-derived from the repository every tick.
    body = (
      <>
        <Typography variant="body2">
          This collection was discovered in its repository by{' '}
          <code>bruno.discovery</code>, so there is no{' '}
          <code>catalog-info.yaml</code> and no{' '}
          <code>bruno.collections[]</code> entry to edit — its links are
          re-derived from source control on every refresh.
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          To control <code>spec.partOf</code> yourself, add a{' '}
          <code>catalog-info.yaml</code> declaring{' '}
          <code>kind: Bruno</code> to the collection&apos;s repository:
          discovery leaves an authored descriptor to take over.
        </Typography>
      </>
    );
    actions = <Button onClick={close}>Close</Button>;
  } else if (location.kind === 'none' && location.reason === 'file') {
    body = (
      <InlineNotice>
        Registered from a local file on the Backstage host&apos;s disk, not from
        source control. Remove <code>{apiRef}</code> from its{' '}
        <code>spec.partOf</code> in that file directly.
      </InlineNotice>
    );
    actions = <Button onClick={close}>Close</Button>;
  } else if (location.kind === 'none') {
    body = (
      <Typography variant="body2">
        This entity carries no <code>backstage.io/managed-by-location</code>, so
        the file that declares it cannot be identified.
      </Typography>
    );
    actions = <Button onClick={close}>Close</Button>;
  } else if (!isGitHub) {
    body = (
      <>
        <Typography variant="body2">
          Automatic pull requests are supported on GitHub only. Edit the
          descriptor yourself:
        </Typography>
        <Typography variant="body2" className={classes.detail}>
          In <Link to={location.target}>{location.target}</Link>, remove{' '}
          <code>{apiRef}</code> from the <code>spec.partOf</code> list (and drop
          the <code>partOf</code> key entirely if it empties).
        </Typography>
      </>
    );
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
        <Button onClick={() => setStage({ status: 'preflight' })}>Back</Button>
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
        <Button onClick={close} disabled={stage.status === 'submitting'}>
          Cancel
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
        <Typography variant="body2" className={classes.detail}>
          Descriptor: <Link to={location.target}>{location.target}</Link>
        </Typography>
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
      <DialogTitle>Unlink {apiRef}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
