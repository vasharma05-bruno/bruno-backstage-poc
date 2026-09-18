import { Octokit } from '@octokit/rest';
import type { PrAdapter, PrDescriptor, PrFile, PrRepo, PrRequest } from './types';

/**
 * The GitHub side of {@link PrAdapter}: the contents/git/pulls sequence that
 * `lib/unlinkPr.ts` and `lib/descriptorPr.ts` used to each hold a copy of.
 *
 * Lifted rather than rewritten. In particular `apiBaseUrl` is threaded exactly
 * as it was: Backstage fills it in for every configured GitHub integration —
 * `https://api.github.com` for github.com itself — so passing it is a no-op on
 * the public host and is what makes a GitHub Enterprise host work at all.
 * Without it the flow asks the user for a repo-write token against their own
 * host and then sends every call at the public API, 404ing on a repository that
 * exists.
 */

/**
 * The path segment GitHub puts between the repository and the ref. `blob` is
 * what the catalog stores, `raw` shows up in hand-written locations and `tree`
 * in copied browser URLs.
 */
const VIEW_SEGMENTS = ['blob', 'raw', 'tree'];

/** Base64-decodes GitHub's file content, which is UTF-8 and newline-wrapped. */
function decodeBase64(content: string): string {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Base64-encodes UTF-8 text for the GitHub contents API. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function createGithubPrAdapter(opts: {
  /** The user's SCM token. Held in this closure and put in no other place. */
  token: string;
  /** The matched integration's `apiBaseUrl`; see the module docblock. */
  apiBaseUrl?: string;
  /** Injected by the transport tests; Octokit's own default otherwise. */
  fetch?: typeof globalThis.fetch;
}): PrAdapter {
  const octokit = new Octokit({
    auth: opts.token,
    ...(opts.apiBaseUrl ? { baseUrl: opts.apiBaseUrl } : {}),
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {})
  });

  const parseRepoUrl = (repoUrl: string): PrRepo | undefined => {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return undefined;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return undefined;
    }
    return {
      host: url.origin,
      project: segments[0],
      repo: segments[1].replace(/\.git$/, '')
    };
  };

  return {
    parseRepoUrl,

    parseDescriptorUrl: (descriptorUrl: string): PrDescriptor | undefined => {
      const repo = parseRepoUrl(descriptorUrl);
      if (!repo) {
        return undefined;
      }
      // `<owner>/<repo>/<view>/<ref>/<path…>`.
      const segments = new URL(descriptorUrl).pathname.split('/').filter(Boolean);
      if (segments.length < 5 || !VIEW_SEGMENTS.includes(segments[2])) {
        return undefined;
      }
      return { ...repo, path: segments.slice(4).join('/') };
    },

    repoUrl: (repo: PrRepo): string =>
      `${repo.host}/${repo.project}/${repo.repo}`,

    defaultBranch: async (repo: PrRepo): Promise<string> => {
      const info = await octokit.repos.get({
        owner: repo.project,
        repo: repo.repo
      });
      return info.data.default_branch;
    },

    readFile: async (
      repo: PrRepo,
      path: string,
      ref: string
    ): Promise<PrFile | undefined> => {
      let data;
      try {
        ({ data } = await octokit.repos.getContent({
          owner: repo.project,
          repo: repo.repo,
          path,
          ref
        }));
      } catch (e) {
        // A 404 is the one failure that means "nothing is there". Anything else
        // — a 403 on a repository the token cannot read, a network failure — is
        // a real error, and reading it as an empty path would let the create
        // flow commit over a file it simply could not see.
        if ((e as { status?: number }).status === 404) {
          return undefined;
        }
        throw e;
      }
      // `getContent` answers a directory listing for a folder path and a
      // submodule / symlink shape for those; only the file shape has `content`.
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
        return undefined;
      }
      return {
        content: decodeBase64(data.content),
        concurrencyToken: data.sha
      };
    },

    openPullRequest: async (
      request: PrRequest
    ): Promise<{ link: string }> => {
      const owner = request.repo.project;
      const repo = request.repo.repo;

      const baseRef = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${request.baseBranch}`
      });
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${request.branch}`,
        sha: baseRef.data.object.sha
      });

      // WITH `sha` this updates, WITHOUT it this creates — the distinction
      // `catalogImportApi` gets wrong and the reason this module exists.
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: request.path,
        branch: request.branch,
        ...(request.concurrencyToken ? { sha: request.concurrencyToken } : {}),
        message: request.commitMessage,
        content: encodeBase64(request.content)
      });

      const pr = await octokit.pulls.create({
        owner,
        repo,
        head: request.branch,
        base: request.baseBranch,
        title: request.title,
        body: request.body
      });
      return { link: pr.data.html_url };
    }
  };
}
