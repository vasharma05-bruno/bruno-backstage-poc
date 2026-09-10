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
import { useRouteRef } from '@backstage/frontend-plugin-api';
import { scmAuthApiRef, scmIntegrationsApiRef } from '@backstage/integration-react';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  CatalogImportClient,
  catalogImportApiRef,
  catalogImportPlugin
} from '@backstage/plugin-catalog-import';
import type { CatalogImportApi } from '@backstage/plugin-catalog-import';
import {
  descriptorPathForCollection,
  repoRootFromCollectionUrl
} from '../../lib/scmUrl';
import { planDescriptorPr, submitDescriptorPr } from '../../lib/descriptorPr';
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
  }
}));

/** What the dialog is doing right now. */
type Stage
  = | { status: 'review' }
    | { status: 'submitting' }
    | { status: 'submitted'; link: string }
    | { status: 'error'; message: string };

/**
 * The SCM types this dialog can open a pull request against: GitHub through
 * `lib/descriptorPr.ts`, Azure DevOps through `catalogImportApi` — which is the
 * only other provider that client can write to.
 */
const PR_CAPABLE_TYPES = ['github', 'azure'];

/**
 * Resolves a {@link CatalogImportApi}, constructing one if the app has not
 * registered the plugin that provides it.
 *
 * THIS app is not one of those, and it is worth being precise about why, because
 * the obvious reading of `packages/app/src/App.tsx` says otherwise: its
 * `createApp({ features: [...] })` list does not mention
 * `@backstage/plugin-catalog-import`. Registration does not go through that list
 * at all. `app.packages: all` (app-config.yaml) turns on the CLI's package
 * detection, which scans `packages/app/package.json` dependencies for any
 * package whose `backstage.role` is `frontend-plugin` and whose `exports` carry
 * `./alpha` (`cli-module-build/dist/lib/bundler/packageDetection.cjs.js:56-62`),
 * emits `window['__@backstage/discovered__']`, and `createApp` registers each
 * default export from it (`frontend-defaults/dist/discovery.esm.js`).
 * `plugin-catalog-import` matches on every count and is a dependency of the app,
 * so both its API and its `/catalog-import` page ARE live here.
 *
 * The fallback stays anyway, and not as dead weight: `app.packages` may be unset
 * or carry an `exclude`, and a host app embedding this plugin is under no
 * obligation to depend on `plugin-catalog-import` at all. In those apps
 * `catalogImportApiRef` really is unregistered and `useApi` would THROW at render
 * time rather than return undefined. The constructed client is the same class the
 * ref resolves to, so every limitation documented below applies identically
 * either way.
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
 * Modal 2 of the add-collection flow: here is the descriptor for the collection
 * you described, and here is how to get it into your repository.
 *
 * Everything on this screen is required in a way it was not before. This dialog
 * used to open on a collection that had ALREADY been registered, which made it
 * pure garnish — Close was a complete, successful ending and the descriptor was
 * an extra for users who also wanted it committed. That is no longer true: the
 * pull-request path registers nothing, so the file this dialog produces is the
 * collection's only route into the catalog. Closing without downloading it or
 * opening a pull request leaves nothing behind at all, and the copy says so
 * rather than letting the user infer it.
 *
 * There is deliberately no catalog poll and no entity link. The entity does not
 * exist yet and cannot be made to: it appears when the merged `catalog-info.yaml`
 * is registered as a catalog location, which is neither this dialog's doing nor
 * on any schedule it could wait out. Watching for it would spin for the whole
 * landing window and then report a timeout for something that was never coming
 * — which is exactly the "nothing has gone wrong that re-submitting would fix"
 * message the old timeout state existed to avoid, arrived at the wrong way.
 *
 * Two exits, and the second one is the constrained one. Downloading always works
 * and always produces the right file in the right place, because the user puts
 * it there. The pull request is a convenience with several hard limits baked into
 * `plugin-catalog-import`, every one of which is stated on screen BEFORE the
 * button rather than discovered as a failure after it; see the limits list
 * below. That asymmetry is why Download is the plain, always enabled action and
 * the pull request is the one that can be disabled.
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
}): JSX.Element {
  const { open, onClose, collectionUrl, yaml, name } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const catalogImportApi = useCatalogImportApi();
  const apis = useApiHolder();
  const configApi = apis.get(configApiRef);
  const scmAuth = apis.get(scmAuthApiRef);
  const scmIntegrations = apis.get(scmIntegrationsApiRef);

  /**
   * Path of the catalog's own "Register an existing component" page, which is
   * where the step AFTER this dialog happens: it calls `catalogApi.addLocation`
   * for a `catalog-info.yaml` URL, which is the only thing that turns the merged
   * file into an entity.
   *
   * Resolved through `useRouteRef` rather than hardcoded as `/catalog-import`,
   * because the path is overridable from `app-config.yaml` (`app.extensions`,
   * exactly as this app already remounts `page:catalog` at `/`), and a link to
   * the default path in an app that moved it is a 404 that looks like our bug.
   *
   * The ref comes off the OLD-system plugin export because the new-system
   * `/alpha` entry point does not re-export it, and they are the same object:
   * `alpha.esm.js` imports `rootRouteRef` from `plugin.esm.js` and declares it as
   * `routes.importPage`. `useRouteRef` returns undefined when the page is not
   * mounted — a host app that excluded the package — which is what the prose
   * fallback below is for.
   */
  const importRoute = useRouteRef(catalogImportPlugin.routes.importPage);

  const [stage, setStage] = useState<Stage>({ status: 'review' });
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
  /**
   * Whether we can commit the descriptor where it belongs.
   *
   * GitHub goes through `lib/descriptorPr.ts`, which writes to an arbitrary
   * path; everything else falls back to `catalogImportApi`, which can only
   * write to the repository ROOT. That is the whole reason for the branch, and
   * the limits panel says which one the user is about to get.
   */
  const pathAware = scmType === 'github';
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
   * Where the descriptor belongs: beside the collection, not at the repository
   * root.
   *
   * This is the file's real home whatever the provider, so it is what the
   * preview card is headed with and what a download is meant to become. The
   * Azure fallback cannot reach it, and the limits panel says so rather than
   * letting the card quietly promise a path the pull request will not use.
   */
  const descriptorPath = descriptorPathForCollection(
    collectionUrl,
    catalogFilename
  );
  /** Whether the collection is a folder in its repository rather than all of it. */
  const inSubfolder = descriptorPath !== catalogFilename;
  /**
   * Where the pull request will ACTUALLY put the file — the same thing on the
   * GitHub path, and the repository root on the Azure fallback. Named apart from
   * `descriptorPath` so the copy below can state the difference instead of
   * asserting one of the two and being wrong half the time.
   */
  const prPath = pathAware ? descriptorPath : catalogFilename;

  /**
   * The GitHub API to talk to, for a GitHub Enterprise host.
   *
   * Left undefined for github.com, where the integration config omits it and
   * Octokit's own default is right. Passing something wrong here would send
   * every call at the public API and 404 on a repository that exists.
   */
  const githubApiBaseUrl = scmIntegrations?.github.byUrl(repoUrl)?.config
    .apiBaseUrl;

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
      title: `Add ${prPath} for Bruno collection ${name}`,
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
  }, [catalogImportApi, name, open, prPath]);

  const close = (): void => {
    setStage({ status: 'review' });
    onClose();
  };

  /**
   * Opens the pull request.
   *
   * The credential call is the FIRST await of the click handler on both paths,
   * and on the Azure one it is deliberately hoisted OUT of `submitPullRequest`.
   * That client validates the entity against the live catalog before it asks
   * for credentials, and a browser blocks an OAuth popup opened after an
   * intervening await as unsolicited — so on a cold session the upstream order
   * silently fails to authenticate. Warming the session here means the client's
   * own `getCredentials` resolves from cache. The token is held in a local for
   * the length of the call and is never stored in state, logged, or put in a
   * URL.
   *
   * Two paths, because only one of them can put the file in the right place:
   *
   *  - **GitHub** goes through `lib/descriptorPr.ts`, which commits to
   *    `descriptorPath` — the collection's own folder — on a branch named per
   *    attempt, and refuses rather than overwriting a descriptor that is
   *    already there.
   *  - **Azure DevOps** goes through `catalogImportApi`, which can only write
   *    `catalogFilename` at the repository root on one fixed branch. Kept
   *    rather than dropped: it is the only thing an Azure user has, and the
   *    limits panel states exactly what it will do before they click.
   */
  const submit = (): void => {
    if (!scmAuth || (!pathAware && !catalogImportApi)) {
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
        const { token } = await scmAuth.getCredentials({
          url: repoUrl,
          additionalScope: { repoWrite: true }
        });
        if (pathAware) {
          if (!token) {
            throw new Error('The SCM provider returned no access token.');
          }
          const plan = await planDescriptorPr({
            collectionUrl,
            collectionName: name,
            filename: catalogFilename,
            content: yaml,
            title,
            body,
            token,
            apiBaseUrl: githubApiBaseUrl
          });
          const { link } = await submitDescriptorPr(
            plan,
            token,
            githubApiBaseUrl
          );
          setStage({ status: 'submitted', link });
          return;
        }
        const { link } = await (
          catalogImportApi as CatalogImportApi
        ).submitPullRequest({
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
   * How to register the merged file, named once and used in both stages.
   *
   * Two renderings of the same instruction rather than one, because the useful
   * sentence depends on whether the app actually has the page. With it, the step
   * is a link and the user can finish the job; without it, the honest answer is
   * the operator-level one (a `catalog.locations` entry, or a discovery provider)
   * and pointing at a route that is not mounted would be worse than saying so.
   */
  const registerStep = importRoute
    ? (
        <>
          register it on the{' '}
          <Link to={importRoute()}>Register an existing component</Link> page
        </>
      )
    : (
        <>
          register it as a catalog location — a <code>catalog.locations</code>{' '}
          entry, or a discovery provider that scans the repository
        </>
      );

  /**
   * Everything `catalogImportApi.submitPullRequest` will do that the user would
   * otherwise only find out about afterwards, plus the one thing THIS path
   * requires of them. Stated up front, with the one that is checkable checked
   * (`prSupported`) and the button pre-disabled.
   *
   * The last item replaces the entity-name conflict this list used to warn
   * about. That warning existed because the collection was already registered
   * when the dialog opened, making a merged descriptor a second claim on one
   * name; this path registers nothing, so the conflict is gone and the opposite
   * risk takes its place — a merged file that nobody registers as a location
   * produces no entity at all, and the user has no way to tell that from a
   * catalog that is merely slow.
   *
   * Two `WarningPanel` details matter here. `defaultExpanded`, because it is an
   * Accordion whose body starts collapsed — an unexpanded warning is not a
   * surfaced one. And the list goes in `children` rather than `message`:
   * `message` is rendered inside a `Typography variant="body1"`, i.e. a `<p>`,
   * and a `<ul>` inside a `<p>` is invalid HTML that React reparents at runtime.
   */
  const limits = (
    <ul className={classes.limits}>
      {prPath === descriptorPath
        ? (
            <li>
              The pull request adds <code>{prPath}</code>
              {inSubfolder
                ? ' — beside the collection, so one repository can describe a collection per folder.'
                : ', which is the repository root because this collection is the whole repository.'}
            </li>
          )
        : (
            <li>
              The pull request adds <code>{prPath}</code> at the{' '}
              <strong>repository root</strong>, not at{' '}
              <code>{descriptorPath}</code> beside the collection — only the
              GitHub path can commit to a collection folder. Download the file
              instead if it needs to live there.
            </li>
          )}
      <li>
        If <code>{prPath}</code> already exists, the pull request is refused
        rather than overwriting it — this
        flow only adds a new descriptor. Download the file and merge it into the
        existing one by hand.
      </li>
      <li>
        Only GitHub and Azure DevOps are supported.
        {scmType
          ? ` This URL resolves to a ${scmType} integration.`
          : ' This URL matches no configured integration.'}
      </li>
      {pathAware
        ? (
            <li>
              The branch is named per pull request, so several collections in
              one repository can be in flight at once.
            </li>
          )
        : (
            <>
              <li>
                Every import uses the branch <code>{branchName}</code>, so only
                one import can be open against a repository at a time.
              </li>
              <li>
                The entity is validated against the live catalog before the
                commit is made, so a backend that does not know{' '}
                <code>kind: Bruno</code> will reject it here.
              </li>
            </>
          )}
      <li>
        Merging the pull request does not by itself put <code>{name}</code> in
        the catalog — Backstage does not read a file it has not been pointed at.
        Once the pull request is merged, {registerStep}. Use{' '}
        <strong>Add collection</strong> on the previous screen instead if you
        want the collection registered without touching your repository.
      </li>
    </ul>
  );

  let content: JSX.Element;
  let actions: JSX.Element;

  if (stage.status === 'submitted') {
    content = (
      <>
        <Typography variant="body2">
          <strong>Pull request opened.</strong>
        </Typography>
        {/*
          Both steps named, in order, because the second one is the one users
          will not expect: merging the file is not registering it. Saying only
          "merge it and the collection appears" is the mistake this copy exists
          to avoid — it would leave someone waiting on a catalog that was never
          asked to read the file.
        */}
        <Typography variant="body2" className={classes.section}>
          Merging it adds <code>{prPath}</code> to the repository. Then{' '}
          {registerStep} — <code>{name}</code> appears in the catalog at that
          point, not before.
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
        <Typography variant="body2">
          This is the <code>catalog-info.yaml</code> for{' '}
          <code>{name}</code>. Commit it to your repository — by pull request
          below, or by downloading it and adding it yourself — then{' '}
          {registerStep}. That descriptor is what puts the collection in the
          catalog and stays its source of truth.
        </Typography>
        {/*
          Said plainly, because the previous version of this dialog opened on an
          already-registered collection and trained the opposite expectation:
          closing here really does discard the collection.
        */}
        <Typography
          variant="body2"
          color="textSecondary"
          className={classes.section}
        >
          Nothing has been registered yet. Closing this window without
          downloading the file or opening a pull request discards it.
        </Typography>

        <Box className={classes.section}>
          <Card variant="outlined">
            <CardHeader
              // `subtitle2`, where `PreviewCatalogInfoComponent` leaves the
              // default `h5`: this is a path, not a heading, and at h5 a repo
              // URL wraps onto three lines and dominates the dialog.
              titleTypographyProps={{ variant: 'subtitle2' }}
              title={<code>{`${repoUrl.replace(/\/$/, '')}/${descriptorPath}`}</code>}
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
          // `catalogImportApi` only gates the Azure path; the GitHub one talks
          // to the repository itself and needs nothing from that plugin.
          disabled={
            submitting || !prSupported || (!pathAware && !catalogImportApi)
          }
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
      <DialogTitle>Add {name} by pull request</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}
