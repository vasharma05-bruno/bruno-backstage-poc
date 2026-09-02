import {
  catalogInfoCandidates,
  collectionRootsFromPaths,
  declaresBrunoKind,
  discoveredCollectionName
} from './collectionRoots';

describe('collectionRootsFromPaths', () => {
  it('finds both manifest formats, at the root and in subfolders', () => {
    expect(
      collectionRootsFromPaths([
        'bruno.json',
        'ping.bru',
        'apis/payments/opencollection.yml',
        'apis/payments/get-balance.yml',
        'apis/orders/opencollection.yaml'
      ])
    ).toEqual(['', 'apis/orders', 'apis/payments']);
  });

  it('yields one root for a directory holding both manifests', () => {
    expect(
      collectionRootsFromPaths(['col/bruno.json', 'col/opencollection.yml'])
    ).toEqual(['col']);
  });

  it('ignores files that merely end in a manifest name', () => {
    expect(
      collectionRootsFromPaths([
        'not-bruno.json',
        'my-opencollection.yml',
        'folder.yml',
        'catalog-info.yaml'
      ])
    ).toEqual([]);
  });

  it('treats a nested manifest as its own collection', () => {
    // Bruno marks a subfolder of a collection with folder.bru/folder.yml, never
    // with bruno.json, so a nested manifest is a second collection.
    expect(
      collectionRootsFromPaths([
        'bruno.json',
        'nested/bruno.json',
        'nested/folder.yml'
      ])
    ).toEqual(['', 'nested']);
  });
});

describe('discoveredCollectionName', () => {
  it('uses the repository name for a collection at the root', () => {
    expect(discoveredCollectionName('payments-api', '')).toBe('payments-api');
  });

  it('qualifies a subfolder collection with its path', () => {
    expect(discoveredCollectionName('platform', 'apis/payments')).toBe(
      'platform-apis-payments'
    );
  });

  it('does not collide across repositories with the same folder name', () => {
    expect(discoveredCollectionName('payments', 'collection')).not.toBe(
      discoveredCollectionName('orders', 'collection')
    );
  });

  it('sanitizes characters an entity name cannot carry', () => {
    expect(discoveredCollectionName('Payments API', 'My Collection')).toBe(
      'payments-api-my-collection'
    );
  });
});

describe('catalogInfoCandidates', () => {
  it('offers the collection directory and the repository root', () => {
    expect(
      catalogInfoCandidates('apis/payments', [
        'catalog-info.yaml',
        'apis/payments/catalog-info.yaml',
        'apis/payments/bruno.json'
      ])
    ).toEqual(['apis/payments/catalog-info.yaml', 'catalog-info.yaml']);
  });

  it('offers nothing when the tree holds no descriptor', () => {
    expect(catalogInfoCandidates('', ['bruno.json'])).toEqual([]);
  });

  it('does not offer a descriptor in an unrelated directory', () => {
    expect(
      catalogInfoCandidates('apis/payments', ['apis/orders/catalog-info.yaml'])
    ).toEqual([]);
  });

  it('accepts the .yml spelling', () => {
    expect(catalogInfoCandidates('', ['catalog-info.yml'])).toEqual([
      'catalog-info.yml'
    ]);
  });
});

describe('declaresBrunoKind', () => {
  it('recognises a Bruno entity', () => {
    expect(
      declaresBrunoKind('apiVersion: usebruno.com/v1alpha1\nkind: Bruno\n')
    ).toBe(true);
  });

  it('is case-insensitive on the kind', () => {
    expect(declaresBrunoKind('kind: bruno\n')).toBe(true);
  });

  it('recognises a Bruno entity in any document of a multi-doc file', () => {
    expect(declaresBrunoKind('kind: Component\n---\nkind: Bruno\n')).toBe(true);
  });

  it('does not fire on an unrelated descriptor', () => {
    expect(declaresBrunoKind('kind: Component\nspec:\n  type: service\n')).toBe(
      false
    );
  });

  it('treats an unparseable descriptor as declaring nothing', () => {
    // Publishing the discovered entity is the recoverable direction: a
    // duplicate is visible, a collection that never appears is not.
    expect(declaresBrunoKind('kind: [Bruno\n  broken: :')).toBe(false);
  });
});
