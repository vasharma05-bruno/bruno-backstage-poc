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
import type { CollectionSnapshot, ManifestProbe } from '../service/manifestProbe';
import type { BrunoEntity } from '../types';

const SOURCE_LOCATION_ANNOTATION = 'backstage.io/source-location';
/** Why `spec.definition` is absent, and how big it would have been. Both values
 *  are pure functions of the collection's content, so stamping them cannot churn
 *  `resultHash`. The `bruno.dev/*` prefix matches the keys already in use.
 *  Exported because the docs route reads them back to explain an entity with no
 *  document to render — one definition of the keys, not two. */
export const DEFINITION_OMITTED_ANNOTATION = 'bruno.dev/definition-omitted';
export const DEFINITION_BYTES_ANNOTATION = 'bruno.dev/definition-bytes';

/**
 * How this collection came to be in the catalog — the one thing the UI cannot
 * work out for itself, and the thing that decides what an operator has to edit
 * to change it.
 *
 * Before this annotation existed the frontend guessed, by asking whether
 * `backstage.io/managed-by-location` ended in `.yaml`: a descriptor is a YAML
 * file, and the provider stamps a folder. That guess is right for every case we
 * ship, and wrong for two we cannot rule out — a descriptor served from a URL
 * with no YAML suffix, and a collection onboarded through the Bruno UI, which
 * produces a descriptor indistinguishable from a hand-written one. Recording the
 * fact at ingestion removes the guess from both.
 *
 * Safe to stamp: the value is a pure function of how the entity was created and
 * never changes for a given entity, so unlike a source commit sha it cannot
 * churn `resultHash` (BE-P2 §8 Q4). See `deriveOrigin` for who sets what.
 */
export const ORIGIN_ANNOTATION = 'bruno.dev/origin';

/**
 * - `config` — a `bruno.collections[]` entry in `app-config.yaml`. Stamped by
 *   `BrunoCollectionEntityProvider`; there is no descriptor file anywhere.
 * - `ui` — onboarded through the Bruno plugin, which opened a pull request for
 *   the `catalog-info.yaml` and wrote this annotation into it.
 * - `file` — a descriptor on the Backstage host's disk (`catalog.locations` of
 *   `type: file`), which is not in an SCM and cannot take a pull request.
 * - `descriptor` — a hand-authored `catalog-info.yaml` in source control.
 *   The default, because it is the only case that needs no special handling.
 */
export type BrunoOrigin = 'descriptor' | 'config' | 'ui' | 'file';

const ORIGINS: readonly string[] = ['descriptor', 'config', 'ui', 'file'];

/**
 * The origin to stamp, preferring one already on the entity.
 *
 * An existing value always wins, and that is what makes the whole scheme work
 * with one annotation instead of three: the provider stamps `config` on the
 * unprocessed entity, the UI writes `ui` into the descriptor it generates, and
 * this processor only has to name the two cases nobody else can — a descriptor
 * on disk versus one in source control, which the location's own type already
 * distinguishes.
 *
 * An authored `catalog-info.yaml` can therefore also claim an origin it does not
 * have. That is accepted: the descriptor is the operator's own file, and a wrong
 * value costs them nothing worse than misdirected advice in a dialog.
 */
