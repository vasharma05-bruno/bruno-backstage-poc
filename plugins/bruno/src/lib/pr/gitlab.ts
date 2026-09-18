import type { PrAdapter, PrDescriptor, PrFile, PrRepo, PrRequest } from './types';

/**
 * The GitLab side of {@link PrAdapter}, over `fetch` rather than a client
 * library: four endpoints, no pagination, no shapes worth a dependency.
 *
 * Three things about the GitLab API shape this leans on, each verified against
 * the REST documentation:
 *
 *  - `:id` may be the URL-ENCODED `path_with_namespace`, so `group/sub/proj`
 *    addresses a project with no numeric-id lookup first.
 *  - a commit with `start_branch` CREATES the branch as part of the commit, so
 *    there is no separate create-branch call and no half-made branch to clean
 *    up when the commit is rejected.
 *  - `last_commit_id` on an `update` action is the concurrency guard: GitLab
 *    rejects the commit when the file has moved since it was read. It is
 *    omitted on `create`, where the action itself fails if the path is taken.
 *
 * Scopes need no app-side change. `ScmAuth.forGitlab`'s stock `repoWrite`
 * mapping is `['write_repository', 'api']`
 * (`node_modules/@backstage/integration-react/dist/api/ScmAuth.esm.js`), and
 * `api` is what these four endpoints want — `write_repository` alone covers
 * git-over-HTTP, not the REST API.
 */

/** The view segment GitLab puts after `/-/` when showing a file. */
const VIEW_SEGMENTS = ['blob', 'raw', 'tree'];

/** `group/sub/proj` → `group%2Fsub%2Fproj`, GitLab's namespaced project id. */
const projectId = (repo: PrRepo): string =>
  encodeURIComponent(`${repo.project}/${repo.repo}`);

