import {
  collectionPathFromUrl,
  descriptorPathForCollection,
  repoRootFromCollectionUrl
} from './scmUrl';

/**
 * These two functions have to be exact complements: whatever
 * `repoRootFromCollectionUrl` cuts off is what `collectionPathFromUrl` keeps.
 * A drift between them is what would put a generated `catalog-info.yaml` in a
 * folder of one repository while the pull request targets another, so the
 * round-trip is asserted for every shape rather than each half in isolation.
 */
describe('collectionPathFromUrl', () => {
  it.each([
    [
      'https://github.com/vasharma05-bruno/bruno-collections/tree/main/github-rest-api-collection',
      'https://github.com/vasharma05-bruno/bruno-collections',
      'github-rest-api-collection'
    ],
    [
      'https://github.com/acme/repo/tree/main/apis/payments/collection',
      'https://github.com/acme/repo',
      'apis/payments/collection'
    ],
    // Percent-decoded: the browser URL a user copies escapes the space, and the
    // path has to reach the contents API as the folder's real name.
    [
      'https://github.com/acme/repo/tree/main/my%20collection',
      'https://github.com/acme/repo',
      'my collection'
    ],
    [
      'https://gitlab.com/group/subgroup/project/-/tree/main/collections/orders',
      'https://gitlab.com/group/subgroup/project',
      'collections/orders'
    ],
    [
      'https://bitbucket.org/team/repo/src/main/collections/orders',
      'https://bitbucket.org/team/repo',
      'collections/orders'
    ]
  ])('splits %s', (url, expectedRoot, expectedPath) => {
    expect(repoRootFromCollectionUrl(url)).toBe(expectedRoot);
    expect(collectionPathFromUrl(url)).toBe(expectedPath);
  });

  it.each([
    // A bare repository URL: the collection IS the repository.
    'https://github.com/acme/repo',
    'https://gitlab.com/group/subgroup/project',
    'https://bitbucket.org/team/repo',
    // A tree URL with a ref but no path below it.
    'https://github.com/acme/repo/tree/main',
    // Not a URL at all.
    'not a url'
  ])('reports no folder for %s', (url) => {
    expect(collectionPathFromUrl(url)).toBe('');
  });
});

describe('descriptorPathForCollection', () => {
  it('puts the descriptor beside the collection', () => {
    expect(
      descriptorPathForCollection(
        'https://github.com/vasharma05-bruno/bruno-collections/tree/main/github-rest-api-collection',
        'catalog-info.yaml'
      )
    ).toBe('github-rest-api-collection/catalog-info.yaml');
  });

  it('falls back to the repository root for a whole-repo collection', () => {
    expect(
      descriptorPathForCollection(
        'https://github.com/acme/repo',
        'catalog-info.yaml'
      )
    ).toBe('catalog-info.yaml');
  });

  it('honours a re-configured entity filename', () => {
    expect(
      descriptorPathForCollection(
        'https://github.com/acme/repo/tree/main/collections/orders',
        'backstage.yaml'
      )
    ).toBe('collections/orders/backstage.yaml');
  });

  it('never emits a leading slash, which the contents API rejects', () => {
    for (const url of [
      'https://github.com/acme/repo',
      'https://github.com/acme/repo/tree/main/a/b'
    ]) {
      expect(
        descriptorPathForCollection(url, 'catalog-info.yaml')
      ).not.toMatch(/^\//);
    }
  });
});
