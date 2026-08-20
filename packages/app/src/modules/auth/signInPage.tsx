import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import {
  bitbucketAuthApiRef,
  configApiRef,
  createApiFactory,
  discoveryApiRef,
  githubAuthApiRef,
  gitlabAuthApiRef,
  googleAuthApiRef,
  oauthRequestApiRef,
} from '@backstage/core-plugin-api';
import {
  BitbucketAuth,
  GithubAuth,
  GitlabAuth,
  GoogleAuth,
} from '@backstage/core-app-api';

/**
 * APP-SIDE test harness only (see docs/NEXT-STEPS.md §4). The new frontend
 * system does not register the GitHub / Google OAuth client APIs by default, so
 * we register them here as API extensions. A real host Backstage would supply
 * its own auth; the plugin only ever *consumes* `githubAuthApiRef`.
 */

// GitHub OAuth client API. `read:user` is the login default; the plugin later
// requests the broader `repo` scope on demand for private-repo connect.
export const githubAuthApi = ApiBlueprint.make({
  name: 'github-auth',
  params: define =>
    define(
      createApiFactory({
        api: githubAuthApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          oauthRequestApi: oauthRequestApiRef,
          configApi: configApiRef,
        },
        factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
          GithubAuth.create({
            configApi,
            discoveryApi,
            oauthRequestApi,
            defaultScopes: ['read:user'],
            environment: configApi.getOptionalString('auth.environment'),
          }),
      }),
    ),
});

// Google OAuth client API — present only to exercise the "signed-in user
// without GitHub creds" branch of the connect flow.
export const googleAuthApi = ApiBlueprint.make({
  name: 'google-auth',
  params: define =>
    define(
      createApiFactory({
        api: googleAuthApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          oauthRequestApi: oauthRequestApiRef,
          configApi: configApiRef,
        },
        factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
          GoogleAuth.create({
            configApi,
            discoveryApi,
            oauthRequestApi,
            environment: configApi.getOptionalString('auth.environment'),
          }),
      }),
    ),
});

// GitLab OAuth client API. `read_user` is the login default; broader scopes
// (`read_api`, `read_repository`) are requested on demand for private-repo
// connect, mirroring the GitHub `repo` escalation above.
export const gitlabAuthApi = ApiBlueprint.make({
  name: 'gitlab-auth',
  params: define =>
    define(
      createApiFactory({
        api: gitlabAuthApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          oauthRequestApi: oauthRequestApiRef,
          configApi: configApiRef,
        },
        factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
          GitlabAuth.create({
            configApi,
            discoveryApi,
            oauthRequestApi,
            defaultScopes: ['read_user'],
            environment: configApi.getOptionalString('auth.environment'),
          }),
      }),
    ),
});

// Bitbucket Cloud OAuth client API. `account` is the login default; the
// `repository` scope is requested on demand for private-repo connect.
export const bitbucketAuthApi = ApiBlueprint.make({
  name: 'bitbucket-auth',
  params: define =>
    define(
      createApiFactory({
        api: bitbucketAuthApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          oauthRequestApi: oauthRequestApiRef,
          configApi: configApiRef,
        },
        factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
          BitbucketAuth.create({
            configApi,
            discoveryApi,
            oauthRequestApi,
            defaultScopes: ['account'],
            environment: configApi.getOptionalString('auth.environment'),
          }),
      }),
    ),
});

// Sign-in page offering GitHub + Google + GitLab + Bitbucket, with Guest kept
// for local dev.
export const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => {
      const { SignInPage } = await import('@backstage/core-components');
      return props => (
        <SignInPage
          {...props}
          providers={[
            'guest',
            {
              id: 'github-auth-provider',
              title: 'GitHub',
              message: 'Sign in using GitHub',
              apiRef: githubAuthApiRef,
            },
            {
              id: 'google-auth-provider',
              title: 'Google',
              message: 'Sign in using Google',
              apiRef: googleAuthApiRef,
            },
            {
              id: 'gitlab-auth-provider',
              title: 'GitLab',
              message: 'Sign in using GitLab',
              apiRef: gitlabAuthApiRef,
            },
            {
              id: 'bitbucket-auth-provider',
              title: 'Bitbucket',
              message: 'Sign in using Bitbucket',
              apiRef: bitbucketAuthApiRef,
            },
          ]}
        />
      );
    },
  },
});
