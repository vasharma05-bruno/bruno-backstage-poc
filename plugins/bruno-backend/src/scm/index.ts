import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { createGithubScmProvider } from './github';
import type { ScmProvider } from './types';

export type { ScmProvider, ParsedRepoUrl } from './types';

export interface ScmProviderRegistry {
  byUrl(url: string): ScmProvider;
}

export function createScmProviderRegistry(options: {
  integrations: ScmIntegrationRegistry;
  githubCredentials: GithubCredentialsProvider;
}): ScmProviderRegistry {
  const { integrations, githubCredentials } = options;
  const github = createGithubScmProvider({ integrations, githubCredentials });
  const byType = new Map<string, ScmProvider>([[github.type, github]]);

  return {
    byUrl(url: string): ScmProvider {
      const type = integrations.byUrl(url)?.type;
      // An unconfigured host yields no integration. Today every URL is parsed
      // GitHub-shaped, so falling back to the GitHub adapter keeps that exact
      // behaviour; P5 turns an unknown provider into an explicit error.
      return (type ? byType.get(type) : undefined) ?? github;
    }
  };
}
