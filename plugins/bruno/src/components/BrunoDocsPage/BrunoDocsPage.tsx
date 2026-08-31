import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { makeStyles } from '@material-ui/core/styles';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import LaunchIcon from '@material-ui/icons/Launch';
import { Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { PageLayout, useRouteRefParams } from '@backstage/frontend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { brunoDocsPageRouteRef } from '../../extensions';
import { definition, definitionOmittedReason } from '../../lib/brunoEntity';
import { useEntityDocsSession } from '../../lib/docsSession';
import { brunoBrand } from '../../theme/brand';
import { useBrandStyles } from '../../theme/brandStyles';
import { BrunoIcon } from '../BrunoLogo';

// Query param that switches the page to the chrome-less, full-viewport layout
// (no sidebar / no header — just the docs iframe filling the whole window). The
// "Open in new tab" action links to `?view=full`.
const FULL_VIEW_PARAM = 'view';
const FULL_VIEW_VALUE = 'full';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    frame: {
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      border: 0,
      // Sit above the app chrome (sidebar/header) so only the docs are visible.
      zIndex: theme.zIndex.modal + 1
    },
    // Embedded (default) layout. The app's content area isn't viewport-anchored
    // (its height collapses to content), so a flex/`height:100%` iframe would fall
    // back to the intrinsic ~150px. Instead we compute an explicit pixel height at
    // runtime (fill from the iframe's top edge to the bottom of the viewport) and
    // set it inline; this width/border rule just covers the rest.
    embeddedFrame: {
      display: 'block',
      width: '100%',
      border: 0
    },
    // Branded holding surface for the pre-iframe states (resolving the entity,
    // then loading the bundle) and for a hard failure.
    message: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: theme.spacing(2),
      margin: theme.spacing(4),
      padding: theme.spacing(5, 4),
      borderRadius: theme.shape.borderRadius,
      borderTop: `3px solid ${brand.accent}`,
      background: brand.wash
    },
    messageMark: {
      fontSize: 44
    },
    messageProgress: {
      width: '100%',
      maxWidth: 320
    }
  };
});

/**
 * Branded holding panel shown while the collection entity is resolved and the
 * OpenCollection bundle loads, and in place of the iframe on a hard failure.
 * Both layouts share it, so the brand shows up before the docs do.
 */
