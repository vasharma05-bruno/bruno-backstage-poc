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
 * credentials, and it is used for ONE purpose: authoring pull requests as the
 * signed-in user (the `catalog-info.yaml` PR in `AddCollection`, and the
 * `spec.partOf` link/unlink PRs). Reading collections never comes through here —
 * that is server-side, on the host's `integrations.*` credentials, with no
 * per-user path at all (`plugins/bruno-backend/README.md#credential-isolation`).
 *
 * Which makes GitHub the only entry below that anything actually calls: both PR
 * flows are GitHub-gated (`catalogImportApi.submitPullRequest` supports only
 * GitHub and Azure, and the link/unlink dialogs check the integration type).
 * `forGitlab` and `forBitbucket` are registered anyway, deliberately: they cost
 * nothing while unused, and they are what a host app extending the PR flows to
 * another provider would otherwise have to rediscover. Nothing requests their
 * scopes today, so neither OAuth application needs repository access granted.
 *
 * It routes by the repository URL's host and owns the per-provider scope
 * mapping, so the plugin never names a provider or a scope:
 *
 *   GitHub     repo read:org read:user   (`repo` is the one that matters — write)
 *   GitLab     read_user read_api read_repository
 *   Bitbucket  account                   (narrowed — see below)
 *
 * Bitbucket is the one provider whose scope mapping we override. `ScmAuth`'s
 * stock default is `account team pullrequest snippet issue project`, but this
 * plugin never reads PRs, snippets, issues or projects, and never writes to
 * Bitbucket at all. So the extra five scopes are pure over-ask: they make
 * Bitbucket reject the consent request unless the OAuth consumer happens to
 * grant all of them, in exchange for no capability the plugin can exercise.
 *
 * Built with `merge` over the three providers this app registers rather than
 * `ScmAuth.createDefaultApiFactory()`, because that factory also depends on
 * `microsoftAuthApiRef` for Azure DevOps — an API this app does not register, so
 * the default factory would fail to resolve.
 *
 * A host Backstage app that registers nothing here still gets a fully working
 * plugin, minus the ability to open pull requests from the UI — the dialogs offer
 * a file download instead. The plugin resolves this API through `useApiHolder`,
 * not `useApi`, so a missing registration disables a button rather than throwing
 * during render.
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
