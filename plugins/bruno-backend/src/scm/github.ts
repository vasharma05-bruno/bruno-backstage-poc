import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import type { ParsedRepoUrl, ScmProvider } from './types';

/**
 * Normalizes a GitHub collection URL to a stable identity. Lower-cases the
 * host, drops query/hash, collapses duplicate slashes and a single trailing
 * slash. `/tree/<branch>/<subpath>` is preserved (distinct subpaths are
 * distinct collections).
 *
 * Exported standalone so `collectionIdFromUrl` — a module-level function with
 * no access to the registry — can keep normalizing GitHub-shaped URLs.
 */
export function githubNormalizeUrl(url: string): string {
  const u = new URL(url.trim());
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  u.search = '';
  let normalizedPath = u.pathname.replace(/\/{2,}/g, '/');
  if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  return `${u.protocol}//${u.host}${normalizedPath}`;
}

// Duplicated from collectionService.ts so nothing under `scm/` imports from
// `service/` — that edge would be a cycle.
function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/** Parses `owner/repo` and an optional `/tree/<ref>/<subpath>` from a URL. */
function parseRepoUrl(url: string): ParsedRepoUrl {
  const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new Error(`Unsupported GitHub URL: ${url}`);
  }
  if (segments[2] === 'tree' && segments[3]) {
    return {
      owner,
      repo,
      ref: segments[3],
      subpath: segments.slice(4).join('/')
    };
  }
  return { owner, repo, subpath: '' };
}

export function createGithubScmProvider(options: {
  integrations: ScmIntegrationRegistry;
  /**
   * Resolves GitHub credentials the same way the UrlReader does, so the host
   * may configure either a PAT (`integrations.github.token`) or a GitHub App
   * (`integrations.github.apps`) — the provider yields a usable token for both.
   */
  githubCredentials: GithubCredentialsProvider;
}): ScmProvider {
  const { integrations, githubCredentials } = options;

  return {
    type: 'github',

    normalizeUrl: githubNormalizeUrl,

    parseRepoUrl,

    /**
     * Composes the fully-qualified GitHub URL for a discovered collection root.
     * Joins the input URL's subpath with the root's prefix within that subtree,
     * and yields `https://<host>/<owner>/<repo>/tree/<ref>/<fullSubpath>`. When
     * both the input subpath and the root are empty, reduces to the plain repo
     * URL.
     */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      const u = new URL(normalizedRepoUrl);
      const { subpath: inputSubpath } = parseRepoUrl(normalizedRepoUrl);
      const fullSubpath = joinPosix(inputSubpath, rootPrefixWithinInput);
      const segments = u.pathname.split('/').filter((s) => s !== '');
      const owner = segments[0];
      const repo = segments[1];
      if (fullSubpath === '') {
        return `${u.protocol}//${u.host}/${owner}/${repo}`;
      }
      return `${u.protocol}//${u.host}/${owner}/${repo}/tree/${ref}/${fullSubpath}`;
    },

    /** Total: never throws. Mirrors `repoRootFromCollectionUrl` in
     *  plugins/bruno/src/lib/githubUrl.ts — keep both in step (P3 unifies them). */
    repoRootFromUrl(url) {
      try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length < 2) {
          return url;
        }
        return `${u.origin}/${seg[0]}/${seg[1]}`;
      } catch {
        return url;
      }
    },

    /**
     * Resolves the repo's default branch via Octokit. The client is built with
     * the host credential resolved via the GitHub credentials provider (a PAT
     * or a GitHub App installation token, whichever the host configured),
     * falling back to the caller's user OAuth token, plus the integration's
     * `apiBaseUrl`. The token is never logged.
     */
    async resolveDefaultBranch(url, opts) {
      const { owner, repo } = parseRepoUrl(url);
      let auth: string | undefined;
      try {
        // `|| undefined` so a blank token from a tokenless (anonymous)
        // integration never shadows the user's OAuth token below — a private
        // repo must fall through to the caller's credentials, not resolve
        // anonymously and 404.
        auth = (await githubCredentials.getCredentials({ url })).token || undefined;
      } catch {
        // No host credential for this repo (e.g. a GitHub App not installed
        // there); fall back to the caller's user OAuth token below.
      }
      auth = auth ?? opts?.userToken;
      const apiBaseUrl
        = integrations.github.byUrl(url)?.config.apiBaseUrl ?? 'https://api.github.com';
      const octokit = new Octokit({ auth, baseUrl: apiBaseUrl });
      const { data } = await octokit.repos.get({ owner, repo });
      return data.default_branch;
    }
  };
}
