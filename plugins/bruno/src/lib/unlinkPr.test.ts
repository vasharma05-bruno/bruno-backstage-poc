import { partOfSnippet } from './unlinkPr';

/**
 * The floor of the whole pull-request flow: what a user on a host with no
 * adapter — Bitbucket, Gerrit, Harness — is shown instead. It has to be right
 * without a token and without a network, because that is the entire reason it
 * exists, and it is the one branch no adapter test can cover.
 *
 * `parseGitHubDescriptorUrl` used to be tested here. It moved to the GitHub
 * adapter with the rest of that forge's grammar; `pr/github.test.ts` carries
 * those cases, GitHub Enterprise host and non-default port included.
 */
describe('partOfSnippet', () => {
  it.each([
    [
      'adds to an existing list',
      'link' as const,
      ['api:default/orders'],
      ['api:default/payments'],
      'spec:\n  partOf:\n    - api:default/orders\n    - api:default/payments\n'
    ],
    [
      'creates the key for a collection that is part of nothing',
      'link' as const,
      undefined,
      ['api:default/payments'],
      'spec:\n  partOf:\n    - api:default/payments\n'
    ],
    [
      // The reference in the file is bare; the one from the catalog is full.
      // They are the same API, so this is an add, not a duplicate.
      'normalises both sides before comparing',
      'link' as const,
      ['orders'],
      ['api:default/payments'],
      'spec:\n  partOf:\n    - orders\n    - api:default/payments\n'
    ],
    [
      'removes one entry and leaves the rest',
      'unlink' as const,
      ['api:default/orders', 'api:default/payments'],
      ['api:default/payments'],
      'spec:\n  partOf:\n    - api:default/orders\n'
    ]
  ])('%s', (_name, direction, current, apiRefs, expected) => {
    expect(partOfSnippet({ direction, current, apiRefs })).toEqual({
      outcome: 'replace',
      yaml: expected
    });
  });

  it('asks for the key to be removed rather than showing an empty spec', () => {
    expect(
      partOfSnippet({
        direction: 'unlink',
        current: ['api:default/payments'],
        apiRefs: ['api:default/payments']
      })
    ).toEqual({ outcome: 'remove-key' });
  });

  it.each([
    [
      'link' as const,
      ['api:default/payments'],
      'already'
    ],
    [
      'unlink' as const,
      ['api:default/orders'],
      'not listed'
    ]
  ])(
    'explains a %s that would change nothing',
    (direction, current, fragment) => {
      const result = partOfSnippet({
        direction,
        current,
        apiRefs: ['api:default/payments']
      });
      expect(result.outcome).toBe('none');
      expect((result as { message: string }).message).toContain(fragment);
    }
  );

  it('ignores a spec.partOf that is not a list of strings', () => {
    // The entity is whatever the catalog stitched, so a malformed `partOf` must
    // degrade to "nothing is linked yet" rather than throw inside a render.
    expect(
      partOfSnippet({
        direction: 'link',
        current: { orders: true },
        apiRefs: ['api:default/payments']
      })
    ).toEqual({
      outcome: 'replace',
      yaml: 'spec:\n  partOf:\n    - api:default/payments\n'
    });
  });
});
