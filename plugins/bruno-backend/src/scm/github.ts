import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import {
  composePathStyleCollectionUrl,
  normalizePathStyleUrl,
  originPlusSegments,
  safeHost
} from './normalize';
import { conditionalGetJson } from './treeIdentity';
import type { ParsedRepoUrl, ScmProvider } from './types';

/**
 * Headers for a raw GitHub API call, carrying the same host credential the
 * UrlReader uses — a PAT or a GitHub App installation token, whichever
 * `integrations.github` configured — and nothing else.
 *
 * Falls back to ANONYMOUS when there is no credential for this repo, which is
 * all a public repo needs and the honest failure for a private one: the caller
 * downgrades a failure to "could not tell" and the subsequent `readTree`
 * produces the error that actually names the problem. The credential is never
 * logged.
 */
async function githubApiHeaders(
  githubCredentials: GithubCredentialsProvider,
  url: string
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28'
  };
  try {
    const credentials = await githubCredentials.getCredentials({ url });
    // `headers` is preferred over `token`: it is what the provider fills in for
    // a GitHub App, and it already carries the right scheme for each type.
    if (credentials.headers) {
      return { ...base, ...credentials.headers };
    }
    if (credentials.token) {
      return { ...base, authorization: `Bearer ${credentials.token}` };
    }
  } catch {
    // No host credential for this repo (e.g. a GitHub App not installed there).
  }
  return base;
}

/**
 * `parseRepoUrl` lifts its subpath out of `URL.pathname`, which is still
 * percent-encoded (`collections/Orders%20API`); the API wants the decoded path
 * and `searchParams` re-encodes it.
 *
 * Returns `''` on an undecodable path — a stray `%` that is not a valid escape.
 * That drops the path scoping, which is SAFE: an unscoped identity tracks the
 * whole repo, so it over-invalidates (a push anywhere costs one read) but can
 * never under-invalidate.
 */
function decodeSubpath(subpath: string): string {
  try {
    return subpath.split('/').map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
}

/** The `sha` of the first entry of a `GET /commits` response. */
function firstCommitSha(body: unknown): string | undefined {
  if (!Array.isArray(body)) {
    return undefined;
  }
  const sha = (body[0] as { sha?: unknown } | undefined)?.sha;
  return typeof sha === 'string' && sha ? sha : undefined;
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

  /**
   * The API origin for `url`'s host — and NEVER a default.
   *
   * `?? 'https://api.github.com'` stood here, and it was worse than latent. A
   * GitHub Enterprise entry may legitimately omit `apiBaseUrl`
   * (`GithubIntegrationConfig.apiBaseUrl` is optional, and
   * `readGithubIntegrationConfig` only deduces it for `github.com`), so a
   * configured GHE host with no `apiBaseUrl` sent its `owner/repo` query — and
   * its `If-None-Match` — to PUBLIC GitHub, which answers 404 for a private
   * enterprise repo and turns the whole cheap-revalidation tier into a
   * permanent miss. The unmatched-host case is the same mistake pointed
   * outwards: a foreign host's repo path leaking to api.github.com.
   *
   * Throwing is safe on both call paths. `checkTreeIdentity`'s caller
   * (`manifestProbe`'s `checkIdentity`) catches anything this tier throws and
   * falls back to a full read, so a misconfigured host degrades to the
   * behaviour it had before the tier existed. `resolveDefaultBranch` propagates
   * it, which is right: that read was going to fail anyway, and this error
   * names the missing key instead of reporting someone else's 404.
   */
  const apiBaseUrlFor = (url: string): string => {
    const apiBaseUrl = integrations.github.byUrl(url)?.config.apiBaseUrl;
    if (!apiBaseUrl) {
      throw new Error(
        `No GitHub API base URL is configured for ${safeHost(url)}. Add an `
        + '`integrations.github` entry for that host with an `apiBaseUrl` '
        + '(e.g. https://ghe.example.com/api/v3).'
      );
    }
    return apiBaseUrl;
  };

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
     * A conditional `GET /repos/{owner}/{repo}/commits` — the free path.
     *
     * Two properties do the work. An AUTHENTICATED 304 costs no primary
     * rate-limit quota (measured — see `treeIdentity.ts`), so replaying the
     * stored `If-None-Match` is free for a collection nobody has pushed to; with
     * no host credential it costs one anonymous call instead, which is still no
     * worse than the read it replaces. And `path` scopes the answer to the
     * collection's own subfolder, so a push elsewhere in a shared repo does not
     * invalidate it — a sharper question than `readTree`'s etag can ask, since
     * that compares the whole repo's commit sha.
     *
     * Scoping to `path` is sound because `readTree` is called on the collection
     * URL: the reader strips the archive root AND the subpath, so nothing above
     * the subpath can reach the parsed collection.
     *
     * `per_page=1` because only the newest commit matters. Without a cached
     * etag this spends one call and can only answer `changed` — that is the
     * once-per-cache-entry cost of seeding the identity, and the caller stores
     * the result even when the follow-up read reports nothing moved, so it is
     * paid once rather than every cycle.
     */
    async checkTreeIdentity({ url, cached }) {
      const { owner, repo, ref, subpath } = parseRepoUrl(url);

      // GitHub owner/repo names admit only `[A-Za-z0-9._-]`, so the segments
      // `parseRepoUrl` lifted out of `URL.pathname` carry no escapes to undo.
      const endpoint = new URL(
        `${apiBaseUrlFor(url)}/repos/${owner}/${repo}/commits`
      );
      endpoint.searchParams.set('per_page', '1');
      if (ref) {
        endpoint.searchParams.set('sha', ref);
      }
      const scopedPath = decodeSubpath(subpath);
      if (scopedPath) {
        endpoint.searchParams.set('path', scopedPath);
      }

      const result = await conditionalGetJson({
        url: endpoint.toString(),
        headers: await githubApiHeaders(githubCredentials, url),
        ifNoneMatch: cached?.httpEtag
      });

      if (result.kind === 'not-modified') {
        return { status: 'unchanged' };
      }
      if (result.kind === 'failed') {
        return { status: 'unknown' };
      }

      const commit = firstCommitSha(result.body);
      if (!commit) {
        // An empty array: no commit touches that path, so the subpath does not
        // exist on this ref (or the repo is empty). Not our error to report —
        // defer to `readTree`, which fails with a message naming the URL.
        return { status: 'unknown' };
      }
      // Belt and braces for a host that rotates an etag without changing
      // content: the sha is the fact, the etag is only the cheap way to ask.
      if (cached?.commit === commit) {
        return { status: 'unchanged' };
      }
      return {
        status: 'changed',
        identity: { httpEtag: result.httpEtag, commit }
      };
    },

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
