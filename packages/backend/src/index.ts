/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

// Load local dev secrets from .env into process.env before anything reads
// config. MUST stay the first import.
import './loadEnv';
import { createBackend } from '@backstage/backend-defaults';
// Bruno for Backstage — catalog module that emits kind: API entities for
// discovered Bruno collections (BrunoEntityProvider).
import { brunoCatalogModule } from '@usebruno/bruno-backend-plugin-poc';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// See https://backstage.io/docs/backend-system/building-backends/migrating#the-auth-plugin
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
// See https://backstage.io/docs/auth/guest/provider
// User login providers for the auth test harness (see docs/NEXT-STEPS.md §4).
// GitHub also grants the `repo` scope the plugin reuses for private-repo connect.
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));
backend.add(import('@backstage/plugin-auth-backend-module-google-provider'));
// Multi-SCM login: GitLab (gitlab.com) + Bitbucket Cloud. Same role as the
// GitHub provider above — user login, distinct from `integrations.*` service
// credentials. Bitbucket *Server*/Data Center is a separate provider module.
backend.add(import('@backstage/plugin-auth-backend-module-gitlab-provider'));
backend.add(import('@backstage/plugin-auth-backend-module-bitbucket-provider'));

// Bruno for Backstage — backend plugin (serves /api/bruno/*) + catalog module
backend.add(import('@usebruno/bruno-backend-plugin-poc'));
backend.add(brunoCatalogModule);

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// See https://backstage.io/docs/permissions/getting-started for how to create your own permission policy
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// user settings plugin
backend.add(import('@backstage/plugin-user-settings-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
