/**
 * The six `integrations.*` credential-shape traps, pinned against the installed
 * `@backstage/integration`.
 *
 * These were originally a one-time investigation — a sentinel round-tripped
 * through `ScmIntegrations.fromConfig` and read back out of each
 * `get*RequestOptions` — written up in prose in `docs/TECHNICAL-DESIGN.md` §5
 * and in this plugin's README. Prose cannot notice when upstream changes the
 * answer, and MOST OF THESE TRAPS FAIL SILENTLY: the misconfigured host reads
 * ANONYMOUSLY rather than erroring, so nothing downstream reports the drift
 * either. Hence this file: the procedure, run on every `yarn test`.
 *
 * The sentinel here is a literal, never a real credential, and no test asserts
 * on a header's VALUE — only on whether `Authorization` is present at all.
 * `src/service/credentialCheck.ts` applies the same rule at runtime.
 *
 * No network: every helper exercised below is either synchronous or resolves
 * without IO for the configurations used here. The one branch that does make a
 * request — Bitbucket Cloud's `clientId` + `clientSecret` OAuth exchange — is
 * deliberately never entered.
 */
import { ConfigReader } from '@backstage/config';
import {
  ScmIntegrations,
  getBitbucketCloudRequestOptions,
  getGitLabRequestOptions,
  getGiteaRequestOptions
} from '@backstage/integration';

const SENTINEL = 'sentinel-not-a-real-credential';

/**
 * Presence, never content. Note the `?? {}`: Gitea's helper returns the bare
 * header map — with no `headers` key at all — on its unauthenticated path, so
 * an unguarded `options.headers` is `undefined` there rather than `{}`.
 */
function hasAuthorizationHeader(options: {
  headers?: Record<string, string>;
}): boolean {
  return 'Authorization' in (options.headers ?? {});
}

function integrationsFrom(integrations: object): ScmIntegrations {
  return ScmIntegrations.fromConfig(new ConfigReader({ integrations }));
}

describe('trap 1 — Bitbucket Cloud silently drops a bare `token`', () => {
  // IF THIS TEST STARTS FAILING, upstream has fixed the trap, and both
  // `plugins/bruno-backend/README.md` (§ "Credential shapes are not uniform")
  // and the `integrations:` comments in `app-config.yaml` now say something
  // untrue. Update them in the same commit as this file.
  it('stores a bare `token` and then discards it at request time', async () => {
    const integration = integrationsFrom({
      bitbucketCloud: [{ token: SENTINEL }]
    }).bitbucketCloud.byHost('bitbucket.org');

    // The token IS read and IS kept on the config — which is exactly why this
    // is invisible to an operator inspecting their own configuration.
    expect(integration?.config.token).toBeDefined();

    // And then no header is built from it. The read that follows is anonymous:
    // 60 requests/hour, 404 rather than 401 on a private repository.
    expect(
      hasAuthorizationHeader(
        await getBitbucketCloudRequestOptions(integration!.config)
      )
    ).toBe(false);
  });

  it('drops a bare `appPassword` the same way', async () => {
    // Not in the original write-up, and the same failure: the username is what
    // the Basic scheme needs, so a secret without one is unusable whichever
    // key it was written under.
    const integration = integrationsFrom({
      bitbucketCloud: [{ appPassword: SENTINEL }]
    }).bitbucketCloud.byHost('bitbucket.org');

    expect(
      hasAuthorizationHeader(
        await getBitbucketCloudRequestOptions(integration!.config)
      )
    ).toBe(false);
  });

  it('authenticates once a `username` accompanies the token', async () => {
    const integration = integrationsFrom({
      bitbucketCloud: [{ username: 'ci', token: SENTINEL }]
    }).bitbucketCloud.byHost('bitbucket.org');

    expect(
      hasAuthorizationHeader(
        await getBitbucketCloudRequestOptions(integration!.config)
      )
    ).toBe(true);
  });

  it('validates the broken shape and rejects only the mirror of it', () => {
    // The asymmetry is the whole reason a startup check exists. Config
    // validation catches `username` with no secret — loudly, at boot — but a
    // secret with no `username` passes, is stored, and is thrown away later.
    expect(() =>
      integrationsFrom({ bitbucketCloud: [{ username: 'ci' }] })
    ).toThrow(/username and either a token or an appPassword/);

    expect(() =>
      integrationsFrom({ bitbucketCloud: [{ token: SENTINEL }] })
    ).not.toThrow();
  });
});

describe('trap 2 — Gitea carries its token in `password`', () => {
  it('sends `Authorization: token <password>` when `username` is omitted', () => {
    const integration = integrationsFrom({
      gitea: [{ host: 'gitea.example.com', password: SENTINEL }]
    }).gitea.byHost('gitea.example.com');

    expect(
      hasAuthorizationHeader(getGiteaRequestOptions(integration!.config))
    ).toBe(true);
  });

  it('has no `token` key at all, so `integrations.gitea[].token` is unknown', () => {
    // Not an IGNORED key — an unknown one. Nothing in the Gitea config reader
    // looks for `token`, so a token written under that name leaves the host
    // with no credential whatsoever.
    const integration = integrationsFrom({
      gitea: [{ host: 'gitea.example.com', token: SENTINEL }]
    }).gitea.byHost('gitea.example.com');

    expect(integration?.config).not.toHaveProperty('token');
    expect(integration?.config.password).toBeUndefined();
    expect(
      hasAuthorizationHeader(getGiteaRequestOptions(integration!.config))
    ).toBe(false);
  });
});

