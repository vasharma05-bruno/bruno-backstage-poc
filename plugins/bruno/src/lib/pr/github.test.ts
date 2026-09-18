import { createGithubPrAdapter } from './github';

/**
 * The host is the whole point of these cases. Every field here feeds a GitHub
 * call or the dialog's "this is the repository" line, and a `repoUrl` pinned to
 * github.com is what sent a GitHub Enterprise user's pull request at the public
 * API — the flow reached the token-consent popup and then 404'd on a repository
 * that exists.
 *
 * No network: parsing and URL construction are the whole surface under test,
 * and the token is a placeholder that is never spent.
 */
const adapter = createGithubPrAdapter({ token: 'unused' });

describe('github parseDescriptorUrl', () => {
  it.each([
    [
      'https://github.com/acme/apis/blob/main/collections/payments/catalog-info.yaml',
      'https://github.com',
      'collections/payments/catalog-info.yaml'
    ],
    // GitHub Enterprise, including one on a non-default port: the origin has to
    // survive intact, scheme and port and all.
    [
      'https://github.acme.internal/acme/apis/blob/main/catalog-info.yaml',
      'https://github.acme.internal',
      'catalog-info.yaml'
    ],
    [
      'https://github.acme.internal:8443/acme/apis/blob/main/catalog-info.yaml',
      'https://github.acme.internal:8443',
      'catalog-info.yaml'
    ],
    // `raw` shows up in hand-written locations, `tree` in copied browser URLs.
    [
      'https://github.acme.internal/acme/apis/raw/main/apis/catalog-info.yaml',
      'https://github.acme.internal',
      'apis/catalog-info.yaml'
    ],
    [
      'https://github.com/acme/apis/tree/feature%2Fx/catalog-info.yaml',
      'https://github.com',
      'catalog-info.yaml'
    ]
  ])('reads %s', (url, expectedHost, expectedPath) => {
    expect(adapter.parseDescriptorUrl(url)).toEqual({
      host: expectedHost,
      project: 'acme',
      repo: 'apis',
      path: expectedPath
    });
  });

  it.each([
    // The collection FOLDER a provider stamps, not a descriptor: no view
    // segment where one is required.
    'https://github.com/acme/apis',
    'https://github.com/acme/apis/collections/payments',
    // A view segment this flow cannot read as a file path.
    'https://github.com/acme/apis/commits/main/catalog-info.yaml',
    // A blob URL with a ref but no path below it.
    'https://github.com/acme/apis/blob/main',
    // Not a URL at all.
    'not a url'
  ])('refuses %s', (url) => {
    expect(adapter.parseDescriptorUrl(url)).toBeUndefined();
  });
});

describe('github parseRepoUrl and repoUrl', () => {
  it.each([
    ['https://github.com/acme/apis', 'https://github.com/acme/apis'],
    ['https://github.com/acme/apis.git', 'https://github.com/acme/apis'],
    [
      'https://github.acme.internal:8443/acme/apis/',
      'https://github.acme.internal:8443/acme/apis'
    ],
    // A collection folder URL reduces to the same repository, which is what the
    // add-collection flow hands it.
    [
      'https://github.com/acme/apis/tree/main/collections/payments',
      'https://github.com/acme/apis'
    ]
  ])('round-trips %s', (url, expected) => {
    const repo = adapter.parseRepoUrl(url);
    expect(repo).toBeDefined();
    expect(adapter.repoUrl(repo!)).toBe(expected);
  });

  it.each(['https://github.com/acme', 'https://github.com/', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(adapter.parseRepoUrl(url)).toBeUndefined();
    }
  );
});
