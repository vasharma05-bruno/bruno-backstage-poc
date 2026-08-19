import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { makeStyles, useTheme } from '@material-ui/core/styles';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import Http from '@material-ui/icons/Http';
import LaunchIcon from '@material-ui/icons/Launch';
import { Progress } from '@backstage/core-components';
import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  discoveryApiRef,
  errorApiRef,
  fetchApiRef,
  useApi
} from '@backstage/core-plugin-api';
import { PageLayout, useRouteRefParams } from '@backstage/frontend-plugin-api';
import { brunoApiRef } from '../../api/BrunoApi';
import { brunoDocsPageRouteRef } from '../../extensions';

// Query param that switches the page to the chrome-less, full-viewport layout
// (no sidebar / no header — just the docs iframe filling the whole window). The
// "Open in new tab" action links to `?view=full`.
const FULL_VIEW_PARAM = 'view';
const FULL_VIEW_VALUE = 'full';

// Re-mint the docs cookie this many ms before it expires, so a long-lived tab
// never lets the iframe's session lapse. Floored so a short-lived cookie still
// yields a sane (non-negative, not-too-eager) refresh delay.
const COOKIE_REFRESH_MARGIN_MS = 60_000;
const MIN_COOKIE_REFRESH_MS = 60_000;

/**
 * Mints (or refreshes) the Backstage limited-access cookie for the `bruno`
 * backend by hitting its auto-registered `/.backstage/auth/v1/cookie` endpoint.
 * The request is authenticated by the bearer token `fetchApi` attaches;
 * `credentials: 'include'` makes the browser store the returned `Set-Cookie`.
 * That cookie is what authenticates the iframe's `src` GET (which carries no
 * Authorization header). Returns the cookie's expiry so the caller can schedule
 * a refresh.
 */
async function mintDocsCookie(
  discoveryApi: DiscoveryApi,
  fetchApi: FetchApi
): Promise<Date> {
  const base = await discoveryApi.getBaseUrl('bruno');
  const res = await fetchApi.fetch(`${base}/.backstage/auth/v1/cookie`, {
    credentials: 'include'
  });
  if (!res.ok) {
    throw new Error(
      `Could not authenticate the docs session (${res.status}). `
      + 'Please reload the page.'
    );
  }
  const { expiresAt } = (await res.json()) as { expiresAt: string };
  return new Date(expiresAt);
}

const useStyles = makeStyles((theme) => ({
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
  message: {
    padding: theme.spacing(4)
  }
}));

/**
 * Standalone page rendering a Bruno collection's OpenCollection API docs at
 * `/bruno/docs/<collectionId>`, opened in a new tab (e.g. from the entity
 * "API Docs" launcher).
 *
 * Two layouts, selected by the `?view=full` query param:
 *  - default: embedded in the app chrome — the Backstage sidebar stays visible
 *    and a "Bruno" header sits on top (matching the `/bruno` page), with the
 *    iframe filling the remaining space. The header carries an "Open in new
 *    tab" action linking to `?view=full`.
 *  - `?view=full`: a fixed, full-viewport iframe that overlays all app chrome
 *    so only the docs show.
 *
 * The iframe embeds the backend-served docs page (`GET /collections/:id/docs`)
 * by `src` — the same document the entity "API Docs" tab uses — so the
 * OpenCollection bundle gets a real origin for its `sessionStorage`/HashRouter.
 */
export function BrunoDocsPage(): JSX.Element {
  const classes = useStyles();
  const theme = useTheme();
  const brunoApi = useApi(brunoApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const errorApi = useApi(errorApiRef);
  // Read the collection id from the `:collectionId` path parameter bound to
  // the page's route ref (see extensions.tsx).
  const { collectionId } = useRouteRefParams(brunoDocsPageRouteRef);
  const themeMode: 'light' | 'dark'
    = theme.palette.type === 'dark' ? 'dark' : 'light';

  const [src, setSrc] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

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

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setSrc(undefined);
    setError(undefined);
    if (!collectionId) {
      setError('Missing collection id in the URL path.');
      return undefined;
    }

    // Re-mint the cookie shortly before it expires so a long-lived docs tab
    // keeps its iframe session authenticated. A failed refresh is surfaced
    // (errorApi) but not fatal — the current cookie is still valid until it
    // lapses, at which point a reload re-mints.
    const scheduleRefresh = (expiresAt: Date) => {
      const delay = Math.max(
        MIN_COOKIE_REFRESH_MS,
        expiresAt.getTime() - Date.now() - COOKIE_REFRESH_MARGIN_MS
      );
      refreshTimer = setTimeout(() => {
        mintDocsCookie(discoveryApi, fetchApi)
          .then((next) => {
            if (!cancelled) {
              scheduleRefresh(next);
            }
          })
          .catch((e) => {
            if (!cancelled) {
              errorApi.post(e instanceof Error ? e : new Error(String(e)));
            }
          });
      }, delay);
    };

    // Mint the cookie BEFORE pointing the iframe at the docs URL: the iframe's
    // `src` GET carries no Authorization header and is authenticated solely by
    // this cookie, so it must exist first.
    mintDocsCookie(discoveryApi, fetchApi)
      .then(async (expiresAt) => {
        if (cancelled) {
          return;
        }
        scheduleRefresh(expiresAt);
        const url = await brunoApi.getDocsUrl(collectionId, themeMode);
        if (!cancelled) {
          setSrc(url);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });

    return () => {
      cancelled = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    };
  }, [brunoApi, discoveryApi, fetchApi, errorApi, collectionId, themeMode]);

  // Whether to render the chrome-less, full-viewport layout. Read from the
  // live URL: this page is opened via a fresh navigation (new tab / link), so
  // there's no need to react to in-app query-param changes.
  const isFullView
    = new URLSearchParams(window.location.search).get(FULL_VIEW_PARAM)
      === FULL_VIEW_VALUE;

  // Chrome-less, full-viewport layout: the fixed iframe overlays the app
  // sidebar/header so only the docs show.
  if (isFullView) {
    if (error) {
      return (
        <Box className={classes.message}>
          <Typography variant="body1" color="error">
            {error}
          </Typography>
        </Box>
      );
    }
    if (!src) {
      return (
        <Box className={classes.message}>
          <Progress />
        </Box>
      );
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
  if (error) {
    body = (
      <Box className={classes.message}>
        <Typography variant="body1" color="error">
          {error}
        </Typography>
      </Box>
    );
  } else if (!src) {
    body = (
      <Box className={classes.message}>
        <Progress />
      </Box>
    );
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
      icon={<Http fontSize="inherit" />}
      headerActions={[
        <Button
          key="open-in-new-tab"
          size="small"
          color="primary"
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
