/**
 * A boot-time warning for the one class of `integrations.*` mistake that
 * produces no error anywhere: a host whose credential is configured but shaped
 * so that `@backstage/integration` discards it, and a host with no entry at
 * all. Both read ANONYMOUSLY — which on a private repository is a 404 rather
 * than a 401, and on a public one is a mystifying rate-limit failure hours
 * later. `src/scm/credentialShapes.test.ts` pins the shapes themselves.
 *
 * WARN, NEVER THROW. `integrations.*` is the host app's config, shared with
 * techdocs, the catalog and the scaffolder; an anonymous read is a perfectly
 * legitimate choice for public collections, and a plugin that refused to start
 * over someone else's config key would be wrong twice over. This gets to warn
 * about it, not to veto it.
 *
 * Scoped to the hosts this plugin will ACTUALLY touch — the ones named by
 * `bruno.collections[]` and `bruno.discovery[]` — so an unrelated half-finished
 * integration somewhere else in `app-config.yaml` produces no noise here.
 *
 * NO CREDENTIAL VALUE IS EVER READ. Every secret is replaced with a sentinel
 * before the config goes back to `@backstage/integration`, only the PRESENCE of
 * an `Authorization` header is observed, and the sentinel never leaves the
 * process — see `withSentinelSecrets` and the Bitbucket Cloud branch below.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { ScmIntegrationRegistry } from '@backstage/integration';
import {
  ScmIntegrations,
  getBitbucketCloudRequestOptions,
  getBitbucketServerRequestOptions,
  getGitLabRequestOptions,
  getGiteaRequestOptions
} from '@backstage/integration';
import { inferTypeFromHost } from '../scm';
import { readBrunoCollections, readBrunoDiscovery } from './brunoConfig';

/** Stands in for whatever the operator actually configured. */
const SENTINEL = 'bruno-credential-shape-probe';

/**
 * Config keys whose value is a secret in one integration type or another.
 * `clientId` and `username` are deliberately absent: neither is a secret, and
 * both participate in deciding whether a credential is complete.
 */
const SECRET_KEYS = [
  'token',
  'password',
  'appPassword',
  'clientSecret',
  'privateKey',
  'personalAccessToken',
  'webhookSecret',
  'commitSigningKey'
];

/**
 * A shallow copy with every secret replaced by the sentinel.
 *
 * The invariant that makes this sound: TRUTHINESS IS PRESERVED EXACTLY. A key
 * that is absent stays absent, and an empty string — which several readers
 * produce by `.trim()`ing a whitespace-only value, and which is falsy to every
 * `if (config.token)` upstream — stays empty. So the masked copy reaches the
 * same verdict as the real one while holding none of it.
 */
function withSentinelSecrets<T extends object>(config: T): T {
  const masked = { ...config } as Record<string, unknown>;
  for (const key of SECRET_KEYS) {
    if (typeof masked[key] === 'string' && masked[key] !== '') {
      masked[key] = SENTINEL;
    }
  }
  return masked as T;
}

/**
 * Presence, never content. The `?? {}` is load-bearing: Gitea's helper returns
 * the bare header map, with no `headers` key, on its unauthenticated path.
 */
function hasAuthorizationHeader(options: {
  headers?: Record<string, string>;
}): boolean {
  return 'Authorization' in (options.headers ?? {});
}

/** The shape that actually authenticates, quoted into the warning so nobody has
 *  to go and find it in Backstage's docs while an ingest is failing. */
const CREDENTIAL_SHAPE: Record<string, string> = {
  github: '`token: <PAT>`, or an `apps:` entry',
  gitlab: '`token: <PAT>`',
  bitbucketCloud:
    '`username` alongside `token` (or `appPassword`), or `clientId` + '
    + '`clientSecret` — a bare `token` is accepted by config validation and '
    + 'then discarded at request time',
  bitbucketServer: '`token: <PAT>`, or `username` + `password`',
  gitea: '`password: <token>` with `username` omitted — there is no `token` key'
};

/** What an anonymous read costs, in the terms the failure will present itself
 *  in. Shared by both warnings so the two read as one diagnosis. */
const ANONYMOUS_COST
  = 'reads of Bruno collections there will be ANONYMOUS: a private repository '
    + 'answers 404 rather than 401, and a public one shares the host\'s '
    + 'unauthenticated rate-limit bucket (60 requests/hour on GitHub and '
    + 'Bitbucket Cloud)';

