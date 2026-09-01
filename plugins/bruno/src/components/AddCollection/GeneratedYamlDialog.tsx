import { useEffect, useMemo, useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import CardHeader from '@material-ui/core/CardHeader';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import GetAppIcon from '@material-ui/icons/GetApp';
import {
  CodeSnippet,
  CopyTextButton,
  Link,
  WarningPanel
} from '@backstage/core-components';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApiHolder
} from '@backstage/core-plugin-api';
import { scmAuthApiRef, scmIntegrationsApiRef } from '@backstage/integration-react';
import { EntityRefLink, catalogApiRef } from '@backstage/plugin-catalog-react';
import { CatalogImportClient, catalogImportApiRef } from '@backstage/plugin-catalog-import';
import type { CatalogImportApi } from '@backstage/plugin-catalog-import';
import { landingTimeoutSeconds } from '../../lib/landingWindow';
import { repoRootFromCollectionUrl } from '../../lib/scmUrl';
import { useBrandStyles } from '../../theme/brandStyles';

const useStyles = makeStyles((theme) => ({
  section: {
    marginTop: theme.spacing(2)
  },
  preview: {
    // Capped so the limits panel below it stays above the fold on a laptop —
    // a warning nobody scrolls to is not surfaced. The descriptor is short
    // enough that this rarely bites, and the box scrolls when it does.
    maxHeight: 220,
    overflow: 'auto'
  },
  limits: {
    'margin': 0,
    'paddingLeft': theme.spacing(2.5),
    '& > li': {
      marginBottom: theme.spacing(0.5)
    }
  },
  landing: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1)
  }
}));

/** What the dialog is doing right now. */
type Stage
  = | { status: 'review' }
    | { status: 'submitting' }
    | { status: 'submitted'; link: string }
    | { status: 'error'; message: string };

/**
 * Whether the entity the create registered has reached the catalog yet.
 *
 * A SECOND union rather than more members on {@link Stage}, because the two run
 * concurrently: the collection lands on the provider's schedule, and the user
 * may well be editing a pull request title while it does. Folding them together
 * would make every pull-request state also assert something about the catalog.
 */
type Landing
  = | { status: 'waiting' }
    | { status: 'landed' }
    | { status: 'timed-out' };

/**
 * How often the catalog is asked whether the entity has appeared.
 *
 * The entity does not arrive any sooner for being asked about, so this is
 * bounding the "it is there and we have not noticed" gap, not the wait itself.
 * The provider tick is `refreshSeconds` (60 s by default) and lands at an
 * arbitrary point in that window, so 3 s costs about twenty cheap reads across
 * a whole flow and makes the success feel immediate when it comes.
 */
const LANDING_POLL_MS = 3000;

/** The two SCM types `catalogImportApi.submitPullRequest` can actually write to. */
const PR_CAPABLE_TYPES = ['github', 'azure'];

/**
 * Resolves a {@link CatalogImportApi}, constructing one if the app has not
 * registered the plugin that provides it.
 *
 * This app is one of those: `packages/app/src/App.tsx` installs the catalog,
 * auth, nav and Bruno features, but not `@backstage/plugin-catalog-import`, so
 * `catalogImportApiRef` is unregistered and `useApi` would THROW at render time
 * rather than return undefined. Building the default client ourselves from APIs
 * the app does register keeps the pull-request path working without forcing the
 * whole import wizard (and its `/catalog-import` page) into the app — and it is
 * the same class the ref would have resolved to, so every limitation documented
 * below applies identically either way.
 *
 * `useApiHolder` throughout, never `useApi`: each of these can legitimately be
 * absent in a host app, and one missing SCM API must disable a button rather
 * than take down the dialog.
 */
