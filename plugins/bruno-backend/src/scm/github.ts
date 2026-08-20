import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import { joinPosix, normalizePathStyleUrl, originPlusSegments } from './normalize';
import { isCollectionFile } from './treeFilter';
import type {
  ParsedRepoUrl,
  ScmFileTree,
  ScmProvider,
  ScmUserTokenReadArgs
} from './types';

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

    /**
     * Composes the fully-qualified GitHub URL for a discovered collection root.
     * Joins the input URL's subpath with the root's prefix within that subtree,
     * and yields `https://<host>/<owner>/<repo>/tree/<ref>/<fullSubpath>`. When
     * both the input subpath and the root are empty, reduces to the plain repo
     * URL.
     */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      const u = new URL(normalizedRepoUrl);
      const { owner, repo, subpath: inputSubpath }
        = parseRepoUrl(normalizedRepoUrl);
      const fullSubpath = joinPosix(inputSubpath, rootPrefixWithinInput);
      if (fullSubpath === '') {
        return `${u.protocol}//${u.host}/${owner}/${repo}`;
      }
      return `${u.protocol}//${u.host}/${owner}/${repo}/tree/${ref}/${fullSubpath}`;
    },

    /** Total: never throws. */
    repoRootFromUrl(url) {
      return originPlusSegments(url, 2);
    },

    /**
     * No-op for GitHub alone: `readGithubIntegrationConfigs` always appends a
     * default `github.com` entry when the host configured none, which is why
     * public GitHub reads work with no `integrations` block at all. A GitHub
     * Enterprise host still needs its own entry, but then `byUrl` resolves it
     * and there is nothing to assert here.
     */
    assertConfigured() {},

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
      const octokit = new Octokit({ auth, baseUrl: apiBaseUrlFor(url) });
      const { data } = await octokit.repos.get({ owner, repo });
      return data.default_branch;
    },

    /**
     * Reads a private tree with the caller's own GitHub OAuth token via the
     * GitHub REST API.
     *
     * This predates the discovery that `GithubUrlReader.readTree` honours a
     * per-call `options.token` and is therefore redundant, but it is the path
     * that has been exercised against real private repos, so it stays until
     * MSCM-P2 retires it deliberately. Its cost is a recursive tree call plus
     * one blob call per file — the worst available pattern for rate limits, and
     * another reason P2 should land. The token reaches only the Octokit client:
     * never logged, returned, or stored.
     */
    async readTreeWithUserToken(
      args: ScmUserTokenReadArgs
    ): Promise<ScmFileTree> {
      const { url, userToken, logger } = args;
      const { owner, repo, ref: parsedRef, subpath } = parseRepoUrl(url);
      const octokit = new Octokit({
        auth: userToken,
        baseUrl: apiBaseUrlFor(url)
      });

      let ref = parsedRef;
      if (!ref) {
        const { data } = await octokit.repos.get({ owner, repo });
        ref = data.default_branch;
      }

      const { data: tree } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: 'true'
      });

      if (tree.truncated) {
        logger.warn(
          `GitHub tree for ${owner}/${repo} was truncated; some files may be missing.`
        );
      }

      const prefix = subpath === '' ? '' : `${subpath}/`;
      const files: ScmFileTree = new Map();
      for (const entry of tree.tree) {
        if (entry.type !== 'blob' || !entry.path || !entry.sha) {
          continue;
        }
        if (prefix !== '' && !entry.path.startsWith(prefix)) {
          continue;
        }
        const rel = entry.path.slice(prefix.length);
        if (!isCollectionFile(rel)) {
          continue;
        }
        const { data: blob } = await octokit.git.getBlob({
          owner,
          repo,
          file_sha: entry.sha
        });
        files.set(rel, Buffer.from(blob.content, 'base64').toString('utf8'));
      }
      return files;
    }
  };
}
