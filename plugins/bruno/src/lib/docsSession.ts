import { useEffect, useState } from 'react';
import { useTheme } from '@material-ui/core/styles';
import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  discoveryApiRef,
  errorApiRef,
  fetchApiRef,
  useApi
} from '@backstage/core-plugin-api';
import { brunoApiRef } from '../api/BrunoApi';

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

/** State of an authenticated OpenCollection docs embed. */
export interface DocsSession {
  /**
   * The docs URL to hand an iframe's `src`. Undefined until the session cookie
   * has been minted — pointing the iframe at the URL before then would make an
   * unauthenticated request.
   */
  src?: string;
  /** Set when the session could not be established; `src` stays undefined. */
  error?: string;
}

/** The docs light/dark palette, following the active Backstage theme. */
function useThemeMode(): 'light' | 'dark' {
  const theme = useTheme();
  return theme.palette.type === 'dark' ? 'dark' : 'light';
}

/**
 * Runs the cookie side of a docs session, independent of WHICH docs are being
 * embedded.
 *
 * The docs route (`/entities/:ns/:name/docs`) is reached by an iframe `src`,
 * which carries no `Authorization` header — so the session is carried by the
 * limited-access cookie minted here, and the URL may not be handed to a frame
 * before that cookie exists. The cookie is re-minted shortly before it expires
 * so a tab left open overnight keeps rendering; a failed refresh is surfaced via
 * `errorApi` but is not fatal, since the current cookie stays valid until it
 * lapses and a reload re-mints.
 *
 * `sessionKey` identifies what is being framed. It is undefined while the caller
 * has nothing to render yet (no entity ref), which keeps a cookie from being
 * minted for a frame that is never shown; changing it re-mints, so a frame
 * switched to a different collection gets a fresh attempt rather than
 * inheriting a failure from the last one.
 *
 * Kept as a separate hook from {@link useEntityDocsSession} — the cookie is a
 * per-backend session, not a per-document one, so the split is what lets a
 * second embed be added later without duplicating the refresh scheduling.
 */
function useDocsCookie(sessionKey: string | undefined): {
  ready: boolean;
  error?: string;
} {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const errorApi = useApi(errorApiRef);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setReady(false);
    setError(undefined);
    if (!sessionKey) {
      return undefined;
    }

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

    mintDocsCookie(discoveryApi, fetchApi)
      .then((expiresAt) => {
        if (cancelled) {
          return;
        }
        scheduleRefresh(expiresAt);
        setReady(true);
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
  }, [discoveryApi, fetchApi, errorApi, sessionKey]);

  return { ready, error };
}

/**
 * Authenticates and resolves the embeddable OpenCollection docs URL for a
 * `kind: Bruno` entity.
 *
 * The backend renders the document from the entity's own `spec.definition`, so
 * nothing but the entity ref travels over the wire. Serving it from the backend
 * — rather than assembling the same HTML in the browser and framing it as a
 * `blob:` URL — is what gives the document its own origin: a `blob:` document
 * inherits the APP's Content-Security-Policy, under which the OpenCollection
 * renderer's CDN is not allowed, so the bundle is blocked anywhere the app is
 * served by `plugin-app-backend` (i.e. everywhere but the CSP-less dev server).
 *
 * `src` stays undefined until the session cookie exists, and changes when the
 * user flips theme.
 */
export function useEntityDocsSession(
  namespace: string | undefined,
  name: string | undefined
): DocsSession {
  const brunoApi = useApi(brunoApiRef);
  const themeMode = useThemeMode();
  const { ready, error } = useDocsCookie(
    namespace && name ? `${namespace}/${name}` : undefined
  );

  const [src, setSrc] = useState<string | undefined>();
  const [urlError, setUrlError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    setUrlError(undefined);
    if (!ready || !namespace || !name) {
      return undefined;
    }
    brunoApi
      .getEntityDocsUrl(namespace, name, themeMode)
      .then((url) => {
        if (!cancelled) {
          setSrc(url);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setUrlError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, namespace, name, themeMode, ready]);

  return { src, error: error ?? urlError };
}