describe('trap 3 — Azure throws on a scalar `token` or `credential`', () => {
  it.each(['token', 'credential'])(
    'rejects the removed `%s` key outright',
    (key) => {
      expect(() =>
        integrationsFrom({ azure: [{ host: 'dev.azure.com', [key]: SENTINEL }] })
      ).toThrow(/'credential' and 'token' have been removed/);
    }
  );

  it('accepts `credentials: [{ personalAccessToken }]`', () => {
    const integration = integrationsFrom({
      azure: [
        { host: 'dev.azure.com', credentials: [{ personalAccessToken: SENTINEL }] }
      ]
    }).azure.byHost('dev.azure.com');

    expect(integration?.config.credentials).toEqual([
      expect.objectContaining({ kind: 'PersonalAccessToken' })
    ]);
  });

  it('rejects one credential entry that mixes two credential kinds', () => {
    // Every field outside the matched kind must be absent, so a PAT sitting
    // beside a leftover `clientId` matches nothing and the message names no
    // field — "is not a valid credential" is the whole diagnostic.
    expect(() =>
      integrationsFrom({
        azure: [
          {
            host: 'dev.azure.com',
            credentials: [{ personalAccessToken: SENTINEL, clientId: 'app' }]
          }
        ]
      })
    ).toThrow(/is not a valid credential/);
  });

  it('allows only personal access tokens off `dev.azure.com`', () => {
    expect(() =>
      integrationsFrom({
        azure: [
          {
            host: 'azure.company.com',
            credentials: [
              { clientId: 'app', clientSecret: SENTINEL, tenantId: 'tenant' }
            ]
          }
        ]
      })
    ).toThrow(/only personal access tokens can be used with hosts other than/);
  });
});

describe('trap 4 — an empty string is fatal where `null` is safe', () => {
  // IF THIS TEST STARTS FAILING, the "comment the block out, do not empty the
  // var" advice in the README and in `app-config.yaml` is no longer necessary
  // and should be corrected in the same commit.
  it('fails the whole backend boot on an empty-string credential', () => {
    // `getOptionalString` treats `''` as a TYPE error rather than as absent,
    // and every `core.urlReader` consumer builds `ScmIntegrations` at init —
    // so one blank env var takes down catalog, techdocs and scaffolder too,
    // long before this plugin is reached.
    expect(() =>
      integrationsFrom({ github: [{ host: 'github.com', token: '' }] })
    ).toThrow(/got empty-string, wanted string/);
  });

  it('treats an explicit `null` as absent', () => {
    // The safe spelling of "this host has no credential yet", and documented
    // nowhere upstream.
    const integration = integrationsFrom({
      github: [{ host: 'github.com', token: null }]
    }).github.byHost('github.com');

    expect(integration?.config.token).toBeUndefined();
  });
});

describe('trap 5 — the public hosts self-default, Bitbucket Server does not', () => {
  const none = ScmIntegrations.fromConfig(new ConfigReader({}));

  it.each([
    ['https://github.com/acme/apis', 'github'],
    ['https://gitlab.com/acme/apis', 'gitlab'],
    ['https://bitbucket.org/acme/apis', 'bitbucketCloud']
  ])('resolves %s with no `integrations` config at all', (url, type) => {
    // Which is also why `byUrl` is worthless as an authorization check: it is
    // truthy for every public repository URL on earth. `service/sourceAllowlist.ts`
    // exists because of this.
    expect(none.byUrl(url)?.type).toBe(type);
  });

  it('leaves an unconfigured Bitbucket Server host with no integration', () => {
    expect(none.bitbucketServer.list()).toHaveLength(0);
    expect(none.byUrl('https://bitbucket.company.com/projects/API')).toBeUndefined();
  });
});

describe('trap 6 — GitLab `retry` is off by default', () => {
  it('leaves `retry` undefined when the block is absent', () => {
    const integration = integrationsFrom({
      gitlab: [{ host: 'gitlab.com', token: SENTINEL }]
    }).gitlab.byHost('gitlab.com');

    expect(integration?.config.retry).toBeUndefined();
    // The token itself is honoured — the retry block is the only opt-in part.
    expect(
      hasAuthorizationHeader(getGitLabRequestOptions(integration!.config))
    ).toBe(true);
  });

  it('still retries nothing when the block is present but empty', () => {
    // `maxRetries` defaults to 0, so writing `retry: {}` to "turn retries on"
    // turns nothing on. It is the only backoff any provider offers, and it is
    // opt-in twice over.
    const integration = integrationsFrom({
      gitlab: [{ host: 'gitlab.com', token: SENTINEL, retry: {} }]
    }).gitlab.byHost('gitlab.com');

    expect(integration?.config.retry).toEqual({
      maxRetries: 0,
      retryStatusCodes: [],
      maxApiRequestsPerMinute: -1
    });
  });
});
