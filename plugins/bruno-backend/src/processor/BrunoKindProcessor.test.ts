import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import {
  RELATION_HAS_PART,
  RELATION_PART_OF
} from '@backstage/catalog-model';
import type {
  CatalogProcessorEmit,
  CatalogProcessorResult,
  LocationSpec
} from '@backstage/plugin-catalog-node';
import {
  BRUNO_API_VERSION,
  BrunoKindProcessor,
  RUNTIME_PART_OF_ANNOTATION
} from './BrunoKindProcessor';
import type { ManifestProbe } from '../service/manifestProbe';
import type { RuntimeLink, RuntimeLinkReader } from './runtimeLinks';

/**
 * A probe that finds nothing.
 *
 * Deliberately the DEGRADED path for most of these tests: a collection whose
 * repository cannot be read must still carry its runtime links, because a link
 * is a fact about the catalog rather than about the repository — and that path
 * goes through `withDerivedAnnotations` rather than through the main return, so
 * it is the one that would silently drop them.
 */
const noManifest: ManifestProbe = {
  probe: async () => undefined,
  evict: () => {},
  normalize: (url: string) => url.replace(/\/+$/, '')
};

const unreadable: ManifestProbe = {
  probe: async () => {
    throw new Error('403 from the host');
  },
  evict: () => {},
  normalize: (url: string) => url.replace(/\/+$/, '')
};

const logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => logger
} as unknown as LoggerService;

const location: LocationSpec = {
  type: 'url',
  target: 'https://github.com/acme/apis/blob/main/catalog-info.yaml'
};

function collection(overrides?: {
  partOf?: string[];
  annotations?: Record<string, string>;
}): Entity {
  return {
    apiVersion: BRUNO_API_VERSION,
    kind: 'Bruno',
    metadata: {
      name: 'payments',
      annotations: overrides?.annotations
    },
    spec: {
      type: 'bruno-collection',
      url: 'https://github.com/acme/apis/tree/main/collections/payments',
      ...(overrides?.partOf && { partOf: overrides.partOf })
    }
  } as Entity;
}

function reader(links: RuntimeLink[]): RuntimeLinkReader {
  return { list: async () => links };
}

/** Collects what `postProcessEntity` emitted, as `type:source→target` pairs. */
async function relationsOf(
  processor: BrunoKindProcessor,
  entity: Entity
): Promise<string[]> {
  const emitted: string[] = [];
  const emit: CatalogProcessorEmit = (result: CatalogProcessorResult) => {
    if (result.type === 'relation') {
      const { source, type, target } = result.relation;
      emitted.push(
        `${type}:${source.kind}/${source.name}->${target.kind}/${target.name}`
      );
    }
  };
  await processor.postProcessEntity(entity, location, emit);
  return emitted;
}

describe('BrunoKindProcessor runtime links', () => {
  it('stamps the links the backend holds for this collection', async () => {
    const processor = new BrunoKindProcessor({
      logger,
      probe: noManifest,
      runtimeLinks: reader([
        { collectionRef: 'bruno:default/payments', apiRef: 'api:default/b' },
        { collectionRef: 'bruno:default/payments', apiRef: 'api:default/a' },
        // Another collection's link must not leak onto this entity.
        { collectionRef: 'bruno:default/orders', apiRef: 'api:default/z' }
      ])
    });

    const processed = await processor.preProcessEntity(collection(), location);

    // Sorted, so re-ordering the rows in the table cannot churn `resultHash`.
    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBe('api:default/a,api:default/b');
  });

  it('carries the links through the unreadable-repository path too', async () => {
    const processor = new BrunoKindProcessor({
      logger,
      probe: unreadable,
      runtimeLinks: reader([
        { collectionRef: 'bruno:default/payments', apiRef: 'api:default/a' }
      ])
    });

    const processed = await processor.preProcessEntity(collection(), location);

    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBe('api:default/a');
  });

  it('deletes the annotation when there are no links, including an authored one', async () => {
    const processor = new BrunoKindProcessor({
      logger,
      probe: noManifest,
      runtimeLinks: reader([])
    });

    // The processor owns the key outright, the same way it owns
    // `spec.definition`: a descriptor cannot fabricate a runtime link.
    const processed = await processor.preProcessEntity(
      collection({
        annotations: { [RUNTIME_PART_OF_ANNOTATION]: 'api:default/invented' }
      }),
      location
    );

    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBeUndefined();
  });

  it('stamps nothing when no reader is wired', async () => {
    const processor = new BrunoKindProcessor({ logger, probe: noManifest });

    const processed = await processor.preProcessEntity(collection(), location);

    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBeUndefined();
  });

  it('emits the last set it read when the backend goes away', async () => {
    let fail = false;
    const processor = new BrunoKindProcessor({
      logger,
      probe: noManifest,
      runtimeLinks: {
        list: async () => {
          if (fail) {
            throw new Error('connection refused');
          }
          return [
            { collectionRef: 'bruno:default/payments', apiRef: 'api:default/a' }
          ];
        }
      }
    });

    await processor.preProcessEntity(collection(), location);
    fail = true;
    const processed = await processor.preProcessEntity(collection(), location);

    // An outage must not be read as "there are no links": the annotation would
    // be deleted, which deletes the relations.
    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBe('api:default/a');
  });

  it('emits no runtime links when the first read of the process fails', async () => {
    const processor = new BrunoKindProcessor({
      logger,
      probe: noManifest,
      runtimeLinks: {
        list: async () => {
          throw new Error('connection refused');
        }
      }
    });

    const processed = await processor.preProcessEntity(collection(), location);

    // Recoverable on the next cycle, and it never throws: a rejection out of
    // `preProcessEntity` makes the run ok:false and abandons the entity.
    expect(
      processed.metadata.annotations?.[RUNTIME_PART_OF_ANNOTATION]
    ).toBeUndefined();
  });

  it('emits both directions of the relation for a runtime link', async () => {
    const processor = new BrunoKindProcessor({ logger, probe: noManifest });

    const emitted = await relationsOf(
      processor,
      collection({
        annotations: { [RUNTIME_PART_OF_ANNOTATION]: 'api:default/orders' }
      })
    );

    expect(emitted).toEqual([
      `${RELATION_PART_OF}:Bruno/payments->api/orders`,
      `${RELATION_HAS_PART}:api/orders->Bruno/payments`
    ]);
  });

  it('emits one relation pair when the descriptor and a runtime link agree', async () => {
    const processor = new BrunoKindProcessor({ logger, probe: noManifest });

    const emitted = await relationsOf(
      processor,
      collection({
        partOf: ['api:default/orders'],
        annotations: { [RUNTIME_PART_OF_ANNOTATION]: 'api:default/orders' }
      })
    );

    expect(emitted).toEqual([
      `${RELATION_PART_OF}:Bruno/payments->api/orders`,
      `${RELATION_HAS_PART}:api/orders->Bruno/payments`
    ]);
  });

  it('emits the union of the descriptor and the runtime links', async () => {
    const processor = new BrunoKindProcessor({ logger, probe: noManifest });

    const emitted = await relationsOf(
      processor,
      collection({
        partOf: ['api:default/declared'],
        annotations: { [RUNTIME_PART_OF_ANNOTATION]: 'api:default/runtime' }
      })
    );

    expect(emitted).toEqual([
      `${RELATION_PART_OF}:Bruno/payments->api/declared`,
      `${RELATION_HAS_PART}:api/declared->Bruno/payments`,
      `${RELATION_PART_OF}:Bruno/payments->api/runtime`,
      `${RELATION_HAS_PART}:api/runtime->Bruno/payments`
    ]);
  });
});
