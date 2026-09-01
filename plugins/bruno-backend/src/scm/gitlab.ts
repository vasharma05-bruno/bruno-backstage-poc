import {
  getGitLabIntegrationRelativePath,
  getGitLabRequestOptions,
  type GitLabIntegration,
  type ScmIntegrationRegistry
} from '@backstage/integration';
import {
  composePathStyleCollectionUrl,
  normalizePathStyleUrl,
  safeHost
} from './normalize';
import { joinPosix } from '../posixPath';
import { readTreeViaUrlReader } from './readTree';
import type {
  ParsedRepoUrl,
  ScmFileTree,
  ScmProvider,
  ScmUserTokenReadArgs
} from './types';

/**
 * GitLab's web URL grammar:
 *
 *   https://<host>/<group>[/<subgroup>…]/<repo>                  (project root)
 *   https://<host>/<group>[/<subgroup>…]/<repo>/-/tree/<ref>/<path>
 *
 * Two differences from GitHub that the grammar has to carry. The namespace is
 * arbitrary-depth (nested subgroups), so `owner` may contain slashes and the
 * project is the LAST segment before the `/-/` separator. And the separator
 * itself is what delimits the project path from the in-repo view — without it,
 * every segment belongs to the project path, which is why a bare project URL
 * can never carry a subpath.
 *
 * Refs containing slashes (`release/1.x`) are ambiguous against the subpath and
 * resolve as a single segment, exactly as the GitHub adapter does with
 * `/tree/<ref>/`. `composeCollectionUrl` therefore refuses to build an identity
 * around one (`assertSingleSegmentRef`) rather than storing a URL that re-parses
 * differently — which matters most for a project-root paste, where the ref is
 * the repo's default branch and not the user's choice.
 */
function parseRepoUrl(url: string): ParsedRepoUrl {
  const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
  const dash = segments.indexOf('-');
  const projectSegments = dash === -1 ? segments : segments.slice(0, dash);

  if (projectSegments.length < 2) {
    throw new Error(
      `Unsupported GitLab URL: ${url} — expected at least <group>/<project>.`
    );
  }
  const repo = projectSegments[projectSegments.length - 1];
  const owner = projectSegments.slice(0, -1).join('/');

  if (dash === -1) {
    return { owner, repo, subpath: '' };
  }
  const view = segments[dash + 1];
  if (view !== 'tree') {
    throw new Error(
      `Unsupported GitLab URL: ${url} — expected a project or /-/tree/ URL, got /-/${
        view ?? ''
      }/.`
    );
  }
  const ref = segments[dash + 2];
  if (!ref) {
    // `/-/tree` with no ref names no revision; treat it as the project root.
    return { owner, repo, subpath: '' };
  }
  return { owner, repo, ref, subpath: segments.slice(dash + 3).join('/') };
}

