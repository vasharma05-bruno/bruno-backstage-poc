import type { ScmIntegrationRegistry } from '@backstage/integration';
import { createGithubPrAdapter } from './github';
import { createGitlabPrAdapter } from './gitlab';
import type { PrAdapter } from './types';

/**
 * Which {@link PrAdapter} serves a URL, decided by the host app's configured
 * `scmIntegrationsApi` rather than by this plugin's own hostname guessing.
 *
 * Dispatch is on `integrations.byUrl(url)?.type`, which is how
 * `plugins/bruno-backend/src/scm/index.ts` picks its reader — same key, same
 * strings, so a host configured for one side is configured for the other. The
 * backend falls back to a hostname guess when no integration matches, because
 * its job there is to produce the right ERROR; this one must not, because its
 * answer authorises a write: a GitLab-shaped guess at an unconfigured host
 * would send the user's repo-write token at a server nobody declared.
 *
 * WHY BITBUCKET CLOUD IS NOT HERE. It is not a missing adapter — the Cloud API
 * has all three pieces (`GET /2.0/repositories/{ws}/{repo}/src/{ref}/{path}`,
 * a form-encoded `POST …/src` that takes `parents` as the concurrency guard,
 * and `POST …/pullrequests`). What is missing is the SCOPE.
 * `packages/app/src/modules/auth/scmAuth.ts` maps Bitbucket's `repoWrite` to
 * `[]` deliberately, and even `ScmAuth`'s stock Bitbucket mapping is
 * `pullrequest:write snippet:write issue:write` — none of which is
 * `repository:write`, the one a commit needs. Enabling it therefore means
 * widening what the app asks every Bitbucket user to consent to, and having
 * the OAuth consumer grant it; that is an app-side decision, not this module's,
 * so a Bitbucket descriptor takes the copy-the-YAML fallback in
 * `components/PartOfPr/DescriptorAdvice.tsx` until it is made.
 */
const ADAPTERS: Record<
  string,
  (opts: { token: string; apiBaseUrl?: string }) => PrAdapter
> = {
  github: createGithubPrAdapter,
  gitlab: createGitlabPrAdapter
};

/**
 * Whether a pull request can be opened against `url` at all — the question the
 * advice and the add-collection dialog ask before they offer the action, and
 * before any token has been requested.
 */
export function prSupported(
  url: string,
  integrations: ScmIntegrationRegistry | undefined
): boolean {
  const type = integrations?.byUrl(url)?.type;
  return !!type && type in ADAPTERS;
}

/**
 * The adapter for `url`, ready to write, or `undefined` for a host no adapter
 * serves.
 *
 * `apiBaseUrl` is read here rather than by each caller so that the GitHub
 * Enterprise threading cannot be forgotten at one call site and not another:
 * without it a GHE flow asks for a token against the user's own host and then
 * sends every call at the public API, 404ing on a repository that exists.
 */
export function prAdapterForUrl(opts: {
  url: string;
  /** The user's SCM token, from `scmAuthApi` with `repoWrite`. */
  token: string;
  integrations: ScmIntegrationRegistry | undefined;
}): PrAdapter | undefined {
  const { url, token, integrations } = opts;
  const type = integrations?.byUrl(url)?.type;
  const create = type ? ADAPTERS[type] : undefined;
  if (!create) {
    return undefined;
  }
  const apiBaseUrl
    = type === 'gitlab'
      ? integrations?.gitlab.byUrl(url)?.config.apiBaseUrl
      : integrations?.github.byUrl(url)?.config.apiBaseUrl;
  return create({ token, apiBaseUrl });
}
