import { ConfigReader } from '@backstage/config';
import { NotAllowedError, InputError } from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import {
  assertSourceAllowed,
  createProbeRateLimiter,
  readAllowedSources,
  type AllowedSource
} from './sourceAllowlist';

/**
 * Built from an EMPTY `integrations` block on purpose. That is the state every
 * adopter starts in, and it is the one that makes the gate necessary:
 * `readGithubIntegrationConfigs` appends a default `github.com` entry, and
 * GitLab and Bitbucket Cloud self-default theirs, so `integrations.byUrl` is
 * truthy for every public repository URL below. Any test that passed only
 * because `byUrl` returned undefined would be testing nothing.
 */
const integrations = ScmIntegrations.fromConfig(new ConfigReader({}));

const ACME: AllowedSource[] = [{ host: 'github.com', pathPrefixes: ['/acme'] }];

/** Asserts `url` is refused and hands the error back for inspection. */
function refusal(url: string, allowed: AllowedSource[] = ACME): Error {
  let thrown: unknown;
  let returned: string | undefined;
  try {
    returned = assertSourceAllowed({ url, integrations, allowed });
  } catch (e) {
    thrown = e;
  }
  expect(returned).toBeUndefined();
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
}

describe('readAllowedSources', () => {
  it('returns [] when the key is absent, which is what fails closed', () => {
    expect(readAllowedSources(new ConfigReader({}))).toEqual([]);
    expect(readAllowedSources(new ConfigReader({ bruno: {} }))).toEqual([]);
  });

  it('lower-cases and trims the host', () => {
    const config = new ConfigReader({
      bruno: { allowedSources: [{ host: '  GitHub.COM ' }] }
    });
    expect(readAllowedSources(config)).toEqual([
      { host: 'github.com', pathPrefixes: undefined, allowInsecure: undefined }
    ]);
  });

  it('throws on a malformed entry rather than dropping it', () => {
    // A dropped entry is a rule the operator believes is in force and is not.
    const config = new ConfigReader({
      bruno: { allowedSources: [{ pathPrefixes: ['/acme'] }] }
    });
    expect(() => readAllowedSources(config)).toThrow();
  });
});