function deriveOrigin(entity: Entity, location?: LocationSpec): BrunoOrigin {
  const declared = entity.metadata.annotations?.[ORIGIN_ANNOTATION];
  if (declared && ORIGINS.includes(declared)) {
    return declared as BrunoOrigin;
  }
  return location?.type === 'file' ? 'file' : 'descriptor';
}

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
        partOf: ['api:default/github-rest-api'],
        definition: 'opencollection: 1.0.0\ninfo:\n  name: My Collection\n'
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
            },
            // Deliberately WITHOUT `minLength`, and deliberately not in
            // `spec.required` — unlike `kind: API`, which requires its
            // `definition` and constrains it to a non-empty string. A degraded
            // Bruno entity (unreachable repo, missing manifest, over the size
            // cap) has no definition to write, and a validation failure here
            // would make the processing run `ok: false`, which abandons
            // stitching and deletes the entity outright.
            definition: {
              type: 'string',
              description:
                'The generated OpenCollection YAML for the whole collection. '
                + 'Written by the processor; any authored value is overwritten. '
                + 'Absent when generation failed or the collection exceeded '
                + '`bruno.definition.maxBytes`.',
              examples: ['opencollection: 1.0.0\ninfo:\n  name: My Collection\n']
            },
            // Same reasoning as `definition`: derived, optional, and never
            // required — a degraded entity has neither and must still validate.
            requestCount: {
              type: 'integer',
              description:
                'Number of executable requests in the collection. Written by '
                + 'the processor; any authored value is overwritten.',
              minimum: 0,
              examples: [42]
            },
            environments: {
              type: 'array',
              description:
                'Names of the environments defined in the collection. Written '
                + 'by the processor; any authored value is overwritten.',
              items: { type: 'string' },
              examples: [['local', 'staging', 'prod']]
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

/** Order-sensitive equality over two optional string lists. Order matters: the
 *  parser emits environments deterministically, so a reordering is a real
 *  change and should rewrite the entity. */
function sameStrings(a?: string[], b?: string[]): boolean {
  if (a === b) {
    return true;
  }
  return (
    a !== undefined
    && b !== undefined
    && a.length === b.length
    && a.every((v, i) => v === b[i])
  );
}

/** Shallow equality over two annotation maps, for the no-change guard. */
function sameAnnotations(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
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
 * flow through this identical loop. It is also what makes Sync work at all: a
 * catalog refresh re-runs processors and never providers, so generation has to
 * live here for both entry points to converge on it.
 *
 * It also writes `spec.definition` — the whole collection's OpenCollection YAML,
 * mirroring how a `kind: API` entity stores its OpenAPI document. Note the
 * deliberate ASYMMETRY with the metadata rule above it: authored
 * `title`/`description`/`version` WIN over the fetched values, but
 * `spec.definition` is overwritten unconditionally whenever generation succeeds.
 * It is derived data — nobody hand-writes an OpenCollection document into a
 * `catalog-info.yaml` — and letting a stale authored value win would make Sync a
 * permanent no-op. When generation fails, whatever was there is left alone.
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

  async preProcessEntity(
    entity: Entity,
    location: LocationSpec
  ): Promise<Entity> {
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

    const origin = deriveOrigin(entity, location);

    let manifest: CollectionSnapshot | undefined;
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
      return this.withDerivedAnnotations(entity, url, origin);
    }

    if (!manifest) {
      this.options.logger.error(
        `Bruno collection ${stringifyEntityRef(entity)}: no bruno.json or `
        + `opencollection.yml/.yaml found at ${url}; entity ingested without `
        + `collection metadata.`
      );
      return this.withDerivedAnnotations(entity, url, origin);
    }

    // Derived data, so no authored-value precedence applies: the processor owns
    // `spec.definition` outright (see the class comment). `undefined` here means
    // "could not generate", and the return below deliberately leaves a
    // previously-good definition in place rather than blanking it.
    const definition = manifest.definition;
    const omitted = manifest.definitionOmitted;
    // Reported even when the definition itself was omitted for size, so the
    // dashboard's counts do not go blank on the largest collections.
    const requestCount = manifest.requestCount;
    const environments = manifest.environments;

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

    // When nothing is omitted the two keys are DELETED rather than left alone,
    // so an over-cap collection that later shrinks stops claiming to be omitted.
    const nextAnnotations: Record<string, string> = {
      ...annotations,
      [SOURCE_LOCATION_ANNOTATION]: sourceLocation,
      [ORIGIN_ANNOTATION]: origin
    };
    if (omitted) {
      nextAnnotations[DEFINITION_OMITTED_ANNOTATION] = omitted;
      nextAnnotations[DEFINITION_BYTES_ANNOTATION] = String(
        manifest.definitionBytes
      );
    } else {
      delete nextAnnotations[DEFINITION_OMITTED_ANNOTATION];
      delete nextAnnotations[DEFINITION_BYTES_ANNOTATION];
    }

    // Nothing to enrich: hand back the input untouched rather than allocating
    // an identical copy. Note this is an allocation guard, not a correctness
    // one — the engine's no-change detection hashes the serialized result, not
    // object identity, so the outcome is the same either way. Processing always
    // restarts from the unprocessed entity, so for an authored descriptor that
    // omits title/description/version this branch is never taken.
    if (
      title === meta.title
      && description === meta.description
      && version === meta.version
      && sourceLocation === existingSourceLocation
      && definition === (entity as BrunoEntity).spec.definition
      && requestCount === (entity as BrunoEntity).spec.requestCount
      && sameStrings(environments, (entity as BrunoEntity).spec.environments)
      && sameAnnotations(annotations, nextAnnotations)
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
        annotations: nextAnnotations
      },
      spec: {
        ...(entity as BrunoEntity).spec,
        // Only written when generation succeeded. A transient failure — an
        // unreachable host, a parse error on one bad push — must not blank a
        // definition that was good a cycle ago. Same for the two counts.
        ...(definition !== undefined && { definition }),
        ...(requestCount !== undefined && { requestCount }),
        ...(environments !== undefined && { environments })
      }
    };
  }

  /**
   * Stamps the two annotations that do not depend on a successful fetch —
   * `backstage.io/source-location` and `bruno.dev/origin` — returning the same
   * reference when there is nothing to add so `resultHash` stays stable.
   *
   * This is the DEGRADED path: an unreachable repo, or one with no manifest.
   * Both annotations are stamped here anyway, because a degraded collection is
   * exactly the one whose operator needs to know where to click through to and
   * which file to fix.
   *
   * `normalize` parses the URL and throws on a malformed one. That throw is
   * swallowed here on purpose: the probe has already logged the real problem,
   * and letting it escape `preProcessEntity` would make the run `ok: false` and
   * drop the entity. The origin is still stamped in that case — it does not
   * depend on the URL parsing.
   */
  private withDerivedAnnotations(
    entity: Entity,
    url: string,
    origin: BrunoOrigin
  ): Entity {
    const annotations = entity.metadata.annotations ?? {};

    let sourceLocation: string | undefined
      = annotations[SOURCE_LOCATION_ANNOTATION];
    if (!sourceLocation) {
      try {
        sourceLocation = `url:${this.options.probe.normalize(url)}/`;
      } catch {
        sourceLocation = undefined;
      }
    }

    if (
      annotations[ORIGIN_ANNOTATION] === origin
      && sourceLocation === annotations[SOURCE_LOCATION_ANNOTATION]
    ) {
      return entity;
    }

    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: {
          ...annotations,
          ...(sourceLocation && {
            [SOURCE_LOCATION_ANNOTATION]: sourceLocation
          }),
          [ORIGIN_ANNOTATION]: origin
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
          + `unparseable spec.partOf entry "${ref}": ${String((e as Error)?.message ?? e)}`
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
