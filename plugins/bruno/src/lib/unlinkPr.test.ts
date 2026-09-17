import { parseGitHubDescriptorUrl } from './unlinkPr';

/**
 * The host is the whole point of these cases. Every field here feeds a GitHub
 * call or the dialog's "this is the repository" line, and a `repoUrl` pinned to
 * github.com is what sent a GitHub Enterprise user's pull request at the public
 * API — the flow reached the token-consent popup and then 404'd on a repository
 * that exists.
 */
describe('parseGitHubDescriptorUrl', () => {
  it.each([
    [
      'https://github.com/acme/apis/blob/main/collections/payments/catalog-info.yaml',
      'https://github.com/acme/apis',
      'collections/payments/catalog-info.yaml'
    ],
    // GitHub Enterprise, including one on a non-default port: the origin has to
    // survive intact, port and all.
    [
      'https://github.acme.internal/acme/apis/blob/main/catalog-info.yaml',
      'https://github.acme.internal/acme/apis',
      'catalog-info.yaml'
    ],
    [
      'https://github.acme.internal:8443/acme/apis/blob/main/catalog-info.yaml',
      'https://github.acme.internal:8443/acme/apis',
      'catalog-info.yaml'
    ],
    // `raw` shows up in hand-written locations, `tree` in copied browser URLs.
    [
      'https://github.acme.internal/acme/apis/raw/main/apis/catalog-info.yaml',
      'https://github.acme.internal/acme/apis',
      'apis/catalog-info.yaml'
    ],
    [
      'https://github.com/acme/apis/tree/feature%2Fx/catalog-info.yaml',
      'https://github.com/acme/apis',
      'catalog-info.yaml'
    ]
  ])('reads %s', (url, expectedRepoUrl, expectedPath) => {
    expect(parseGitHubDescriptorUrl(url)).toEqual({
      repoUrl: expectedRepoUrl,
      owner: 'acme',
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
    expect(parseGitHubDescriptorUrl(url)).toBeUndefined();
  });
});
