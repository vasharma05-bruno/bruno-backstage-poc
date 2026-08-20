import { createFrontendModule } from '@backstage/frontend-plugin-api';
import {
  bitbucketAuthApi,
  githubAuthApi,
  gitlabAuthApi,
  googleAuthApi,
  signInPage,
} from './signInPage';

// Registers the GitHub/Google/GitLab/Bitbucket OAuth client APIs and the custom
// SignInPage on the built-in `app` plugin. Test scaffolding only — no Bruno
// feature logic.
export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    signInPage,
    githubAuthApi,
    googleAuthApi,
    gitlabAuthApi,
    bitbucketAuthApi,
  ],
});
