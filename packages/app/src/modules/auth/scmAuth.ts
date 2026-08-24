import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import {
  bitbucketAuthApiRef,
  createApiFactory,
  githubAuthApiRef,
  gitlabAuthApiRef,
} from '@backstage/core-plugin-api';
import { ScmAuth, scmAuthApiRef } from '@backstage/integration-react';

/**
 * APP-SIDE test harness only, like the rest of this module.
 *
 * `scmAuthApiRef` is the one API the Bruno plugin uses to obtain a user's SCM
 * credentials. It routes by the repository URL's host and owns the per-provider
 * scope mapping, so the plugin never names a provider or a scope:
 *
 *   GitHub     repo read:org read:user
 *   GitLab     read_user read_api read_repository
 *   Bitbucket  account            (narrowed — see below)
 *
 * Bitbucket is the one provider whose scope mapping we override. `ScmAuth`'s
 * stock default is `account team pullrequest snippet issue project`, but this
 * plugin never reads PRs, snippets, issues or projects — and per
 * `plugins/bruno-backend/src/scm/bitbucketCloud.ts` it cannot use a per-user
 * Bitbucket Cloud token for repository reads at all (`readTreeWithUserToken` is
 * deliberately absent, because `BitbucketCloudUrlReader` ignores a per-call
 * token). So the extra five scopes are pure over-ask: they make Bitbucket
 * reject the consent request unless the OAuth consumer happens to grant all of
 * them, in exchange for no capability the plugin can exercise.
 *
 * Built with `merge` over the three providers this app registers rather than
 * `ScmAuth.createDefaultApiFactory()`, because that factory also depends on
 * `microsoftAuthApiRef` for Azure DevOps — an API this app does not register, so
 * the default factory would fail to resolve.
 *
 * A host Backstage app that registers nothing here still gets a working plugin,
 * limited to public repositories: the plugin resolves this API through
 * `useApiHolder`, not `useApi`, so a missing registration degrades instead of
 * throwing during render.
 *
 * Self-hosted instances need one `ScmAuth.forX(api, { host })` entry each — the
 * defaults below cover only github.com, gitlab.com and bitbucket.org.
 */
export const scmAuthApi = ApiBlueprint.make({
  name: 'scm-auth',
  params: define =>
    define(
      createApiFactory({
        api: scmAuthApiRef,
        deps: {
          githubAuthApi: githubAuthApiRef,
          gitlabAuthApi: gitlabAuthApiRef,
          bitbucketAuthApi: bitbucketAuthApiRef,
        },
        factory: ({ githubAuthApi, gitlabAuthApi, bitbucketAuthApi }) =>
          ScmAuth.merge(
            ScmAuth.forGithub(githubAuthApi),
            ScmAuth.forGitlab(gitlabAuthApi),
            ScmAuth.forBitbucket(bitbucketAuthApi, {
              // `account` alone — it is all the plugin can use, and an
              // Account:Read consumer already grants it. `repoWrite` is empty
              // because nothing here ever writes to Bitbucket.
              scopeMapping: { default: ['account'], repoWrite: [] }
            }),
          ),
      }),
    ),
});