describe('assertSourceAllowed', () => {
  it('allows a listed host and owner, returning the checked URL', () => {
    expect(
      assertSourceAllowed({
        url: ' https://github.com/acme/payments/tree/main/collection ',
        integrations,
        allowed: ACME
      })
    ).toBe('https://github.com/acme/payments/tree/main/collection');
  });

  it('refuses everything when nothing is allow-listed, naming the key', () => {
    const e = refusal('https://github.com/acme/payments', []);
    expect(e).toBeInstanceOf(NotAllowedError);
    expect(e.message).toContain('bruno.allowedSources');
  });

  it('refuses a path prefix that is not a whole-segment match', () => {
    // The case a `startsWith` on the raw strings gets wrong, and the one that
    // matters: `acme-legacy` is a different GitHub organization entirely.
    expect(() =>
      assertSourceAllowed({
        url: 'https://github.com/acme/payments',
        integrations,
        allowed: ACME
      })
    ).not.toThrow();
    expect(refusal('https://github.com/acme-legacy/x')).toBeInstanceOf(
      NotAllowedError
    );
  });

  it('matches owner and repo case-insensitively, as the hosts do', () => {
    expect(() =>
      assertSourceAllowed({
        url: 'https://github.com/ACME/Payments',
        integrations,
        allowed: ACME
      })
    ).not.toThrow();
  });

  it('refuses a listed host with an unlisted owner', () => {
    expect(refusal('https://github.com/evil/secrets')).toBeInstanceOf(
      NotAllowedError
    );
  });

  it('allows the whole host when an entry carries no pathPrefixes', () => {
    for (const allowed of [
      [{ host: 'ghe.example.com' }],
      [{ host: 'ghe.example.com', pathPrefixes: [] }]
    ] as AllowedSource[][]) {
      expect(() =>
        assertSourceAllowed({
          url: 'https://ghe.example.com/anyone/anything',
          integrations: ScmIntegrations.fromConfig(
            new ConfigReader({
              integrations: { github: [{ host: 'ghe.example.com' }] }
            })
          ),
          allowed
        })
      ).not.toThrow();
    }
  });

  it('matches a `*.` wildcard on subdomains but not on the apex', () => {
    const allowed: AllowedSource[] = [{ host: '*.example.com' }];
    const withHosts = ScmIntegrations.fromConfig(
      new ConfigReader({
        integrations: {
          github: [{ host: 'git.example.com' }, { host: 'example.com' }]
        }
      })
    );
    expect(() =>
      assertSourceAllowed({
        url: 'https://git.example.com/a/b',
        integrations: withHosts,
        allowed
      })
    ).not.toThrow();
    expect(() =>
      assertSourceAllowed({
        url: 'https://example.com/a/b',
        integrations: withHosts,
        allowed
      })
    ).toThrow(NotAllowedError);
  });

  it('refuses a URL that will not parse, as an InputError', () => {
    const e = refusal('not-a-url\nlevel=info msg="forged"');
    expect(e).toBeInstanceOf(InputError);
    // The caller's raw string is never quoted back: it is about to be echoed
    // into an HTTP response and it can hold newlines.
    expect(e.message).not.toContain('forged');
  });

  it('refuses a non-https scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://github.com/acme/payments',
      'data:text/plain,hello'
    ]) {
      expect(refusal(url)).toBeInstanceOf(NotAllowedError);
    }
  });

  it('refuses http:// unless the host entry opts in', () => {
    const url = 'http://github.com/acme/payments';
    expect(refusal(url).message).toContain('allowInsecure');
    expect(() =>
      assertSourceAllowed({
        url,
        integrations,
        allowed: [{ host: 'github.com', pathPrefixes: ['/acme'], allowInsecure: true }]
      })
    ).not.toThrow();
  });

  it('refuses an IP literal, loopback and the metadata endpoint', () => {
    // A `*` entry is the most permissive allowlist an operator could write, so
    // these are refused by SHAPE rather than by falling off the end of the list.
    const permissive: AllowedSource[] = [
      { host: '169.254.169.254' },
      { host: '127.0.0.1', allowInsecure: true },
      { host: 'localhost', allowInsecure: true },
      { host: '[::1]' },
      { host: 'metadata.google.internal' }
    ];
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:7007/api/bruno/collections',
      'http://localhost:7007/api/bruno/collections',
      'https://[::1]/acme/payments',
      'https://metadata.google.internal/computeMetadata/v1/'
    ]) {
      expect(refusal(url, permissive)).toBeInstanceOf(NotAllowedError);
    }
  });

  it('refuses a host with no integration, naming the key to add', () => {
    const e = refusal('https://gitlab.acme.com/acme/payments', [
      { host: 'gitlab.acme.com' }
    ]);
    expect(e.message).toContain('integrations.gitlab');
  });
});

describe('createProbeRateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('spends a per-user budget and refuses past it', () => {
    const limiter = createProbeRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.spend('user:default/a')).toBeUndefined();
    expect(limiter.spend('user:default/a')).toBeUndefined();
    expect(limiter.spend('user:default/a')).toBe(60);
    // Keyed on the principal, so one user's burst is not another's problem.
    expect(limiter.spend('user:default/b')).toBeUndefined();
  });

  it('opens a fresh window once the old one has elapsed', () => {
    const limiter = createProbeRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.spend('user:default/a')).toBeUndefined();
    expect(limiter.spend('user:default/a')).toBe(60);
    jest.advanceTimersByTime(30_000);
    expect(limiter.spend('user:default/a')).toBe(30);
    jest.advanceTimersByTime(30_001);
    expect(limiter.spend('user:default/a')).toBeUndefined();
  });
});
