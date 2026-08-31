import { ANNOTATION_LOCATION } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';

/**
 * Read-only accessors for `kind: Bruno` entities.
 *
 * This is the entity-model layer that replaces `lib/annotations.ts`: with the
 * collection modelled as a first-class entity, everything the UI needs lives in
 * `spec` (or in one platform annotation), so nothing here has to ask the
 * backend. Pure functions on purpose — no React, no API — so the cards, the
 * header and the dashboard can all share one reading of the entity.
 *
 * Every accessor is total: an entity that has not been processed yet (or one of
 * a foreign kind that slipped through a filter) returns `undefined`/`[]` rather
 * than throwing. The catalog hands us whatever the last successful stitch
 * produced, and the fields the processor writes appear a cycle later than the
 * entity itself.
 *
 * Mirrors `BrunoEntity['spec']` in plugins/bruno-backend/src/types.ts — keep the
 * two in step.
 */

/** The `spec` of a `kind: Bruno` entity. */
export interface BrunoEntitySpec {
  /** The type of Bruno entity, e.g. `bruno-collection`. */
  type: string;
  /** Entity reference to the owner; defaults to a Group when unprefixed. */
  owner?: string;
  /** Git URL of the collection folder. Required — it is what gets fetched. */
  url: string;
  /** Entity references to API entities this collection is part of. */
  partOf?: string[];
  /** The generated OpenCollection YAML. Written by `BrunoKindProcessor`. */
  definition?: string;
  /** Executable requests in the collection. Written by `BrunoKindProcessor`. */
  requestCount?: number;
  /** Environment names. Written by `BrunoKindProcessor`. */
  environments?: string[];
}

/**
 * The catalog facet keys for the two derived numbers the dashboard aggregates.
 *
 * Named here rather than spelled inline at the call site because the coupling to
 * the backend's field names is otherwise silent: rename `spec.requestCount` on
 * the processor and the tile shows `—` with no error anywhere (BE-UI R4). One
 * place to change, one place to grep.
 */
export const BRUNO_REQUEST_COUNT_FIELD = 'spec.requestCount';
export const BRUNO_ENVIRONMENTS_FIELD = 'spec.environments';

/**
 * Stamped by `BrunoKindProcessor` when the generated OpenCollection document was
 * too large to store on the entity (`bruno.definition.maxBytes`). Its presence
 * is the difference between "this collection has no docs yet" and "the docs
 * exist but were left off the entity", and the two need different UI copy.
 */
export const BRUNO_DEFINITION_OMITTED_ANNOTATION = 'bruno.dev/definition-omitted';
/** How big the omitted definition would have been, in bytes (a string). */
export const BRUNO_DEFINITION_BYTES_ANNOTATION = 'bruno.dev/definition-bytes';

/** Whether this entity is a Bruno collection. Kind comparison is case-insensitive. */
export function isBrunoEntity(entity: Entity): boolean {
  return entity.kind.toLocaleLowerCase('en-US') === 'bruno';
}

/**
 * The entity's Bruno `spec`, never throwing.
 *
 * `Entity['spec']` is `JsonObject | undefined`, so every field has to be
 * narrowed anyway; doing it once here keeps the casts out of the components.
 */
export function brunoSpec(entity: Entity): BrunoEntitySpec {
  return (entity.spec ?? {}) as unknown as BrunoEntitySpec;
}

/** `spec.url` — the collection folder in source control. */
export function sourceUrl(entity: Entity): string | undefined {
  const url = brunoSpec(entity).url;
  return typeof url === 'string' && url ? url : undefined;
}

/**
 * `metadata.version`, coerced to a string.
 *
 * Not a schema-recognised `EntityMeta` field: it survives only because
 * `EntityMeta.schema.json` is `additionalProperties: true`, and nothing native
 * renders it. Our header does (BE-UI R7).
 */
export function version(entity: Entity): string | undefined {
  const raw = (entity.metadata as { version?: unknown }).version;
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  return String(raw);
}