export function createGitlabScmProvider(options: {
  integrations: ScmIntegrationRegistry;
}): ScmProvider {
  const { integrations } = options;

  return {
    type: 'gitlab',

    label: 'GitLab',

    normalizeUrl: normalizePathStyleUrl,

    parseRepoUrl,

    /** `https://<host>/<projectPath>/-/tree/<ref>/<subpath>` for a discovered
     *  root, or the bare project URL when the joined subpath is empty. */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      return composePathStyleCollectionUrl({
        normalizedRepoUrl,
        rootPrefixWithinInput,
        ref,
        parseRepoUrl,
        view: '-/tree',
        provider: 'GitLab'
      });
    },

    /**
     * Total: never throws. Cuts the path at the `/-/` separator, which is the
     * only reliable project-path boundary — a segment count cannot work when the
     * namespace is arbitrary-depth.
     */
    repoRootFromUrl(url) {
      try {
        const u = new URL(url);
        const segments = u.pathname.split('/').filter(Boolean);
        const dash = segments.indexOf('-');
        const projectSegments = dash === -1 ? segments : segments.slice(0, dash);
        if (projectSegments.length < 2) {
          return url;
        }
        return `${u.origin}/${projectSegments.join('/')}`;
      } catch {
        return url;
      }
    },

    assertConfigured(url) {
      if (!integrations.gitlab.byUrl(url)) {
        const host = safeHost(url);
        throw new Error(
          `No GitLab integration is configured for ${host}. Add an `
          + `\`integrations.gitlab\` entry with \`host: ${host}\` (and an `
          + `\`apiBaseUrl\`, which is required for self-hosted instances) to the `
          + `Backstage config. Only gitlab.com is configured by default.`
        );
      }
    },

    /**
     * Resolves the project's default branch from the GitLab projects API.
     *
     * Two tiers, in the same order as the tree read: the host's integration
     * credential (or anonymous, when none is configured) first, and only on
     * failure a retry with the caller's own OAuth token. The order matters —
     * preferring the caller's token makes a stale or under-scoped GitLab session
     * break discovery on a PUBLIC project that anonymous access reads fine.
     * Neither token is ever logged.
     */
    async resolveDefaultBranch(url, opts) {
      const integration = integrations.gitlab.byUrl(url);
      if (!integration) {
        this.assertConfigured(url);
        throw new Error(`No GitLab integration for ${url}`);
      }
      const { config } = integration;
      const { owner, repo } = parseRepoUrl(url);
      const projectPath = stripInstanceRelativePath(
        joinPosix(owner, repo),
        getGitLabIntegrationRelativePath(config)
      );
      try {
        return await fetchDefaultBranch(integration, projectPath);
      } catch (error) {
        if (!opts?.userToken) {
          throw error;
        }
        return await fetchDefaultBranch(integration, projectPath, opts.userToken);
      }
    },

    /**
     * Reads a private project with the caller's own GitLab OAuth token through
     * the injected `UrlReaderService`. `GitlabUrlReader.readTree` threads a
     * per-call `options.token` into all three of its requests (project lookup,
     * commit lookup, archive download), so no hand-rolled API client is needed
     * and the read keeps the reader's archive fetch, proxy handling, and ETag
     * support. The token is never logged.
     */
    readTreeWithUserToken(args: ScmUserTokenReadArgs): Promise<ScmFileTree> {
      return readTreeViaUrlReader(args);
    }
  };
}

/**
 * Drops a self-hosted instance's relative path prefix (`integrations.gitlab[].baseUrl`
 * pointing at e.g. `https://host/gitlab`) from a project path, so what reaches
 * the API is the project path GitLab knows. Mirrors `GitlabUrlReader.readTree`.
 */
function stripInstanceRelativePath(
  projectPath: string,
  relativePath: string
): string {
  if (!relativePath) {
    return projectPath;
  }
  const prefix = `${relativePath.replace(/^\/+/, '')}/`;
  return projectPath.startsWith(prefix)
    ? projectPath.slice(prefix.length)
    : projectPath;
}

/**
 * Reads `default_branch` for one project. `token` overrides the integration's
 * own credential when given; omitted, `getGitLabRequestOptions` falls back to
 * `config.token`, or to anonymous when the host configured none.
 *
 * Issued through `integration.fetch`, not the global `fetch`, so the host's
 * proxy and agent configuration applies — the same call `GitlabUrlReader` makes.
 * Using bare `fetch` here would let a proxied host read trees fine and fail only
 * on default-branch resolution.
 */
async function fetchDefaultBranch(
  integration: GitLabIntegration,
  projectPath: string,
  token?: string
): Promise<string> {
  const { config } = integration;
  const response = await integration.fetch(
    `${config.apiBaseUrl}/projects/${encodeURIComponent(projectPath)}`,
    getGitLabRequestOptions(config, token)
  );
  if (!response.ok) {
    throw new Error(
      `Failed to resolve the default branch for ${projectPath} `
      + `(${response.status} ${response.statusText})`
    );
  }
  const project = (await response.json()) as { default_branch?: string };
  if (!project.default_branch) {
    throw new Error(`GitLab project ${projectPath} reported no default branch.`);
  }
  return project.default_branch;
}
