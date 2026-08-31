import type { LoggerService } from '@backstage/backend-plugin-api';
import type { CompoundEntityRef, Entity } from '@backstage/catalog-model';
import {
  RELATION_HAS_PART,
  RELATION_OWNED_BY,
  RELATION_OWNER_OF,
  RELATION_PART_OF,
  entityKindSchemaValidator,
  getCompoundEntityRef,
  parseEntityRef,
  stringifyEntityRef
} from '@backstage/catalog-model';
import type {
  CatalogProcessor,
  CatalogProcessorEmit,
  LocationSpec
} from '@backstage/plugin-catalog-node';
import { processingResult } from '@backstage/plugin-catalog-node';
import type { CollectionManifest, ManifestProbe } from '../service/manifestProbe';
import type { BrunoEntity } from '../types';

const SOURCE_LOCATION_ANNOTATION = 'backstage.io/source-location';

/**
 * The apiVersion the `Bruno` kind is written against — the identifier the PRD
 * mandates for Bruno's own kinds.
 *
 * Deliberately NOT `backstage.io/v1alpha1`: that namespace is reserved for
 * kinds shipped by Backstage itself, and squatting it means an upstream kind
 * named `Bruno` would silently collide with this one. No special handling is
 * needed for a non-Backstage apiVersion — the entity envelope schema only
 * requires a non-empty string.
 *
 * @public
 */
export const BRUNO_API_VERSION = 'usebruno.com/v1alpha1';

/**
 * JSON schema for `kind: Bruno`, in the shape {@link entityKindSchemaValidator}
 * expects: an `allOf` of the base `Entity` schema plus the kind's own
 * constraints. Enum mismatches on `kind`/`apiVersion` are what let the
 * validator answer "not mine" rather than throwing.
 *
 * `spec` intentionally does not set `additionalProperties: false` — extra
 * fields are forward-compatible rather than fatal.
 *
 * @public
 */
export const brunoEntityV1alpha1Schema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  $id: 'BrunoV1alpha1',
  description:
    'A Bruno API collection: a set of .bru requests, environments and docs stored in source control.',
  examples: [
    {
      apiVersion: BRUNO_API_VERSION,
      kind: 'Bruno',
      metadata: {
        name: 'my-bruno-collection',
        description: 'My sample Bruno Collection Entity'
      },
      spec: {
        type: 'bruno-collection',
        owner: 'guests',
        url: 'https://github.com/bruno-collections/github-rest-api-collection',
        partOf: ['api:default/github-rest-api']
      }
    }
  ],
  allOf: [
    { $ref: 'Entity' },
    {
      type: 'object',
      required: ['spec'],
      properties: {
        apiVersion: { enum: [BRUNO_API_VERSION] },
        kind: { enum: ['Bruno'] },
        spec: {
          type: 'object',
          required: ['type', 'url'],
          properties: {
            type: {
              type: 'string',
              description: 'The type of Bruno entity.',
              examples: ['bruno-collection'],
              minLength: 1
            },
            owner: {
              type: 'string',
              description:
                'An entity reference to the owner of the collection.',
              examples: ['guests', 'group:platform', 'user:jane.doe'],
              minLength: 1
            },
            url: {
              type: 'string',
              description:
                'Source-control URL of the collection (a tree or blob URL on a host configured under `integrations`).',
              examples: [
                'https://github.com/bruno-collections/github-rest-api-collection'
              ],
              minLength: 1
            },
            partOf: {
              type: 'array',
              description:
                'Entity references to API entities this collection is part of.',
              items: { type: 'string', minLength: 1 },
              examples: [['api:default/github-rest-api']]
            }
          }
        }
      }
    }
  ]
};

const validator = entityKindSchemaValidator<BrunoEntity>(
  brunoEntityV1alpha1Schema
);