/** `spec.partOf`, deduped and stripped of non-string junk. */
export function partOfRefs(entity: Entity): string[] {
  const refs = brunoSpec(entity).partOf;
  if (!Array.isArray(refs)) {
    return [];
  }
  return [...new Set(refs.filter((r): r is string => typeof r === 'string' && !!r))];
}

/** `spec.environments` — the collection's environment names. */
export function environments(entity: Entity): string[] {
  const envs = brunoSpec(entity).environments;
  if (!Array.isArray(envs)) {
    return [];
  }
  return envs.filter((e): e is string => typeof e === 'string');
}

/**
 * Whether the processor has written `spec.environments` at all. An empty array
 * ("this collection defines no environments") and an absent key ("the collection
 * has not been read yet") are different states with different copy.
 */
export function hasEnvironments(entity: Entity): boolean {
  return Array.isArray(brunoSpec(entity).environments);
}

/** `spec.requestCount` — executable requests in the collection. */
export function requestCount(entity: Entity): number | undefined {
  const count = brunoSpec(entity).requestCount;
  return typeof count === 'number' ? count : undefined;
}

/** `spec.definition` — the generated OpenCollection YAML, when it was stored. */
export function definition(entity: Entity): string | undefined {
  const def = brunoSpec(entity).definition;
  return typeof def === 'string' && def ? def : undefined;
}

/** The reason `spec.definition` is absent, when the processor recorded one. */
export function definitionOmittedReason(entity: Entity): string | undefined {
  return entity.metadata.annotations?.[BRUNO_DEFINITION_OMITTED_ANNOTATION];
}

/** How large the omitted definition would have been, as a display string. */
export function definitionOmittedBytes(entity: Entity): string | undefined {
  return entity.metadata.annotations?.[BRUNO_DEFINITION_BYTES_ANNOTATION];
}

/** Where the `catalog-info.yaml` describing this entity lives, if anywhere. */
export type DescriptorLocation
  = | { kind: 'url'; target: string }
    | { kind: 'none'; reason: 'provider' | 'file' | 'absent' };

/**
 * Resolves the descriptor file this entity was read from.
 *
 * Reads `backstage.io/managed-by-location` and NOT
 * `backstage.io/source-location`: `BrunoKindProcessor` stamps `source-location`
 * to the COLLECTION FOLDER, so `getEntitySourceLocation` points at the folder of
 * `.bru` files rather than at the YAML that declares the entity. Editing
 * `spec.partOf` means editing the descriptor, so the descriptor is what we have
 * to name.
 *
 * The three "none" reasons are all real and all need different copy:
 *  - `provider` — a `url:` location that is not a YAML file, i.e. the collection
 *    folder stamped by `BrunoCollectionEntityProvider` for a `bruno.collections[]`
 *    entry. There is no file to edit; the operator edits `app-config.yaml`.
 *  - `file` — a `file:` location (this repo's `examples/bruno-entity.yaml`). The
 *    file is on the Backstage host's disk, not in an SCM we can open a PR against.
 *  - `absent` — no location annotation at all, which should not happen for a
 *    stitched entity but must not crash a dialog.
 */
export function descriptorLocation(entity: Entity): DescriptorLocation {
  const location = entity.metadata.annotations?.[ANNOTATION_LOCATION];
  if (!location) {
    return { kind: 'none', reason: 'absent' };
  }
  if (location.startsWith('file:')) {
    return { kind: 'none', reason: 'file' };
  }
  if (!location.startsWith('url:')) {
    return { kind: 'none', reason: 'absent' };
  }
  const target = location.slice('url:'.length);
  // A descriptor is a YAML document; anything else under `url:` is a folder —
  // which for us means the provider stamped the collection root.
  const lastSegment = target.split('?')[0].split('#')[0].split('/').pop() ?? '';
  const isDescriptor
    = lastSegment.endsWith('.yaml') || lastSegment.endsWith('.yml');
  return isDescriptor
    ? { kind: 'url', target }
    : { kind: 'none', reason: 'provider' };
}