/** Base64-encodes UTF-8 text, so a non-ASCII descriptor survives the commit. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Base64-decodes GitLab's file content, which is UTF-8 and newline-wrapped. */
function decodeBase64(content: string): string {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function createGitlabPrAdapter(opts: {
  /** The user's SCM token. Held in this closure and put in no other place. */
  token: string;
  /**
   * The matched integration's `apiBaseUrl` — `https://gitlab.com/api/v4`, and
   * the self-hosted equivalent. Backstage fills it in for every configured
   * GitLab integration, so it is undefined only when none matches, where the
   * descriptor's own origin is the best guess available.
   */
  apiBaseUrl?: string;
  /**
   * Injected so the transport tests can assert the exact request bodies. The
   * global is the default, and is what the app uses.
   */
  fetch?: typeof globalThis.fetch;
}): PrAdapter {
  const doFetch = opts.fetch ?? globalThis.fetch;

  const apiUrl = (repo: PrRepo, suffix: string): string => {
    const base = opts.apiBaseUrl ?? `${repo.host}/api/v4`;
    return `${base.replace(/\/$/, '')}/projects/${projectId(repo)}${suffix}`;
  };

  /**
   * One API call. Returns `undefined` for a 404 so {@link PrAdapter.readFile}
   * can distinguish "nothing there" from "cannot see it"; every other non-2xx
   * throws with GitLab's own message, which is the sentence the dialog shows.
   */
  const call = async (
    url: string,
    init?: { method: string; body: unknown }
  ): Promise<Record<string, unknown> | undefined> => {
    const response = await doFetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(init ? { 'Content-Type': 'application/json' } : {})
      },
      ...(init ? { body: JSON.stringify(init.body) } : {})
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `GitLab answered ${response.status} for ${init?.method ?? 'GET'} `
        + `${new URL(url).pathname}${detail ? `: ${detail}` : ''}`
      );
    }
    return (await response.json()) as Record<string, unknown>;
  };

  /** The same call, where a 404 is as much a failure as any other status. */
  const requireBody = async (
    url: string,
    init?: { method: string; body: unknown }
  ): Promise<Record<string, unknown>> => {
    const body = await call(url, init);
    if (!body) {
      throw new Error(
        `GitLab answered 404 for ${init?.method ?? 'GET'} `
        + `${new URL(url).pathname}. The project may not exist, or this account `
        + 'may not be able to see it.'
      );
    }
    return body;
  };

  const parseRepoUrl = (repoUrl: string): PrRepo | undefined => {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      return undefined;
    }
    // Everything before GitLab's `/-/` separator is the project path; without a
    // separator the whole path is. Counting segments would truncate it —
    // namespaces nest arbitrarily deep, so `group/subgroup/project` is
    // indistinguishable BY SHAPE from a two-segment repo plus a path segment.
    const segments = url.pathname.split('/').filter(Boolean);
    const dash = segments.indexOf('-');
    const project = dash === -1 ? segments : segments.slice(0, dash);
    if (project.length < 2) {
      return undefined;
    }
    return {
      host: url.origin,
      project: project.slice(0, -1).join('/'),
      repo: project[project.length - 1].replace(/\.git$/, '')
    };
  };

  return {
    parseRepoUrl,

    /**
     * `<namespace…>/<project>/-/<view>/<ref>/<path…>` → its parts.
     *
     * The `/-/` separator is REQUIRED, and its absence is why a legacy
     * `<namespace>/<project>/blob/<ref>/<path>` URL parses as `undefined` here
     * rather than by a fixed offset: without the separator a subgroup named
     * `blob` and a view segment are the same string in the same position, and a
     * project silently resolved one level up is worse than no pull request.
     * GitLab's own UI, and `GitlabUrlReader`, both emit the separator form.
     */
    parseDescriptorUrl: (descriptorUrl: string): PrDescriptor | undefined => {
      const repo = parseRepoUrl(descriptorUrl);
      if (!repo) {
        return undefined;
      }
      const segments = new URL(descriptorUrl).pathname
        .split('/')
        .filter(Boolean);
      const dash = segments.indexOf('-');
      if (dash === -1 || !VIEW_SEGMENTS.includes(segments[dash + 1] ?? '')) {
        return undefined;
      }
      const path = segments.slice(dash + 3).join('/');
      return path ? { ...repo, path } : undefined;
    },

    repoUrl: (repo: PrRepo): string =>
      `${repo.host}/${repo.project}/${repo.repo}`,

    defaultBranch: async (repo: PrRepo): Promise<string> => {
      const project = await requireBody(apiUrl(repo, ''));
      return String(project.default_branch);
    },

    readFile: async (
      repo: PrRepo,
      path: string,
      ref: string
    ): Promise<PrFile | undefined> => {
      const file = await call(
        apiUrl(
          repo,
          `/repository/files/${encodeURIComponent(path)}`
          + `?ref=${encodeURIComponent(ref)}`
        )
      );
      if (!file) {
        return undefined;
      }
      return {
        content: decodeBase64(String(file.content)),
        concurrencyToken: String(file.last_commit_id)
      };
    },

    openPullRequest: async (request: PrRequest): Promise<{ link: string }> => {
      await requireBody(apiUrl(request.repo, '/repository/commits'), {
        method: 'POST',
        body: {
          branch: request.branch,
          // Creates the branch as part of the commit. Dropping this would
          // commit straight onto `baseBranch` — which is the branch the pull
          // request is meant to be reviewed against.
          start_branch: request.baseBranch,
          commit_message: request.commitMessage,
          actions: [
            {
              action: request.concurrencyToken ? 'update' : 'create',
              file_path: request.path,
              content: encodeBase64(request.content),
              encoding: 'base64',
              // Only meaningful on `update`; on `create` the action itself
              // fails when the path is taken.
              ...(request.concurrencyToken
                ? { last_commit_id: request.concurrencyToken }
                : {})
            }
          ]
        }
      });

      const mr = await requireBody(apiUrl(request.repo, '/merge_requests'), {
        method: 'POST',
        body: {
          source_branch: request.branch,
          target_branch: request.baseBranch,
          title: request.title,
          description: request.body
        }
      });
      return { link: String(mr.web_url) };
    }
  };
}
