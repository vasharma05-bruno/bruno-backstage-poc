import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import {
  assertSingleSegmentRef,
  joinPosix,
  normalizePathStyleUrl,
  originPlusSegments
} from './normalize';
import { selectCollectionFiles } from './treeFilter';
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
      assertSingleSegmentRef(ref, 'GitHub');
      return `${u.protocol}//${u.host}/${owner}/${repo}/tree/${ref}/${fullSubpath}`;
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
     * Resolves the repo's default branch via Octokit, in the same two tiers as
     * the tree read: the host credential first (a PAT or a GitHub App
     * installation token, whichever was configured), then a retry with the
     * caller's own OAuth token.
     *
     * The retry matters because a host credential that merely EXISTS is not
     * necessarily authorized — a PAT scoped to one org 404s on a repo the caller
     * can see perfectly well, and without the retry discovery would fail on a
     * repo `readTreeWithUserToken` could have read. Neither token is logged.
     */
    async resolveDefaultBranch(url, opts) {
      const { owner, repo } = parseRepoUrl(url);
      let hostToken: string | undefined;
      try {
        // `|| undefined` so a blank token from a tokenless (anonymous)
        // integration is treated as "no host credential" rather than as one.
        hostToken
          = (await githubCredentials.getCredentials({ url })).token || undefined;
      } catch {
        // No host credential for this repo (e.g. a GitHub App not installed
        // there); the caller's token below is the only option.
      }
      const readDefaultBranch = async (auth?: string): Promise<string> => {
        const octokit = new Octokit({ auth, baseUrl: apiBaseUrlFor(url) });
        const { data } = await octokit.repos.get({ owner, repo });
        return data.default_branch;
      };
      try {
        return await readDefaultBranch(hostToken);
      } catch (error) {
        if (!opts?.userToken || opts.userToken === hostToken) {
          throw error;
        }
        return await readDefaultBranch(opts.userToken);
      }
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

      // Two passes, not a per-entry predicate: admission is set-aware (a bare
      // `.yaml` only counts below an `opencollection.yaml`), so the whole
      // candidate set has to exist before anything can be classified. It also
      // means the expensive part — one blob call per file — runs only over the
      // files that survived selection, in the sorted order the parser needs for
      // a byte-stable definition.
      const prefix = subpath === '' ? '' : `${subpath}/`;
      const shaByRel = new Map<string, string>();
      for (const entry of tree.tree) {
        if (entry.type !== 'blob' || !entry.path || !entry.sha) {
          continue;
        }
        if (prefix !== '' && !entry.path.startsWith(prefix)) {
          continue;
        }
        shaByRel.set(entry.path.slice(prefix.length), entry.sha);
      }

      const files: ScmFileTree = new Map();
      for (const rel of selectCollectionFiles(shaByRel.keys())) {
        const { data: blob } = await octokit.git.getBlob({
          owner,
          repo,
          file_sha: shaByRel.get(rel)!
        });
        files.set(rel, Buffer.from(blob.content, 'base64').toString('utf8'));
      }
      return files;
    }
  };
}
