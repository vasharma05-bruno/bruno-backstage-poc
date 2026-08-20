import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { createBitbucketCloudScmProvider } from './bitbucketCloud';
import { createGithubScmProvider } from './github';
import { createGitlabScmProvider } from './gitlab';
import type { ScmProvider } from './types';

export type {
  ScmProvider,
  ParsedRepoUrl,
  ScmFileTree,
  ScmUserTokenReadArgs
} from './types';
export { normalizePathStyleUrl } from './normalize';
export { readTreeViaUrlReader } from './readTree';
export { isCollectionFile } from './treeFilter';

export interface ScmProviderRegistry {
  byUrl(url: string): ScmProvider;
}

/**
 * Best-effort provider type for a host with no `integrations` entry.
 *
 * Reached only when `integrations.byUrl` found nothing, which means the read
 * itself is going to fail (`assertConfigured`). Its job is therefore not to make
 * the read work — it is to pick the adapter whose grammar matches the URL, so
 * the user gets "no GitLab integration is configured for gitlab.com" instead of
 * a GitHub-shaped parse of a GitLab URL failing somewhere further down.
 *
 * Matches the public hosts exactly, plus the common self-hosted convention of
 * naming the first hostname label after the product (`gitlab.company.com`).
 */
function inferTypeFromHost(url: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname === 'github.com') {
    return 'github';
  }
  if (hostname === 'gitlab.com') {
    return 'gitlab';
  }
  if (hostname === 'bitbucket.org') {
    return 'bitbucketCloud';
  }
  const firstLabel = hostname.split('.')[0];
  if (firstLabel === 'gitlab') {
    return 'gitlab';
  }
  if (firstLabel === 'bitbucket') {
    return 'bitbucketCloud';
  }
  if (firstLabel === 'github') {
    return 'github';
  }
  return undefined;
}

export function createScmProviderRegistry(options: {
  integrations: ScmIntegrationRegistry;
  githubCredentials: GithubCredentialsProvider;
}): ScmProviderRegistry {
  const { integrations, githubCredentials } = options;
  const github = createGithubScmProvider({ integrations, githubCredentials });
  const gitlab = createGitlabScmProvider({ integrations });
  const bitbucketCloud = createBitbucketCloudScmProvider({ integrations });
  const byType = new Map<string, ScmProvider>([
    [github.type, github],
    [gitlab.type, gitlab],
    [bitbucketCloud.type, bitbucketCloud]
  ]);

  return {
    byUrl(url: string): ScmProvider {
      const type = integrations.byUrl(url)?.type;
      const configured = type ? byType.get(type) : undefined;
      if (configured) {
        return configured;
      }
      const inferred = inferTypeFromHost(url);
      const guessed = inferred ? byType.get(inferred) : undefined;
      if (guessed) {
        return guessed;
      }
      // A host that matches no integration and no known grammar. Parsing it as
      // GitHub is what every URL got before the seam existed, so keep that
      // rather than throwing from a lookup that `repoRootFromUrl` callers
      // require to be total. Providers we do not implement (Azure, Gitea,
      // Gerrit, Harness) land here and fail at read time with the reader's own
      // error — see docs/MULTI-SCM-PLAN.md B10 and the P6 diagnostics phase.
      return github;
    }
  };
}
