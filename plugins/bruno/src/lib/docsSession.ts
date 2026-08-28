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

/**
 * Authenticates and resolves the embeddable OpenCollection docs URL for a
 * collection.
 *
 * The backend docs endpoint (`GET /collections/:id/docs`) is reached by an
 * iframe `src`, which carries no `Authorization` header — so the session is
 * carried by the limited-access cookie minted here, and the URL is only handed
 * out once that cookie exists. The cookie is re-minted shortly before it
 * expires so a tab left open overnight keeps rendering; a failed refresh is
 * surfaced via `errorApi` but is not fatal, since the current cookie stays
 * valid until it lapses and a reload re-mints.
 *
 * The docs bundle's light/dark palette follows the active Backstage theme, so
 * the returned `src` changes when the user flips theme.
 */
export function useDocsSession(collectionId: string | undefined): DocsSession {
  const brunoApi = useApi(brunoApiRef);
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const errorApi = useApi(errorApiRef);
  const theme = useTheme();
  const themeMode: 'light' | 'dark'
    = theme.palette.type === 'dark' ? 'dark' : 'light';

  const [src, setSrc] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setSrc(undefined);
    setError(undefined);
    if (!collectionId) {
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

  return { src, error };
}
