import type { LoggerService } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import { createGithubCollectionDiscovery } from './githubDiscovery';
import type {
  DiscoveryRepo,
  GithubDiscoveryClient
} from './types';

function logger(): LoggerService {
  const noop = (): void => {};
  const self: LoggerService = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => self
  };
  return self;
}

function repo(partial: Partial<DiscoveryRepo> & { name: string }): DiscoveryRepo {
  return {
    owner: 'acme',
    fullName: `acme/${partial.name}`,
    htmlUrl: `https://github.com/acme/${partial.name}`,
    defaultBranch: 'main',
    pushedAt: '2026-09-01T00:00:00Z',
    archived: false,
    empty: false,
    ...partial
  };
}

/** A client over in-memory fixtures, counting the calls each test asserts on. */
function fakeClient(fixtures: {
  repos: DiscoveryRepo[];
  trees?: Record<string, string[]>;
  files?: Record<string, string>;
  failTreeFor?: Set<string>;
  /** Repositories whose tree listing comes back capped by the host. */
  truncatedFor?: Set<string>;
  failListing?: boolean;
}): GithubDiscoveryClient & { treeCalls: string[] } {
  const treeCalls: string[] = [];
  return {
    treeCalls,
    async listRepositories() {
      if (fixtures.failListing) {
        throw new Error('403 rate limited');
      }
      return fixtures.repos;
    },
    async listTree({ owner, repo: name }) {
      const fullName = `${owner}/${name}`;
      treeCalls.push(fullName);
      if (fixtures.failTreeFor?.has(fullName)) {
        throw new Error('500 upstream');
      }
      return {
        paths: fixtures.trees?.[fullName] ?? [],
        truncated: fixtures.truncatedFor?.has(fullName) ?? false
      };
    },
    async readTextFile({ owner, repo: name, path }) {
      return fixtures.files?.[`${owner}/${name}/${path}`];
    }
  };
}

function discoveryFor(
  client: GithubDiscoveryClient,
  entry: Partial<Parameters<typeof createGithubCollectionDiscovery>[0]['entries'][number]> = {}
) {
  return createGithubCollectionDiscovery({
    config: new ConfigReader({}),
    logger: logger(),
    client,
    entries: [
      {
        host: 'github.com',
        organization: 'acme',
        deferToCatalogInfo: true,
        ...entry
      }
    ]
  });
}

