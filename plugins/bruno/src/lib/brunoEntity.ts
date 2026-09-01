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

/** The `spec` of a `kind: Bruno` entity. Named in `brunoSpec`'s signature,
 *  so it stays exported even though only the accessors below read it. */
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
 * Stamped by `BrunoKindProcessor` when the generated OpenCollection document was
 * too large to store on the entity (`bruno.definition.maxBytes`). Its presence
 * is the difference between "this collection has no docs yet" and "the docs
 * exist but were left off the entity", and the two need different UI copy.
 */
const BRUNO_DEFINITION_OMITTED_ANNOTATION = 'usebruno.com/definition-omitted';
/** How big the omitted definition would have been, in bytes (a string). */
const BRUNO_DEFINITION_BYTES_ANNOTATION = 'usebruno.com/definition-bytes';

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

/**
 * How the collection got into the catalog, as recorded by the backend.
 *
 * Mirrors `BrunoOrigin` in plugins/bruno-backend/src/processor/BrunoKindProcessor.ts
 * — keep the two in step. `unknown` is this side's own addition, for an entity
 * the processor has not stamped yet (annotations it writes appear a cycle after
 * the entity itself) or one ingested by an older backend.
 */
export type BrunoOrigin = 'descriptor' | 'config' | 'ui' | 'file' | 'unknown';

/** Stamped by `BrunoKindProcessor`; see its docblock for who writes what. */
export const BRUNO_ORIGIN_ANNOTATION = 'usebruno.com/origin';

const ORIGINS: readonly string[] = ['descriptor', 'config', 'ui', 'file'];

/**
 * Where this collection came from, and therefore what has to be edited to
 * change it. {@link descriptorLocation} turns this into the file to edit.
 *
 * Reads `usebruno.com/origin`, and falls back to the shape of
 * `backstage.io/managed-by-location` when it is missing — a descriptor is a
 * YAML file, and the provider stamps a folder. That fallback is the rule the UI
 * used before the annotation existed; it is kept because an entity ingested by
 * an older backend, or one stitched in the window before its first processing
 * run, carries no origin and still has to be given advice. It cannot tell `ui`
 * from `descriptor` — they are the same file, which is exactly the ambiguity
 * the annotation was added to remove.
 */
export function collectionOrigin(entity: Entity): BrunoOrigin {
  const stamped = entity.metadata.annotations?.[BRUNO_ORIGIN_ANNOTATION];
  if (stamped && ORIGINS.includes(stamped)) {
    return stamped as BrunoOrigin;
  }

  const location = entity.metadata.annotations?.[ANNOTATION_LOCATION];
  if (!location) {
    return 'unknown';
  }
  if (location.startsWith('file:')) {
    return 'file';
  }
  if (!location.startsWith('url:')) {
    return 'unknown';
  }
  const target = location.slice('url:'.length);
  const lastSegment = target.split('?')[0].split('#')[0].split('/').pop() ?? '';
  return lastSegment.endsWith('.yaml') || lastSegment.endsWith('.yml')
    ? 'descriptor'
    : 'config';
}

/** Where the `catalog-info.yaml` describing this entity lives, if anywhere. */
export type DescriptorLocation
  = | { kind: 'url'; target: string }
    | { kind: 'none'; reason: 'provider' | 'file' | 'absent' };

/**
 * Resolves the descriptor file this entity was read from, if it has one.
 *
 * Reads `backstage.io/managed-by-location` and NOT
 * `backstage.io/source-location`: `BrunoKindProcessor` stamps `source-location`
 * to the COLLECTION FOLDER, so `getEntitySourceLocation` points at the folder of
 * `.bru` files rather than at the YAML that declares the entity. Editing
 * `spec.partOf` means editing the descriptor, so the descriptor is what we have
 * to name.
 *
 * WHETHER there is a descriptor at all now comes from {@link collectionOrigin}
 * — a recorded fact — rather than from the annotation's file extension, which
 * was a guess that misread any descriptor served from a URL not ending in
 * `.yaml` as provider-managed.
 *
 * The three "none" reasons are all real and all need different copy:
 *  - `provider` — the location is the collection folder stamped by
 *    `BrunoCollectionEntityProvider` for a `bruno.collections[]` entry. There is
 *    no file to edit; the operator edits `app-config.yaml`.
 *  - `file` — a `file:` location (this repo's `examples/bruno-entities.yaml`).
 *    The file is on the Backstage host's disk, not in an SCM we can open a pull
 *    request against.
 *  - `absent` — no location annotation at all, which should not happen for a
 *    stitched entity but must not crash a dialog.
 */
export function descriptorLocation(entity: Entity): DescriptorLocation {
  const origin = collectionOrigin(entity);
  if (origin === 'config') {
    return { kind: 'none', reason: 'provider' };
  }
  if (origin === 'file') {
    return { kind: 'none', reason: 'file' };
  }

  // `descriptor`, `ui` and `unknown` all mean "there is a file", and for all
  // three the location annotation is the only place its URL is recorded.
  const location = entity.metadata.annotations?.[ANNOTATION_LOCATION];
  if (!location?.startsWith('url:')) {
    return { kind: 'none', reason: 'absent' };
  }
  return { kind: 'url', target: location.slice('url:'.length) };
}