function useCatalogImportApi(): CatalogImportApi | undefined {
  const apis = useApiHolder();
  const registered = apis.get(catalogImportApiRef);
  const discoveryApi = apis.get(discoveryApiRef);
  const fetchApi = apis.get(fetchApiRef);
  const configApi = apis.get(configApiRef);
  const catalogApi = apis.get(catalogApiRef);
  const scmAuthApi = apis.get(scmAuthApiRef);
  const scmIntegrationsApi = apis.get(scmIntegrationsApiRef);

  return useMemo(() => {
    if (registered) {
      return registered;
    }
    if (
      !discoveryApi
      || !fetchApi
      || !configApi
      || !catalogApi
      || !scmAuthApi
      || !scmIntegrationsApi
    ) {
      return undefined;
    }
    return new CatalogImportClient({
      discoveryApi,
      fetchApi,
      configApi,
      catalogApi,
      scmAuthApi,
      scmIntegrationsApi
    });
  }, [
    registered,
    discoveryApi,
    fetchApi,
    configApi,
    catalogApi,
    scmAuthApi,
    scmIntegrationsApi
  ]);
}

/**
 * Hands `text` to the browser as a file download.
 *
 * Written out rather than reached for from a library because there is no native
 * download control anywhere in `plugin-catalog-import` — its wizard only ever
 * opens pull requests. The object URL is revoked immediately: the click is
 * synchronous, so the browser has already taken its own reference to the blob by
 * the time this returns, and leaving the URL alive leaks the whole string for
 * the lifetime of the document.
 */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Modal 2 of the add-collection flow: your collection is registered, here is
 * its descriptor, and here is how to get that into your repository too.
 *
 * Nothing on this screen is required. The collection already exists as a stored
 * row by the time this opens, so Close is a complete, successful ending — the
 * download and the pull request are for users who also want the descriptor
 * committed. That is why the landing notice at the top is the headline and the
 * YAML below it is framed as optional.
 *
 * Two exits on purpose, and the second one is the constrained one. Downloading
 * always works and always produces the right file in the right place, because
 * the user puts it there. The pull request is a convenience with several hard
 * limits baked into `plugin-catalog-import` — and one more that this flow
 * creates, since the collection is already registered — every one of which is
 * stated on screen BEFORE the button rather than discovered as a failure after
 * it; see the limits list below. That asymmetry is why Download is the plain, always
 * enabled action and the pull request is the one that can be disabled.
 *
 * The preview deliberately does NOT use `PreviewCatalogInfoComponent`, despite
 * that being the obvious component for the job: it re-serialises the entity with
 * its own `YAML.stringify`, so what it shows is not what gets downloaded or
 * committed — the leading comment block would be missing and any formatting
 * choice would be its own. The whole point of `toCatalogInfoYaml` is that one
 * string reaches all three destinations, so the preview renders that string.
 * The card around it mirrors that component's layout so the flow still looks
 * like the rest of Backstage's import UI.
 */
