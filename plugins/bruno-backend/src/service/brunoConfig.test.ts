import { ConfigReader } from '@backstage/config';
import { readAllowRuntimeWrites, readBrunoDiscovery } from './brunoConfig';

describe('readBrunoDiscovery', () => {
  it('is empty when nothing is configured', () => {
    expect(readBrunoDiscovery(new ConfigReader({}))).toEqual([]);
    expect(readBrunoDiscovery(new ConfigReader({ bruno: {} }))).toEqual([]);
  });

  it('defaults the host and the descriptor deferral', () => {
    expect(
      readBrunoDiscovery(
        new ConfigReader({ bruno: { discovery: [{ organization: 'acme' }] } })
      )
    ).toEqual([
      {
        host: 'github.com',
        organization: 'acme',
        repositoryPattern: undefined,
        excludePathPattern: undefined,
        owner: undefined,
        deferToCatalogInfo: true
      }
    ]);
  });

  it('reads every knob', () => {
    expect(
      readBrunoDiscovery(
        new ConfigReader({
          bruno: {
            discovery: [
              {
                host: 'ghe.example.net',
                organization: 'platform',
                repositoryPattern: '.*-api',
                excludePathPattern: 'tests/.*',
                owner: 'group:default/platform',
                deferToCatalogInfo: false
              }
            ]
          }
        })
      )
    ).toEqual([
      {
        host: 'ghe.example.net',
        organization: 'platform',
        repositoryPattern: '.*-api',
        excludePathPattern: 'tests/.*',
        owner: 'group:default/platform',
        deferToCatalogInfo: false
      }
    ]);
  });

  it('skips an entry with no organization, keeping the others', () => {
    const errors: string[] = [];
    const entries = readBrunoDiscovery(
      new ConfigReader({
        bruno: { discovery: [{ owner: 'guests' }, { organization: 'acme' }] }
      }),
      { error: (m: string) => errors.push(m) } as never
    );
    expect(entries.map((e) => e.organization)).toEqual(['acme']);
    expect(errors[0]).toMatch(/bruno.discovery\[0\]/);
  });

  it('skips an entry whose excludePathPattern will not compile', () => {
    const errors: string[] = [];
    const entries = readBrunoDiscovery(
      new ConfigReader({
        bruno: {
          discovery: [{ organization: 'acme', excludePathPattern: 'tests/[' }]
        }
      }),
      { error: (m: string) => errors.push(m) } as never
    );
    expect(entries).toEqual([]);
    expect(errors[0]).toMatch(/bruno.discovery\[0\]/);
  });

  it('skips an entry whose repositoryPattern will not compile', () => {
    // Rejected HERE rather than at match time: a pattern caught mid-sweep could
    // only be turned into "matches nothing", which deletes every entity the
    // entry had published.
    const errors: string[] = [];
    const entries = readBrunoDiscovery(
      new ConfigReader({
        bruno: {
          discovery: [{ organization: 'acme', repositoryPattern: 'pay(ments' }]
        }
      }),
      { error: (m: string) => errors.push(m) } as never
    );
    expect(entries).toEqual([]);
    expect(errors[0]).toMatch(/bruno.discovery\[0\]/);
  });
});

describe('readAllowRuntimeWrites', () => {
  // The default is the whole security posture of the two write flows, so it is
  // asserted from three directions: no config at all, a `bruno` block that
  // says nothing about it, and an explicit false. A regression that flipped it
  // would silently re-open `POST /collections` and `POST /links` on every
  // instance that never set the key.
  it('is off unless it is turned on', () => {
    expect(readAllowRuntimeWrites(new ConfigReader({}))).toBe(false);
    expect(readAllowRuntimeWrites(new ConfigReader({ bruno: {} }))).toBe(false);
    expect(
      readAllowRuntimeWrites(
        new ConfigReader({ bruno: { allowRuntimeWrites: false } })
      )
    ).toBe(false);
  });

  it('is on when it is turned on', () => {
    expect(
      readAllowRuntimeWrites(
        new ConfigReader({ bruno: { allowRuntimeWrites: true } })
      )
    ).toBe(true);
  });
});
