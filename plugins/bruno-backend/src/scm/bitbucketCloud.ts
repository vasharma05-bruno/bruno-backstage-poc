import {
  getBitbucketCloudDefaultBranch,
  type ScmIntegrationRegistry
} from '@backstage/integration';
import {
  assertSingleSegmentRef,
  joinPosix,
  normalizePathStyleUrl,
  originPlusSegments,
  safeHost
} from './normalize';
import type { ParsedRepoUrl, ScmProvider } from './types';

/**
 * Bitbucket Cloud's web URL grammar:
 *
 *   https://bitbucket.org/<workspace>/<repo>                    (repo root)
 *   https://bitbucket.org/<workspace>/<repo>/src/<ref>/<path>
 *
 * Same two-segment namespace as GitHub, with `src` where GitHub has `tree`. The
 * ref is a single path segment, so a slash-bearing ref is ambiguous against the
 * subpath — the same limitation the GitHub and GitLab adapters carry.
 *
 * This is Bitbucket *Cloud* only. Bitbucket Server / Data Center puts the ref in
 * the query string (`/projects/<KEY>/repos/<slug>/browse/<path>?at=refs/heads/<ref>`),
 * which `normalizePathStyleUrl` would destroy, so it needs its own adapter and
 * its own normalization (docs/MULTI-SCM-PLAN.md B1).
 */
function parseRepoUrl(url: string): ParsedRepoUrl {
  const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new Error(
      `Unsupported Bitbucket Cloud URL: ${url} — expected <workspace>/<repo>.`
    );
  }
  if (segments[2] === 'src' && segments[3]) {
    return {
      owner,
      repo,
      ref: segments[3],
      subpath: segments.slice(4).join('/')
    };
  }
  return { owner, repo, subpath: '' };
}

export function createBitbucketCloudScmProvider(options: {
  integrations: ScmIntegrationRegistry;
}): ScmProvider {
  const { integrations } = options;

  return {
    type: 'bitbucketCloud',

    label: 'Bitbucket Cloud',

    normalizeUrl: normalizePathStyleUrl,

    parseRepoUrl,

    /**
     * Rebuilds `https://<host>/<workspace>/<repo>/src/<ref>/<fullSubpath>` for a
     * discovered root, or the bare repo URL when both the input subpath and the
     * root prefix are empty.
     */
    composeCollectionUrl(normalizedRepoUrl, rootPrefixWithinInput, ref) {
      const u = new URL(normalizedRepoUrl);
      const { owner, repo, subpath: inputSubpath }
        = parseRepoUrl(normalizedRepoUrl);
      const fullSubpath = joinPosix(inputSubpath, rootPrefixWithinInput);
      if (fullSubpath === '') {
        return `${u.protocol}//${u.host}/${owner}/${repo}`;
      }
      assertSingleSegmentRef(ref, 'Bitbucket Cloud');
      return `${u.protocol}//${u.host}/${owner}/${repo}/src/${ref}/${fullSubpath}`;
    },

    /** Total: never throws. */
    repoRootFromUrl(url) {
      return originPlusSegments(url, 2);
    },

    assertConfigured(url) {
      if (!integrations.bitbucketCloud.byUrl(url)) {
        const host = safeHost(url);
        throw new Error(
          `No Bitbucket Cloud integration is configured for ${host}. Add an `
          + `\`integrations.bitbucketCloud\` entry with \`host: ${host}\` to the `
          + `Backstage config. Only bitbucket.org is configured by default; a `
          + `Bitbucket Server / Data Center host is a different provider `
          + `(\`integrations.bitbucketServer\`) and is not supported yet.`
        );
      }
    },

    /**
     * Resolves the repo's default branch via `@backstage/integration`'s
     * Bitbucket Cloud helper, which authenticates with the host's integration
     * credential.
     *
     * `opts.userToken` is deliberately unused: the helper takes only a config,
     * and a Bitbucket Cloud config cannot carry a bare token (see
     * `readTreeWithUserToken`'s absence below). A private Bitbucket repo
     * therefore needs a host-configured service credential here too.
     */
    async resolveDefaultBranch(url) {
      const integration = integrations.bitbucketCloud.byUrl(url);
      if (!integration) {
        this.assertConfigured(url);
        throw new Error(`No Bitbucket Cloud integration for ${url}`);
      }
      return getBitbucketCloudDefaultBranch(url, integration.config);
    }

    /*
     * `readTreeWithUserToken` is intentionally ABSENT, not unimplemented.
     *
     * There is nowhere to put a per-user Bitbucket Cloud OAuth token:
     * `BitbucketCloudUrlReader.readTree` ignores the per-call `options.token`
     * entirely and authenticates only from `this.integration.config`, and
     * `getBitbucketCloudRequestOptions` drops a bare `token` unless a `username`
     * accompanies it (`if (username && (token ?? appPassword))`) — which would
     * turn a private read into a SILENT ANONYMOUS one rather than an error.
     *
     * Leaving the method off makes the caller surface an explicit "needs a
     * host-configured credential" error instead. Private Bitbucket Cloud repos
     * are reachable through `integrations.bitbucketCloud` (`username` + `token`,
     * or `clientId` + `clientSecret`). Verified against @backstage/integration
     * and @backstage/backend-defaults; see docs/MULTI-SCM-PLAN.md §1.4 and B4.
     */
  };
}