describe('createGithubCollectionDiscovery', () => {
  it('emits a collection per manifest root, with repo-qualified names', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'payments' })],
      trees: {
        'acme/payments': [
          'bruno.json',
          'ping.bru',
          'apis/orders/opencollection.yml'
        ]
      }
    });

    const swept = await discoveryFor(client, {
      owner: 'group:default/guests'
    }).discover();
    expect(swept.collections).toEqual([
      {
        // A root collection composes to the bare repo URL: the URL grammar
        // has nowhere to put a ref with an empty subpath.
        url: 'https://github.com/acme/payments',
        name: 'payments',
        owner: 'group:default/guests',
        repository: 'acme/payments'
      },
      {
        url: 'https://github.com/acme/payments/tree/main/apis/orders',
        name: 'payments-apis-orders',
        owner: 'group:default/guests',
        repository: 'acme/payments'
      }
    ]);
    // The clean-sweep half of the strip's render-nothing contract: with no
    // repository capped there is nothing to report, and the dashboard shows no
    // strip at all.
    expect(swept.incomplete).toEqual([]);
  });

  it('emits nothing for a repository with no manifest', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'website' })],
      trees: { 'acme/website': ['README.md', 'index.html'] }
    });
    await expect(discoveryFor(client).discover()).resolves.toMatchObject({
      collections: [],
      incomplete: []
    });
  });

  it('skips archived and empty repositories without reading their trees', async () => {
    const client = fakeClient({
      repos: [
        repo({ name: 'old', archived: true }),
        repo({ name: 'fresh', empty: true }),
        repo({ name: 'live' })
      ],
      trees: { 'acme/live': ['bruno.json'] }
    });

    const { collections } = await discoveryFor(client).discover();
    expect(collections.map((c) => c.name)).toEqual(['live']);
    expect(client.treeCalls).toEqual(['acme/live']);
  });

  it('anchors repositoryPattern against the repository name', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'payments' }), repo({ name: 'payments-legacy' })],
      trees: {
        'acme/payments': ['bruno.json'],
        'acme/payments-legacy': ['bruno.json']
      }
    });

    const { collections } = await discoveryFor(client, {
      repositoryPattern: 'payments'
    }).discover();
    expect(collections.map((c) => c.name)).toEqual(['payments']);
  });

  it('excludes collection paths matching excludePathPattern', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'oauth1' })],
      trees: {
        'acme/oauth1': [
          'bruno.json',
          'tests/fixtures/bru/bruno.json',
          'tests/fixtures/yml/opencollection.yml'
        ]
      }
    });

    const { collections } = await discoveryFor(client, {
      excludePathPattern: '(tests|examples)/.*'
    }).discover();
    expect(collections.map((c) => c.name)).toEqual(['oauth1']);
  });

  it('anchors excludePathPattern, so it cannot match a prefix by accident', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'a' })],
      trees: { 'acme/a': ['tests-helpers/bruno.json'] }
    });

    const { collections } = await discoveryFor(client, {
      excludePathPattern: 'tests'
    }).discover();
    expect(collections.map((c) => c.name)).toEqual(['a-tests-helpers']);
  });

  it('re-reads only the repositories whose pushed_at moved', async () => {
    const repos = [repo({ name: 'a' }), repo({ name: 'b' })];
    const client = fakeClient({
      repos,
      trees: { 'acme/a': ['bruno.json'], 'acme/b': ['bruno.json'] }
    });
    const discovery = discoveryFor(client);

    const first = await discovery.discover();
    expect(client.treeCalls).toEqual(['acme/a', 'acme/b']);

    repos[1].pushedAt = '2026-09-02T00:00:00Z';
    const second = await discovery.discover();

    expect(client.treeCalls).toEqual(['acme/a', 'acme/b', 'acme/b']);
    expect(second.collections).toEqual(first.collections);
  });

  it('re-reads a repository whose default branch was renamed', async () => {
    const repos = [repo({ name: 'a' })];
    const client = fakeClient({ repos, trees: { 'acme/a': ['col/bruno.json'] } });
    const discovery = discoveryFor(client);

    await discovery.discover();
    repos[0].defaultBranch = 'trunk';
    const second = await discovery.discover();

    expect(client.treeCalls).toEqual(['acme/a', 'acme/a']);
    expect(second.collections[0].url).toBe(
      'https://github.com/acme/a/tree/trunk/col'
    );
  });

  it('leaves a collection declared by a kind: Bruno descriptor alone', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'payments' })],
      trees: { 'acme/payments': ['bruno.json', 'catalog-info.yaml'] },
      files: {
        'acme/payments/catalog-info.yaml':
          'apiVersion: usebruno.com/v1alpha1\nkind: Bruno\n'
      }
    });
    await expect(discoveryFor(client).discover()).resolves.toMatchObject({
      collections: []
    });
  });

  it('discovers past a descriptor that declares something else', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'payments' })],
      trees: { 'acme/payments': ['bruno.json', 'catalog-info.yaml'] },
      files: {
        'acme/payments/catalog-info.yaml': 'kind: Component\n'
      }
    });
    const { collections } = await discoveryFor(client).discover();
    expect(collections.map((c) => c.name)).toEqual(['payments']);
  });

  it('discovers past a Bruno descriptor when deferral is off', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'payments' })],
      trees: { 'acme/payments': ['bruno.json', 'catalog-info.yaml'] },
      files: { 'acme/payments/catalog-info.yaml': 'kind: Bruno\n' }
    });
    const { collections } = await discoveryFor(client, {
      deferToCatalogInfo: false
    }).discover();
    expect(collections.map((c) => c.name)).toEqual(['payments']);
  });

  it('throws when a repository cannot be read on the first sweep', async () => {
    // Nothing is known about what that repository publishes, and the caller
    // applies a `full` mutation — so "unknown" must not be answered with a
    // short list.
    const client = fakeClient({
      repos: [repo({ name: 'a' })],
      failTreeFor: new Set(['acme/a'])
    });
    await expect(discoveryFor(client).discover()).rejects.toThrow(
      /could not read acme\/a on the first sweep/
    );
  });

  it('keeps the last known collections when a re-read fails', async () => {
    const repos = [repo({ name: 'a' })];
    const failTreeFor = new Set<string>();
    const client = fakeClient({
      repos,
      trees: { 'acme/a': ['bruno.json'] },
      failTreeFor
    });
    const discovery = discoveryFor(client);

    const first = await discovery.discover();
    repos[0].pushedAt = '2026-09-03T00:00:00Z';
    failTreeFor.add('acme/a');

    await expect(discovery.discover()).resolves.toMatchObject({
      collections: first.collections
    });
  });

  it('skips a repository that is new since the last successful sweep', async () => {
    const repos = [repo({ name: 'a' })];
    const failTreeFor = new Set<string>();
    const client = fakeClient({
      repos,
      trees: { 'acme/a': ['bruno.json'] },
      failTreeFor
    });
    const discovery = discoveryFor(client);

    const first = await discovery.discover();
    repos.push(repo({ name: 'b' }));
    failTreeFor.add('acme/b');

    // `b` has never been swept, so it has published nothing and skipping it
    // deletes nothing — unlike the first-sweep case above.
    await expect(discovery.discover()).resolves.toMatchObject({
      collections: first.collections
    });
  });

  it('propagates a failure to list the organization', async () => {
    const client = fakeClient({ repos: [], failListing: true });
    await expect(discoveryFor(client).discover()).rejects.toThrow(
      '403 rate limited'
    );
  });

  it('forgets a repository that stopped matching', async () => {
    const repos = [repo({ name: 'a' }), repo({ name: 'b' })];
    const client = fakeClient({
      repos,
      trees: { 'acme/a': ['bruno.json'], 'acme/b': ['bruno.json'] }
    });
    const discovery = discoveryFor(client);

    await discovery.discover();
    repos.pop();
    await expect(discovery.discover()).resolves.toMatchObject({
      collections: [
        {
          url: 'https://github.com/acme/a',
          name: 'a',
          owner: undefined,
          repository: 'acme/a'
        }
      ]
    });
  });

  /**
   * THE ASSERTION THAT MATTERS is the second one. A capped listing is a
   * repository that was read SUCCESSFULLY and answered partially, which is a
   * different fact from one that could not be read at all — so the collections
   * it did yield must still reach the catalog. Dropping them would turn a
   * repository that is missing some collections into one that is missing all of
   * them, and under the caller's `full` mutation that is a deletion.
   */
  it('reports a capped listing and still emits what it found there', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'monorepo' }), repo({ name: 'small' })],
      trees: {
        'acme/monorepo': ['bruno.json', 'apis/orders/bruno.json'],
        'acme/small': ['bruno.json']
      },
      truncatedFor: new Set(['acme/monorepo'])
    });

    const swept = await discoveryFor(client).discover();

    expect(swept.incomplete).toEqual([
      {
        repository: 'acme/monorepo',
        host: 'github.com',
        found: 2,
        reason: 'listing-limit'
      }
    ]);
    expect(swept.collections.map((c) => c.name)).toEqual([
      'monorepo',
      'monorepo-apis-orders',
      'small'
    ]);
    expect(swept.sweptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * A repository nobody has pushed to is served from the cache and never
   * re-listed, so the cap is never observed again — but the collections it cost
   * are still missing. A report that quietly stopped naming it would read as
   * the problem having gone away.
   */
  it('keeps reporting a capped repository on a cached tick', async () => {
    const client = fakeClient({
      repos: [repo({ name: 'monorepo' })],
      trees: { 'acme/monorepo': ['bruno.json'] },
      truncatedFor: new Set(['acme/monorepo'])
    });
    const discovery = discoveryFor(client);

    await discovery.discover();
    const second = await discovery.discover();

    expect(client.treeCalls).toEqual(['acme/monorepo']);
    expect(second.incomplete).toEqual([
      {
        repository: 'acme/monorepo',
        host: 'github.com',
        found: 1,
        reason: 'listing-limit'
      }
    ]);
  });
});
