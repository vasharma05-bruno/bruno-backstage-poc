import type { Entity } from '@backstage/catalog-model';
import {
  BRUNO_ORIGIN_ANNOTATION,
  BRUNO_RUNTIME_PART_OF_ANNOTATION,
  descriptorLocation,
  linkSource,
  runtimePartOfRefs
} from './brunoEntity';

function collection(input?: {
  partOf?: string[];
  runtime?: string;
}): Entity {
  return {
    apiVersion: 'usebruno.com/v1alpha1',
    kind: 'Bruno',
    metadata: {
      name: 'payments',
      ...(input?.runtime !== undefined && {
        annotations: {
          [BRUNO_RUNTIME_PART_OF_ANNOTATION]: input.runtime
        }
      })
    },
    spec: {
      type: 'bruno-collection',
      url: 'https://github.com/acme/apis/tree/main/collections/payments',
      ...(input?.partOf && { partOf: input.partOf })
    }
  } as Entity;
}

describe('runtimePartOfRefs', () => {
  it('is empty for an entity the processor has not stamped', () => {
    expect(runtimePartOfRefs(collection())).toEqual([]);
    expect(runtimePartOfRefs(collection({ runtime: '' }))).toEqual([]);
  });

  it('splits the list and drops the gaps', () => {
    expect(
      runtimePartOfRefs(
        collection({ runtime: 'api:default/a, api:default/b,,api:default/a' })
      )
    ).toEqual(['api:default/a', 'api:default/b']);
  });
});

/**
 * The entity as an ingester actually emits it: an origin and a
 * `managed-by-location`, which together are the whole input to
 * `descriptorLocation`.
 */
function located(origin: string | undefined, location: string): Entity {
  return {
    apiVersion: 'usebruno.com/v1alpha1',
    kind: 'Bruno',
    metadata: {
      name: 'payments',
      annotations: {
        'backstage.io/managed-by-location': location,
        ...(origin !== undefined && { [BRUNO_ORIGIN_ANNOTATION]: origin })
      }
    },
    spec: { type: 'bruno-collection', url: 'https://github.com/acme/apis' }
  } as Entity;
}

describe('descriptorLocation', () => {
  const descriptor
    = 'url:https://github.com/acme/apis/blob/main/catalog-info.yaml';
  const folder = 'url:https://github.com/acme/apis/tree/main/payments';

  it('names the descriptor for an authored catalog-info.yaml', () => {
    expect(descriptorLocation(located('descriptor', descriptor))).toEqual({
      kind: 'url',
      target: 'https://github.com/acme/apis/blob/main/catalog-info.yaml'
    });
  });

  it('has no descriptor for a collection added from the Bruno dashboard', () => {
    // The regression this guards: `ui` was grouped with `descriptor`, so the
    // link and unlink dialogs were handed the COLLECTION FOLDER the provider
    // stamps for a store row and offered a pull request against it.
    expect(descriptorLocation(located('ui', folder))).toEqual({
      kind: 'none',
      reason: 'ui'
    });
  });

  it('has no descriptor for the provider, discovery or a file', () => {
    expect(descriptorLocation(located('config', folder)))
      .toEqual({ kind: 'none', reason: 'provider' });
    expect(descriptorLocation(located('discovery', folder)))
      .toEqual({ kind: 'none', reason: 'discovery' });
    expect(descriptorLocation(located('file', 'file:/etc/bruno.yaml')))
      .toEqual({ kind: 'none', reason: 'file' });
  });

  it('falls back to the location shape for an unstamped entity', () => {
    // No origin at all — an older backend, or the window before the first
    // processing run. A YAML location is a descriptor; a folder cannot be one,
    // and reads as the provider's, which is the same "no descriptor" answer.
    expect(descriptorLocation(located(undefined, descriptor))).toEqual({
      kind: 'url',
      target: 'https://github.com/acme/apis/blob/main/catalog-info.yaml'
    });
    expect(descriptorLocation(located(undefined, folder)))
      .toEqual({ kind: 'none', reason: 'provider' });
  });

  it('reports an absent location rather than throwing', () => {
    expect(
      descriptorLocation({
        apiVersion: 'usebruno.com/v1alpha1',
        kind: 'Bruno',
        metadata: { name: 'payments' },
        spec: { type: 'bruno-collection', url: 'https://github.com/acme/apis' }
      } as Entity)
    ).toEqual({ kind: 'none', reason: 'absent' });
  });
});

describe('linkSource', () => {
  it('reports a descriptor-declared link', () => {
    expect(
      linkSource(collection({ partOf: ['api:default/orders'] }), 'api:default/orders')
    ).toBe('descriptor');
  });

  it('reports a runtime link', () => {
    expect(
      linkSource(collection({ runtime: 'api:default/orders' }), 'api:default/orders')
    ).toBe('runtime');
  });

  it('reports both when the descriptor grew an entry a runtime link covered', () => {
    // `POST /links` refuses to create this state, so reaching it means somebody
    // edited the descriptor afterwards. The relation then survives removing
    // either half alone, which is what the Unlink dialog has to say out loud.
    expect(
      linkSource(
        collection({
          partOf: ['api:default/orders'],
          runtime: 'api:default/orders'
        }),
        'api:default/orders'
      )
    ).toBe('both');
  });

  it('reports none for an API that is not linked', () => {
    expect(
      linkSource(collection({ partOf: ['api:default/orders'] }), 'api:default/other')
    ).toBe('none');
  });

  it('matches across the three ways a ref can be spelled', () => {
    // `spec.partOf` is written by hand, so all of these key the same relation —
    // and the same normalisation runs on the backend before a link row is
    // written. A drift between the two makes a link invisible to the dialog
    // that offers to remove it.
    for (const declared of [
      'orders',
      'api:orders',
      'api:default/orders',
      'API:Default/Orders'
    ]) {
      expect(linkSource(collection({ partOf: [declared] }), 'api:default/orders'))
        .toBe('descriptor');
    }
    expect(linkSource(collection({ runtime: 'orders' }), 'api:default/orders'))
      .toBe('runtime');
  });

  it('ignores an entry no ref parser can read', () => {
    expect(
      linkSource(collection({ partOf: ['api:default/'] }), 'api:default/orders')
    ).toBe('none');
    expect(linkSource(collection({ partOf: ['api:default/orders'] }), '/nope'))
      .toBe('none');
  });
});
