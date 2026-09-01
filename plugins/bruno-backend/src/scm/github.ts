import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import {
  composePathStyleCollectionUrl,
  normalizePathStyleUrl,
  originPlusSegments
} from './normalize';
import type { ParsedRepoUrl, ScmProvider } from './types';

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

  const apiBaseUrlFor = (url: string): string =>
    integrations.github.byUrl(url)?.config.apiBaseUrl ?? 'https://api.github.com';

  return {
    type: 'github',

    label: 'GitHub',

    normalizeUrl: normalizePathStyleUrl,

    parseRepoUrl,

    /** `https://<host>/<owner>/<repo>/tree/<ref>/<subpath>` for a discovered
     *  root, or the bare repo URL when the joined subpath is empty. */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      return composePathStyleCollectionUrl({
        normalizedRepoUrl,
        rootPrefixWithinInput,
        ref,
        parseRepoUrl,
        view: 'tree',
        provider: 'GitHub'
      });
    },

    /** Total: never throws. */
    repoRootFromUrl(url) {
      return originPlusSegments(url, 2);
    },

    /**
     * No-op. `readGithubIntegrationConfigs` always appends a default
     * `github.com` entry when the host configured none, which is why public
     * GitHub reads work with no `integrations` block at all.
     *
     * Deliberately not extended to GitHub Enterprise: an unconfigured GHE host
     * still resolves to this adapter via the default `github.com` entry's
     * absence of host matching, and asserting here would newly reject URLs the
     * plugin accepts today. GHE without an entry fails at read time, as before.
     */
    assertConfigured() {},

    /**
     * Resolves the repo's default branch via Octokit, with the host credential —
     * a PAT or a GitHub App installation token, whichever `integrations.github`
     * configured — and nothing else.
     *
     * A host credential that merely EXISTS is not necessarily authorized: a PAT
     * scoped to one org 404s on a repo the caller can see perfectly well. There
     * used to be a retry with the caller's own OAuth token for exactly that
     * case; it is gone on purpose (see `scm/types.ts`), so such a repo now fails
     * here with GitHub's own error rather than succeeding for some users and not
     * others. The credential is never logged.
     */
    async resolveDefaultBranch(url) {
      const { owner, repo } = parseRepoUrl(url);
      let hostToken: string | undefined;
      try {
        // `|| undefined` so a blank token from a tokenless (anonymous)
        // integration is treated as "no host credential" rather than as one.
        hostToken
          = (await githubCredentials.getCredentials({ url })).token || undefined;
      } catch {
        // No host credential for this repo (e.g. a GitHub App not installed
        // there). Fall through and try anonymously — which is all a public repo
        // needs, and the honest failure for a private one.
      }
      const octokit = new Octokit({
        auth: hostToken,
        baseUrl: apiBaseUrlFor(url)
      });
      const { data } = await octokit.repos.get({ owner, repo });
      return data.default_branch;
    }
  };
}
