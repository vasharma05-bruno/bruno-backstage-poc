import { ConfigReader } from '@backstage/config';
import { readBrunoDiscovery } from './brunoConfig';

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