export function GeneratedYamlDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The collection URL the user entered, for resolving the repository root. */
  collectionUrl: string;
  /** The generated descriptor, exactly as it will be downloaded and committed. */
  yaml: string;
  /** The entity's name, for the pull request's default title. */
  name: string;
  /** Ref of the entity the create registered, for the landing poll and link. */
  entityRef: string;
  /**
   * The provider's refresh interval, as reported by the create. Quoted on
   * screen, so the wait the user is told about is the one actually configured.
   */
  refreshSeconds: number;
}): JSX.Element {
  const {
    open,
    onClose,
    collectionUrl,
    yaml,
    name,
    entityRef,
    refreshSeconds
  } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const catalogImportApi = useCatalogImportApi();
  const apis = useApiHolder();
  const configApi = apis.get(configApiRef);
  const catalogApi = apis.get(catalogApiRef);
  const scmAuth = apis.get(scmAuthApiRef);
  const scmIntegrations = apis.get(scmIntegrationsApiRef);

  const [stage, setStage] = useState<Stage>({ status: 'review' });
  const [landing, setLanding] = useState<Landing>({ status: 'waiting' });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  /**
   * The repository the pull request targets.
   *
   * NOT the collection URL. A collection usually lives in a subfolder, and
   * `submitPullRequest` parses `repositoryUrl` with `parseGitUrl` to get an
   * owner/repo pair — handing it a `/tree/<ref>/<path>` URL would put the path
   * segments in the wrong fields.
   */
  const repoUrl = repoRootFromCollectionUrl(collectionUrl);
  const scmType = scmIntegrations?.byUrl(repoUrl)?.type;
  const prSupported = !!scmType && PR_CAPABLE_TYPES.includes(scmType);
  // Both are read from config exactly as `plugin-catalog-import` reads them,
  // so the warnings below name the real filename and branch for THIS app rather
  // than repeating the upstream defaults.
  const catalogFilename
    = configApi?.getOptionalString('catalog.import.entityFilename')
      ?? 'catalog-info.yaml';
  const branchName
    = configApi?.getOptionalString('catalog.import.pullRequestBranchName')
      ?? 'backstage-integration';

  /**
   * Seeds the editable title and body from the app's own wording, falling back
   * to ours when the API cannot supply one (`preparePullRequest` is optional on
   * the interface, so an app with a custom implementation may omit it).
   */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let cancelled = false;
    const fallback = {
      title: `Add ${catalogFilename} for Bruno collection ${name}`,
      body:
        'This pull request adds a **Backstage entity metadata file** for a '
        + 'Bruno collection, so that the collection appears in the software '
        + 'catalog.\n\nOpened from Backstage.'
    };
    Promise.resolve(catalogImportApi?.preparePullRequest?.())
      .then((prepared) => {
        if (!cancelled) {
          setTitle(prepared?.title ?? fallback.title);
          setBody(prepared?.body ?? fallback.body);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTitle(fallback.title);
          setBody(fallback.body);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogFilename, catalogImportApi, name, open]);

  /**
   * Watches for the entity to appear in the catalog.
   *
   * The wait is real and unavoidable: the create wrote a row to the Bruno
   * backend's store, and `BrunoCollectionEntityProvider` turns that into a
   * catalog entity on its own schedule. So this dialog opens on a collection
   * that is registered but not yet queryable, and the honest thing is to watch
   * rather than to assert.
   *
   * Fires ONCE IMMEDIATELY before starting the interval, because a provider tick
   * can easily land between the create returning and this rendering — without
   * the leading call that user would watch a spinner for three seconds for
   * nothing.
   *
   * A THROWN error is treated as another "not yet" and the poll continues. The
   * two realistic throws here are a token refresh and a backend restart, both
   * transient, and ending the wait on one would report a timeout for a
   * collection that lands four seconds later. A resolved `undefined` is the same
   * "not yet": `getEntityByRef` answers a missing ref with `undefined` rather
   * than by rejecting, so the two paths are genuinely the same fact.
   *
   * `catalogApi` is read from the holder rather than with `useApi` for the same
   * reason the import client is: a host app need not register it, and a missing
   * catalog must cost the poll, not the dialog.
   */
  useEffect(() => {
    if (!open || !catalogApi) {
      return undefined;
    }

    let cancelled = false;
    const deadline = Date.now() + landingTimeoutSeconds(refreshSeconds) * 1000;

    const settle = (next: Landing): void => {
      setLanding(next);
      clearInterval(timer);
    };

    const poll = (): void => {
      catalogApi
        .getEntityByRef(entityRef)
        .then((entity) => {
          if (cancelled) {
            return;
          }
          if (entity) {
            settle({ status: 'landed' });
          } else if (Date.now() >= deadline) {
            settle({ status: 'timed-out' });
          }
        })
        .catch(() => {
          if (!cancelled && Date.now() >= deadline) {
            settle({ status: 'timed-out' });
          }
        });
    };

    // Scheduled BEFORE the first call, so `timer` can be a `const` that the
    // `settle` closure above closes over without a temporal-dead-zone hazard.
    // Ordering costs nothing: `poll` settles on a promise, so the immediate
    // call cannot reach `settle` until after this statement has run either way.
    const timer = setInterval(poll, LANDING_POLL_MS);
    poll();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [catalogApi, entityRef, open, refreshSeconds]);

  const close = (): void => {
    setStage({ status: 'review' });
    setLanding({ status: 'waiting' });
    onClose();
  };

  /**
   * Opens the pull request.
   *
   * The credential call is deliberately hoisted OUT of `submitPullRequest` and
   * made the FIRST await of the click handler. The client's own implementation
   * validates the entity against the live catalog before it asks for
   * credentials, and a browser blocks an OAuth popup opened after an
   * intervening await as unsolicited — so on a cold session the upstream order
   * silently fails to authenticate. Warming the session here means the client's
   * own `getCredentials` resolves from cache. The token is never bound to a
   * name, stored, or logged; only the session it establishes is used.
   */
  const submit = (): void => {
    if (!catalogImportApi || !scmAuth) {
      setStage({
        status: 'error',
        message:
          'No SCM authentication is configured in this Backstage app, so a '
          + 'pull request cannot be opened. Download the file and add it by '
          + 'hand instead.'
      });
      return;
    }
    setStage({ status: 'submitting' });
    void (async () => {
      try {
        await scmAuth.getCredentials({
          url: repoUrl,
          additionalScope: { repoWrite: true }
        });
        const { link } = await catalogImportApi.submitPullRequest({
          repositoryUrl: repoUrl,
          fileContent: yaml,
          title,
          body
        });
        setStage({ status: 'submitted', link });
      } catch (e) {
        setStage({
          status: 'error',
          message: e instanceof Error ? e.message : String(e)
        });
      }
    })();
  };

  /**
   * Everything `catalogImportApi.submitPullRequest` will do that the user would
   * otherwise only find out about afterwards, plus the one thing THIS flow
   * causes. Stated up front, with the one that is checkable checked
   * (`prSupported`) and the button pre-disabled.
   *
   * The last item is the new one and it is not a limitation of the import API:
   * the collection is already registered by the time this dialog opens, so a
   * merged descriptor that is later registered as a location is a SECOND claim
   * on the same entity name. It is warn-before-the-click rather than
   * detect-and-repair on purpose — the recovery is one delete from the
   * dashboard, and silently removing a user's collection because they opened a
   * pull request would be a far worse surprise than the conflict it avoids.
   *
   * Two `WarningPanel` details matter here. `defaultExpanded`, because it is an
   * Accordion whose body starts collapsed — an unexpanded warning is not a
   * surfaced one. And the list goes in `children` rather than `message`:
   * `message` is rendered inside a `Typography variant="body1"`, i.e. a `<p>`,
   * and a `<ul>` inside a `<p>` is invalid HTML that React reparents at runtime.
   */
  const limits = (
    <ul className={classes.limits}>
      <li>
        The pull request adds <code>{catalogFilename}</code> at the{' '}
        <strong>repository root</strong>, not in the collection folder. Download
        the file instead if it needs to live beside the collection.
      </li>
      <li>
        If the repository already has a root <code>{catalogFilename}</code>, the
        pull request will fail — the commit is created, never updated. Download
        the file and merge it into the existing one by hand.
      </li>
      <li>
        Only GitHub and Azure DevOps are supported.
        {scmType
          ? ` This URL resolves to a ${scmType} integration.`
          : ' This URL matches no configured integration.'}
      </li>
      <li>
        Every import uses the branch <code>{branchName}</code>, so only one
        import can be open against a repository at a time.
      </li>
      <li>
        The entity is validated against the live catalog before the commit is
        made, so a backend that does not know <code>kind: Bruno</code> will
        reject it here.
      </li>
      <li>
        This collection is already registered from the Bruno UI. If you merge
        this pull request and then also register the file as a catalog location,
        two sources will claim the entity name <code>{name}</code>. Backstage
        keeps whichever source claimed it first — the one you just created — and
        logs a conflict for the other, so the descriptor will appear to do
        nothing. Delete this collection from the Bruno dashboard first if you
        want the descriptor to own it.
      </li>
    </ul>
  );

  /**
   * Whether the entity has reached the catalog, in the user's terms.
   *
   * Rendered above everything else in both stages, because it is the only thing
   * on screen that is about the collection rather than about the descriptor —
   * and because the user can be mid-pull-request when it lands.
   *
   * None of the three states claims more than is known. `waiting` says the
   * collection is added (it is — the row is stored) and that the CATALOG has not
   * caught up, without offering a link that would 404. `timed-out` is
   * deliberately not written as a failure: nothing has gone wrong that
   * re-submitting would fix, and telling the user otherwise would produce a
   * second collection under a second name.
   */
  const landingNotice = (
    <>
      {landing.status === 'waiting' && (
        <>
          <Typography variant="body2" className={classes.landing}>
            <CircularProgress size={16} />
            <strong>{name} has been added.</strong>
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Backstage re-reads its collection list every {refreshSeconds}{' '}
            seconds, so the entity appears in the catalog shortly; this message
            becomes a link when it does. You can close this window — the
            collection is registered either way.
          </Typography>
        </>
      )}
      {landing.status === 'landed' && (
        <Typography variant="body2" className={classes.landing}>
          <strong>{name} is in the catalog.</strong>
          <EntityRefLink entityRef={entityRef} defaultKind="Bruno" />
        </Typography>
      )}
      {landing.status === 'timed-out' && (
        <>
          <Typography variant="body2">
            <strong>
              {name} is registered but has not appeared in the catalog yet.
            </strong>
          </Typography>
          <Typography variant="body2" color="textSecondary">
            That usually means the collection could not be re-read from source
            control on the last refresh — check the backend log for{' '}
            <code>BrunoCollectionEntityProvider</code>. It will appear on a later
            refresh; nothing needs to be re-submitted.
          </Typography>
        </>
      )}
    </>
  );

  let content: JSX.Element;
  let actions: JSX.Element;

  if (stage.status === 'submitted') {
    content = (
      <>
        {landingNotice}
        {/*
          Deliberately not "the collection appears in the catalog once it is
          merged" any more: it is already registered, and the pull request only
          decides whether the descriptor also lives in the repository. Saying
          otherwise here would contradict the notice directly above.
        */}
        <Typography variant="body2" className={classes.section}>
          Pull request opened. Merging it puts{' '}
          <code>{catalogFilename}</code> in the repository; your collection is
          registered either way.
        </Typography>
        <Typography variant="body2" className={classes.section}>
          <Link to={stage.link}>{stage.link}</Link>
        </Typography>
      </>
    );
    actions = (
      <>
        <CopyTextButton
          text={stage.link}
          tooltipText="Pull request link copied"
        />
        <Button onClick={close}>Close</Button>
      </>
    );
  } else {
    const submitting = stage.status === 'submitting';
    content = (
      <>
        {landingNotice}

        <Typography variant="body2" className={classes.section}>
          Your collection is registered. This is the equivalent{' '}
          <code>catalog-info.yaml</code> — you only need it if you also want the
          descriptor committed to your repository. Downloading it and opening a
          pull request are both optional.
        </Typography>

        <Box className={classes.section}>
          <Card variant="outlined">
            <CardHeader
              // `subtitle2`, where `PreviewCatalogInfoComponent` leaves the
              // default `h5`: this is a path, not a heading, and at h5 a repo
              // URL wraps onto three lines and dominates the dialog.
              titleTypographyProps={{ variant: 'subtitle2' }}
              title={<code>{`${repoUrl.replace(/\/$/, '')}/${catalogFilename}`}</code>}
            />
            <CardContent className={classes.preview}>
              <CodeSnippet text={yaml} language="yaml" />
            </CardContent>
          </Card>
        </Box>

        <Box className={classes.section}>
          <WarningPanel
            severity="info"
            title="Before you open a pull request"
            defaultExpanded
          >
            {limits}
          </WarningPanel>
        </Box>

        <Box className={classes.section}>
          <TextField
            fullWidth
            variant="outlined"
            label="Pull request title"
            value={title}
            disabled={submitting || !prSupported}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Box>
        <Box className={classes.section}>
          <TextField
            fullWidth
            multiline
            minRows={3}
            variant="outlined"
            label="Pull request body"
            value={body}
            disabled={submitting || !prSupported}
            onChange={(event) => setBody(event.target.value)}
          />
        </Box>

        {stage.status === 'error' && (
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
    actions = (
      <>
        <Button onClick={close} disabled={submitting}>
          Close
        </Button>
        <CopyTextButton text={yaml} tooltipText="catalog-info.yaml copied" />
        <Button
          variant="outlined"
          className={brandClasses.accentOutlinedButton}
          startIcon={<GetAppIcon />}
          onClick={() => downloadText(catalogFilename, yaml)}
        >
          Download
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          // Disabled rather than hidden: the reason lives in the limits panel
          // directly above, and a button that vanishes on GitLab reads as a
          // rendering bug rather than as an unsupported provider.
          disabled={submitting || !prSupported || !catalogImportApi}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          onClick={submit}
        >
          {submitting ? 'Opening pull request…' : 'Create pull request'}
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
      <DialogTitle>{name} added</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
