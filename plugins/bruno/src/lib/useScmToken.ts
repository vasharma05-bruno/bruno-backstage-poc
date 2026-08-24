import { useApiHolder } from '@backstage/core-plugin-api';
import { scmAuthApiRef } from '@backstage/integration-react';
import { scmProviderLabel } from './scmProviders';

/** Resolves the caller's SCM OAuth token for a given repository URL. */
export interface ScmTokenResolver {
  /**
   * Silent path: returns an existing token, or `undefined` when there is no
   * session, no registered auth API, or no provider for this URL. Never opens a
   * popup and never throws — safe as the first await of a non-gesture flow.
   */
  silent(url: string): Promise<string | undefined>;
  /**
   * Interactive path: opens the OAuth consent popup when needed. MUST be the
   * first await of a click handler, or the browser will treat the popup as
   * unsolicited and block it. Rejects when the user declines, when no auth API
   * is registered, or when the URL's provider has none.
   */
  interactive(url: string): Promise<string>;
}

/**
 * Per-provider SCM credentials for the connect / sync flows.
 *
 * Uses `scmAuthApiRef`, which routes to the right OAuth provider by URL host and
 * owns the per-provider scope mapping — GitHub `repo read:org read:user`, GitLab
 * `read_user read_api read_repository`, Bitbucket `account team pullrequest
 * snippet issue`. That mapping is why this hook takes a URL and not a scope
 * list: the plugin no longer hardcodes `['repo']`, which was GitHub's spelling
 * of "let me read a private repo" and meaningless to the other two.
 *
 * Resolved through `useApiHolder` rather than `useApi` on purpose. A host
 * Backstage app is not obliged to register `scmAuthApiRef`, and `useApi` throws
 * at RENDER time for a missing API — which would take the whole entity card down
 * for a host that simply has no SCM auth wired up. `holder.get` returns
 * `undefined` instead, so the card renders and degrades to public repositories
 * only. See docs/MULTI-SCM-PLAN.md MSCM-P3.
 */
export function useScmToken(): ScmTokenResolver {
  // Synchronous, so it does not consume the click gesture: the first await in
  // any handler below is still the `getCredentials` call itself.
  const scmAuth = useApiHolder().get(scmAuthApiRef);

  return {
    async silent(url: string): Promise<string | undefined> {
      if (!scmAuth) {
        return undefined;
      }
      try {
        const { token } = await scmAuth.getCredentials({ url, optional: true });
        return token || undefined;
      } catch {
        // No session, or no provider registered for this URL's host. Both mean
        // "read it anonymously and let the backend decide", not an error.
        return undefined;
      }
    },

    async interactive(url: string): Promise<string> {
      if (!scmAuth) {
        throw new Error(
          'No SCM authentication is configured in this Backstage app, so private '
          + 'repositories cannot be reached. Ask your Backstage administrator to '
          + 'register an SCM auth API.'
        );
      }
      const { token } = await scmAuth.getCredentials({ url });
      if (!token) {
        throw new Error(
          `${scmProviderLabel(url)} returned no access token.`
        );
      }
      return token;
    }
  };
}
