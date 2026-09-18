import type { LoggerService } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import { warnOnAnonymousScmReads } from './credentialCheck';

function stubLogger(): LoggerService & { warn: jest.Mock } {
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    child: () => logger
  };
  return logger as unknown as LoggerService & { warn: jest.Mock };
}

async function warningsFor(data: object): Promise<string[]> {
  const logger = stubLogger();
  await warnOnAnonymousScmReads({
    config: new ConfigReader(data),
    logger
  });
  return logger.warn.mock.calls.map((call) => String(call[0]));
}

const GITHUB_COLLECTION = {
  type: 'url',
  url: 'https://github.com/acme/apis/tree/main/collections/payments'
};
const BITBUCKET_COLLECTION = {
  type: 'url',
  url: 'https://bitbucket.org/acme/apis/src/main/collections/payments'
};

describe('warnOnAnonymousScmReads', () => {
  it('says nothing about a host whose credential is shaped correctly', async () => {
    expect(
      await warningsFor({
        bruno: { collections: [GITHUB_COLLECTION] },
        integrations: { github: [{ host: 'github.com', token: 'pat' }] }
      })
    ).toEqual([]);
  });

  it('warns about a bare-token Bitbucket Cloud host', async () => {
    // The trap this check exists for: the entry validates, the token is stored,
    // and `getBitbucketCloudRequestOptions` throws it away — so nothing else in
    // the system ever reports it.
    const warnings = await warningsFor({
      bruno: { collections: [BITBUCKET_COLLECTION] },
      integrations: { bitbucketCloud: [{ token: 'pat' }] }
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bitbucket.org');
    expect(warnings[0]).toContain('ANONYMOUS');
    // Actionable, or it is just noise at boot.
    expect(warnings[0]).toContain('`username` alongside `token`');
    // And it never quotes what it inspected.
    expect(warnings[0]).not.toContain('pat');
  });

  it('accepts the same host once the username is there', async () => {
    expect(
      await warningsFor({
        bruno: { collections: [BITBUCKET_COLLECTION] },
        integrations: { bitbucketCloud: [{ username: 'ci', token: 'pat' }] }
      })
    ).toEqual([]);
  });

  it('checks nothing when there is no `bruno` config at all', async () => {
    // The point of scoping to `bruno.collections[]` and `bruno.discovery[]`:
    // this bitbucketCloud entry is broken, and it is none of this plugin's
    // business, because this plugin will never read from that host.
    expect(
      await warningsFor({
        integrations: { bitbucketCloud: [{ token: 'pat' }] }
      })
    ).toEqual([]);
  });

  it('covers discovery hosts too, and warns once per host', async () => {
    const warnings = await warningsFor({
      bruno: {
        collections: [GITHUB_COLLECTION],
        discovery: [
          { organization: 'acme' },
          { organization: 'acme-labs', host: 'ghe.example.net' }
        ]
      }
    });

    // `github.com` is named by both a collection and a discovery entry, and
    // self-defaults an integration with no token; `ghe.example.net` has no
    // entry at all. Two hosts, two warnings, in that order.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('`integrations.github` for github.com');
    expect(warnings[1]).toContain('No `integrations` entry matches ghe.example.net');
  });
});