function DocsMessage(props: {
  classes: ReturnType<typeof useStyles>;
  error?: string;
}): JSX.Element {
  const { classes, error } = props;
  return (
    <Box className={classes.message}>
      <BrunoIcon className={classes.messageMark} />
      {error ? (
        <Typography variant="body1" color="error" align="center">
          {error}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="textSecondary">
            Loading API documentation…
          </Typography>
          <Box className={classes.messageProgress}>
            <Progress />
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * Standalone page rendering a Bruno collection's OpenCollection API docs at
 * `/bruno/docs/<namespace>/<name>`, opened in a new tab from the entity page's
 * "Bruno API Docs" tab.
 *
 * Keyed by entity ref rather than by a backend collection id: the collection IS
 * an entity now, and the generated OpenCollection document lives on it as
 * `spec.definition`. The backend renders that document at
 * `/entities/:namespace/:name/docs` and this page frames it by `src` — the
 * entity is still fetched here, but only to know whether there is a document to
 * frame and to explain the cases where there is not. Rendering the document in
 * the browser instead (a `blob:` URL) would make it inherit the app's
 * Content-Security-Policy, which does not allow the OpenCollection renderer's
 * CDN. `useEntityDocsSession` mints the cookie that authenticates the frame's
 * GET, since an iframe `src` carries no Authorization header.
 *
 * Two layouts, selected by the `?view=full` query param:
 *  - default: embedded in the app chrome — the Backstage sidebar stays visible
 *    and a "Bruno" header sits on top (matching the `/bruno` page), with the
 *    iframe filling the remaining space. The header carries an "Open in new
 *    tab" action linking to `?view=full`.
 *  - `?view=full`: a fixed, full-viewport iframe that overlays all app chrome
 *    so only the docs show.
 */
export function BrunoDocsPage(): JSX.Element {
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const catalogApi = useApi(catalogApiRef);
  // Read the collection from the `:namespace`/`:name` path parameters bound to
  // the page's route ref (see extensions.tsx).
  const { namespace, name } = useRouteRefParams(brunoDocsPageRouteRef);

  const [entity, setEntity] = useState<Entity | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setEntity(undefined);
    setError(undefined);
    if (!namespace || !name) {
      setError('Missing collection namespace or name in the URL path.');
      return undefined;
    }
    catalogApi
      .getEntityByRef({ kind: 'Bruno', namespace, name })
      .then((found) => {
        if (cancelled) {
          return;
        }
        if (!found) {
          setError(`No Bruno collection named ${namespace}/${name}.`);
          return;
        }
        setEntity(found);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogApi, namespace, name]);

  const definitionYaml = entity && definition(entity);
  // Framed only once the entity is known to carry a document: the states below
  // stand in for the frame otherwise, and there is nothing to authenticate for
  // a frame that is never mounted.
  const { src, error: sessionError } = useEntityDocsSession(
    definitionYaml ? namespace : undefined,
    definitionYaml ? name : undefined
  );

  // The embedded iframe has no viewport-anchored ancestor to stretch into (the
  // app content area sizes to content), so measure its top offset and fill the
  // remaining viewport height. Recomputed on mount, when the iframe appears, and
  // on resize. The full-view layout is `position:fixed` and needs none of this.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | undefined>();
  useLayoutEffect(() => {
    const recompute = () => {
      const node = frameRef.current;
      if (!node) {
        return;
      }
      const top = node.getBoundingClientRect().top;
      setFrameHeight(Math.max(320, window.innerHeight - top));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [src]);

  // A resolved entity with no document to render is a real, explainable state
  // rather than a failure: the processor writes `spec.definition` a cycle after
  // the entity appears, and omits it entirely above `bruno.definition.maxBytes`.
  // Branching on the definition and NOT on `src` matters — `src` is only handed
  // out once the docs cookie exists, so it is undefined for the first frames
  // even when there is a document.
  let missing: string | undefined;
  if (entity && !definitionYaml) {
    missing
      = definitionOmittedReason(entity) === 'size'
        ? 'This collection\'s OpenCollection document exceeds the configured '
        + 'bruno.definition.maxBytes, so it was not stored on the entity and '
        + 'cannot be rendered.'
        : 'No API documentation has been generated for this collection yet.';
  }
  const message = error ?? missing ?? sessionError;

  // Whether to render the chrome-less, full-viewport layout. Read from the
  // live URL: this page is opened via a fresh navigation (new tab / link), so
  // there's no need to react to in-app query-param changes.
  const isFullView
    = new URLSearchParams(window.location.search).get(FULL_VIEW_PARAM)
      === FULL_VIEW_VALUE;

  // Chrome-less, full-viewport layout: the fixed iframe overlays the app
  // sidebar/header so only the docs show.
  if (isFullView) {
    if (message) {
      return <DocsMessage classes={classes} error={message} />;
    }
    if (!src) {
      return <DocsMessage classes={classes} />;
    }
    return (
      <iframe
        title="API Documentation"
        className={classes.frame}
        sandbox="allow-scripts allow-same-origin"
        src={src}
      />
    );
  }

  // Open this same docs page in a new browser tab, in the chrome-less
  // full-viewport layout. `pathname` already includes any app base path.
  const openInNewTab = () => {
    window.open(
      `${window.location.pathname}?${FULL_VIEW_PARAM}=${FULL_VIEW_VALUE}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  let body: JSX.Element;
  if (message) {
    body = <DocsMessage classes={classes} error={message} />;
  } else if (!src) {
    body = <DocsMessage classes={classes} />;
  } else {
    body = (
      <iframe
        ref={frameRef}
        title="API Documentation"
        className={classes.embeddedFrame}
        style={{ height: frameHeight }}
        sandbox="allow-scripts allow-same-origin"
        src={src}
      />
    );
  }

  // Default layout: rendered inside the app chrome. Reusing PageLayout gives the
  // exact "Bruno" header of the `/bruno` page (icon + title), with the "Open in
  // new tab" action right-aligned via `headerActions`. The Backstage sidebar
  // stays visible because nothing overlays it.
  return (
    <PageLayout
      title="Bruno"
      icon={<BrunoIcon fontSize="inherit" />}
      headerActions={[
        <Button
          key="open-in-new-tab"
          size="small"
          className={brandClasses.accentText}
          startIcon={<LaunchIcon />}
          onClick={openInNewTab}
        >
          Open in new tab
        </Button>
      ]}
    >
      {body}
    </PageLayout>
  );
}
