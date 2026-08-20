import {
  getGitLabIntegrationRelativePath,
  getGitLabRequestOptions,
  type ScmIntegrationRegistry
} from '@backstage/integration';
import { joinPosix, normalizePathStyleUrl, safeHost } from './normalize';
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
 * `/tree/<ref>/`. Paste a `/-/tree/` URL whose ref has no slash, or the project
 * root, to stay unambiguous.
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

    /**
     * Rebuilds `https://<host>/<projectPath>/-/tree/<ref>/<fullSubpath>` for a
     * discovered root, or the bare project URL when both the input subpath and
     * the root prefix are empty.
     */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      const u = new URL(normalizedRepoUrl);
      const { owner, repo, subpath: inputSubpath }
        = parseRepoUrl(normalizedRepoUrl);
      const projectPath = joinPosix(owner, repo);
      const fullSubpath = joinPosix(inputSubpath, rootPrefixWithinInput);
      if (fullSubpath === '') {
        return `${u.protocol}//${u.host}/${projectPath}`;
      }
      return `${u.protocol}//${u.host}/${projectPath}/-/tree/${ref}/${fullSubpath}`;
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
          + `\`integrations.gitlab\` entry with \`host: ${host}\` to the Backstage `
          + `config — GitLab needs one even for public projects, because only `
          + `github.com gets a default integration entry.`
        );
      }
    },

    /**
     * Resolves the project's default branch from the GitLab projects API.
     * Prefers the caller's OAuth token when one was supplied (a private project
     * is invisible to an anonymous or under-scoped service token), otherwise
     * falls back to the integration's own token via `getGitLabRequestOptions`.
     * The token is never logged.
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
      const response = await fetch(
        `${config.apiBaseUrl}/projects/${encodeURIComponent(projectPath)}`,
        getGitLabRequestOptions(config, opts?.userToken)
      );
      if (!response.ok) {
        throw new Error(
          `Failed to resolve the default branch for ${projectPath} `
          + `(${response.status} ${response.statusText})`
        );
      }
      const project = (await response.json()) as { default_branch?: string };
      if (!project.default_branch) {
        throw new Error(
          `GitLab project ${projectPath} reported no default branch.`
        );
      }
      return project.default_branch;
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