/**
 * Whether this host's integration yields an `Authorization` header, or
 * `undefined` when that cannot be established without a network request.
 *
 * Ordered as a chain of typed lookups rather than a switch on
 * `ScmIntegration.type`, because each group's `byHost` returns its own config
 * type and so each helper below is called with no casting.
 */
async function authorizes(
  integrations: ScmIntegrationRegistry,
  host: string
): Promise<boolean | undefined> {
  const github = integrations.github.byHost(host);
  if (github) {
    // The one type with no `get*RequestOptions`: GitHub credentials are
    // resolved per request by `GithubCredentialsProvider`, and resolving an App
    // installation token is itself an API call. Presence of either spelling is
    // as far as an offline check can honestly go.
    const config = withSentinelSecrets(github.config);
    return Boolean(config.token) || (config.apps?.length ?? 0) > 0;
  }

  const gitlab = integrations.gitlab.byHost(host);
  if (gitlab) {
    return hasAuthorizationHeader(
      getGitLabRequestOptions(withSentinelSecrets(gitlab.config))
    );
  }

  const bitbucketCloud = integrations.bitbucketCloud.byHost(host);
  if (bitbucketCloud) {
    const config = withSentinelSecrets(bitbucketCloud.config);
    // `getBitbucketCloudRequestOptions` POSTs to bitbucket.org for an OAuth
    // token when BOTH of these are set, so that branch is answered here rather
    // than called: the sentinel must never reach a socket, and a boot-time
    // check must never depend on the network. Every other path through that
    // helper is pure, and the test file pins this condition against it.
    if (config.clientId && config.clientSecret) {
      return true;
    }
    return hasAuthorizationHeader(
      await getBitbucketCloudRequestOptions(config)
    );
  }

  const bitbucketServer = integrations.bitbucketServer.byHost(host);
  if (bitbucketServer) {
    return hasAuthorizationHeader(
      getBitbucketServerRequestOptions(withSentinelSecrets(bitbucketServer.config))
    );
  }

  const gitea = integrations.gitea.byHost(host);
  if (gitea) {
    return hasAuthorizationHeader(
      getGiteaRequestOptions(withSentinelSecrets(gitea.config))
    );
  }

  // Azure, Gerrit, Harness and the object stores: either no helper that can be
  // asked offline, or a credential model this check would have to reimplement.
  // Saying nothing is better than guessing wrong about someone's working host.
  return integrations.byHost(host) ? undefined : false;
}

/** The hosts this plugin will read from, and only those. Both readers are
 *  called without a logger — the provider logs their per-entry failures on the
 *  first tick, and repeating them here would double every message. */
function hostsInUse(config: Config): string[] {
  const hosts = new Set<string>();

  for (const collection of readBrunoCollections(config)) {
    try {
      hosts.add(new URL(collection.url).hostname);
    } catch {
      // Not a URL, so not a host — the entry fails at read time with a message
      // of its own and there is nothing useful to say about it here.
    }
  }
  for (const entry of readBrunoDiscovery(config)) {
    hosts.add(entry.host);
  }

  return [...hosts];
}

/**
 * Warns once per configured host whose `integrations.*` entry yields no
 * credential. Resolves without throwing whatever the config says.
 */
export async function warnOnAnonymousScmReads(options: {
  config: Config;
  logger: LoggerService;
}): Promise<void> {
  const { config, logger } = options;
  const integrations = ScmIntegrations.fromConfig(config);

  for (const host of hostsInUse(config)) {
    // `undefined` — a type this check cannot judge offline — is as good as a
    // pass here. Only a definite "no header" is worth an operator's attention.
    if ((await authorizes(integrations, host)) !== false) {
      continue;
    }

    const integration = integrations.byHost(host);
    if (!integration) {
      // Only reachable for a self-hosted host: the three public ones each get
      // an auto-injected entry, so they land in the branch below instead.
      const type = inferTypeFromHost(`https://${host}`) ?? '<provider>';
      logger.warn(
        `No \`integrations\` entry matches ${host}, so ${ANONYMOUS_COST}. `
        + `Declare the host under \`integrations.${type}\`.`
      );
      continue;
    }

    logger.warn(
      `\`integrations.${integration.type}\` for ${host} produces no `
      + `Authorization header, so ${ANONYMOUS_COST}. The shape that `
      + `authenticates is ${CREDENTIAL_SHAPE[integration.type]}.`
    );
  }
}