/** Treats empty/whitespace-only strings as absent so `??` falls through. */
function keep(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Teaches the catalog about `kind: Bruno`, and enriches each such entity from
 * the collection manifest its `spec.url` points at.
 *
 * `catalog.rules` in app-config only *permits* a kind from a location; it does
 * not define one. Recognition comes from a processor whose
 * {@link validateEntityKind} claims the entity — with none, the catalog rejects
 * it as "No processor recognized the entity" and it never lands.
 *
 * Enrichment happens in `preProcessEntity` so the result is still subject to
 * the entity policies and to {@link validateEntityKind}; relations are emitted
 * from `postProcessEntity`, matching `BuiltinKindsEntityProcessor`, so no
 * relation is emitted for an entity that later fails validation.
 *
 * The same processor serves entities authored as a `catalog-info.yaml` and
 * entities emitted by the `BrunoCollectionEntityProvider` from
 * `bruno.collections[]` — provider-emitted entities are written unprocessed and
 * flow through this identical loop.
 */
export class BrunoKindProcessor implements CatalogProcessor {
  constructor(
    private readonly options: {
      logger: LoggerService;
      probe: ManifestProbe;
    }
  ) {}

  getProcessorName(): string {
    return 'BrunoKindProcessor';
  }

  async validateEntityKind(entity: Entity): Promise<boolean> {
    // Returns false on a kind/apiVersion mismatch (so other processors get
    // their turn) and throws on an entity that IS ours but is malformed.
    return validator(entity) !== false;
  }

  async preProcessEntity(entity: Entity): Promise<Entity> {
    // Runs for EVERY entity in the catalog, so the guard comes first and
    // allocates nothing.
    if (entity.kind !== 'Bruno' || entity.apiVersion !== BRUNO_API_VERSION) {
      return entity;
    }

    const url = (entity as BrunoEntity).spec?.url;
    if (!url) {
      // A shape error belongs to `validateEntityKind`, which rejects it there.
      return entity;
    }

    let manifest: CollectionManifest | undefined;
    try {
      manifest = await this.options.probe.probe(url);
    } catch (e) {
      // Degraded, NOT rejected: an error result makes the processing run
      // `ok: false`, which skips `updateProcessedEntity` and leaves stitching
      // to abandon the entity — on first ingestion it would never land at all.
      this.options.logger.error(
        `Bruno collection ${stringifyEntityRef(entity)}: could not read ${url}: ${
          String((e as Error)?.message ?? e)
        }`
      );
      // Still stamped: a degraded entity is exactly the one an operator wants
      // to click through to source in order to diagnose.
      return this.withSourceLocation(entity, url);
    }

    if (!manifest) {
      this.options.logger.error(
        `Bruno collection ${stringifyEntityRef(entity)}: no bruno.json or `
        + `opencollection.yml/.yaml found at ${url}; entity ingested without `
        + `collection metadata.`
      );
      return this.withSourceLocation(entity, url);
    }

    // Authored metadata WINS over the fetched value — the inverse of the
    // `bruno.sources` path, where config is only a fallback display name.
    // `metadata.name` is deliberately NOT in this list: the catalog freezes the
    // entity ref before any processor runs and throws a ConflictError if a
    // processor changes it (DefaultCatalogProcessingOrchestrator :52, :166).
    const meta = entity.metadata as Entity['metadata'] & { version?: unknown };
    const title = keep(meta.title) ?? manifest.name;
    const description = keep(meta.description) ?? manifest.description;
    const version = keep(meta.version) ?? manifest.version;

    const annotations = meta.annotations ?? {};
    const existingSourceLocation = annotations[SOURCE_LOCATION_ANNOTATION];
    const sourceLocation
      = existingSourceLocation ?? `url:${this.options.probe.normalize(url)}/`;

    // Returning the SAME reference keeps `resultHash` stable, so the engine
    // takes its no-change path instead of rewriting the entity every cycle.
    if (
      title === meta.title
      && description === meta.description
      && version === meta.version
      && sourceLocation === existingSourceLocation
    ) {
      return entity;
    }

    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        ...(title && { title }),
        ...(description && { description }),
        ...(version && { version }),
        annotations: {
          ...annotations,
          [SOURCE_LOCATION_ANNOTATION]: sourceLocation
        }
      }
    };
  }

  /**
   * Stamps `backstage.io/source-location` when absent, returning the same
   * reference when there is nothing to add so `resultHash` stays stable.
   *
   * `normalize` parses the URL and throws on a malformed one. That throw is
   * swallowed here on purpose: this runs on the degraded paths, where the
   * probe has already logged the real problem, and letting it escape
   * `preProcessEntity` would make the run `ok: false` and drop the entity.
   */
  private withSourceLocation(entity: Entity, url: string): Entity {
    const annotations = entity.metadata.annotations ?? {};
    if (annotations[SOURCE_LOCATION_ANNOTATION]) {
      return entity;
    }

    let normalized: string;
    try {
      normalized = this.options.probe.normalize(url);
    } catch {
      return entity;
    }

    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: {
          ...annotations,
          [SOURCE_LOCATION_ANNOTATION]: `url:${normalized}/`
        }
      }
    };
  }

  async postProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    emit: CatalogProcessorEmit
  ): Promise<Entity> {
    if (entity.apiVersion !== BRUNO_API_VERSION || entity.kind !== 'Bruno') {
      return entity;
    }

    const self = getCompoundEntityRef(entity);
    const spec = (entity as BrunoEntity).spec;

    if (spec.owner) {
      // Guarded for the same reason as `spec.partOf` below: the schema only
      // requires a non-empty string, so a ref like `group:default/a/b` reaches
      // here and throws. An unguarded throw becomes ok:false, which skips
      // updateProcessedEntity and abandons stitching — the entity would 404
      // outright rather than merely losing one relation.
      let owner: CompoundEntityRef | undefined;
      try {
        owner = parseEntityRef(spec.owner, {
          defaultKind: 'Group',
          defaultNamespace: self.namespace
        });
      } catch (e) {
        this.options.logger.warn(
          `Bruno collection ${stringifyEntityRef(entity)}: ignoring `
          + `unparseable spec.owner "${spec.owner}": ${
            String((e as Error)?.message ?? e)
          }`
        );
      }

      if (owner) {
        emit(
          processingResult.relation({
            source: self,
            type: RELATION_OWNED_BY,
            target: owner
          })
        );
        emit(
          processingResult.relation({
            source: owner,
            type: RELATION_OWNER_OF,
            target: self
          })
        );
      }
    }

    for (const ref of new Set(spec.partOf ?? [])) {
      let target: CompoundEntityRef;
      try {
        target = parseEntityRef(ref, {
          defaultKind: 'API',
          defaultNamespace: self.namespace
        });
      } catch (e) {
        // Non-fatal by design: a throw here becomes an InputError, ok:false,
        // and on first ingestion the entity never lands at all — see
        // DefaultCatalogProcessingEngine :164-194 and performStitching :57-62.
        this.options.logger.warn(
          `Bruno collection ${stringifyEntityRef(entity)}: ignoring `
          + `unparseable spec.partOf entry "${ref}": ${(e as Error).message}`
        );
        continue;
      }
      // Both directions are emitted explicitly; the catalog does not derive the
      // reverse edge.
      emit(
        processingResult.relation({
          source: self,
          type: RELATION_PART_OF,
          target
        })
      );
      emit(
        processingResult.relation({
          source: target,
          type: RELATION_HAS_PART,
          target: self
        })
      );
    }

    return entity;
  }
}
