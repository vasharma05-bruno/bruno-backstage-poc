import type { Entity } from '@backstage/catalog-model';

/** Annotation carrying the backend collection id. */
export const BRUNO_COLLECTION_ID_ANNOTATION = 'bruno.dev/collection-id';
/** Annotation carrying the source repo/tree URL. */
export const BRUNO_SOURCE_URL_ANNOTATION = 'bruno.dev/source-url';
/** Annotation carrying the path of the collection within its source. */
export const BRUNO_COLLECTION_PATH_ANNOTATION = 'bruno.dev/collection-path';

export function getCollectionId(entity: Entity): string | undefined {
  return entity.metadata.annotations?.[BRUNO_COLLECTION_ID_ANNOTATION];
}

export function getSourceUrl(entity: Entity): string | undefined {
  return entity.metadata.annotations?.[BRUNO_SOURCE_URL_ANNOTATION];
}

/**
 * `backstage.io/managed-by-location` prefix stamped on entities the Bruno entity
 * provider materializes from `bruno.sources`. Mirrors `LOCATION_TYPE` in
 * plugins/bruno-backend/src/provider/BrunoEntityProvider.ts.
 */
const BRUNO_PROVIDER_LOCATION_PREFIX = 'bruno-provider:';

/**
 * Whether this entity is owned by the Bruno entity provider (materialized from
 * config), as opposed to someone else's entity that a runtime connection merely
 * annotated.
 *
 * The `bruno.dev/*` annotations cannot tell those apart: `BrunoLinkProcessor`
 * injects the same `bruno.dev/collection-id` onto a runtime-connected entity
 * that the provider writes onto one it owns, so any test based on them starts
 * reporting "provider-managed" for a user's own link as soon as the catalog
 * re-processes it. Provenance can tell them apart — only the provider's own
 * entities carry its location, and a foreign entity keeps its `file:`/`url:` one
 * through annotation.
 *
 * Callers use this to decide whether the USER owns a link, and may therefore
 * disconnect or re-point it, or whether config does.
 */
export function isProviderManaged(entity: Entity): boolean {
  return (
    entity.metadata.annotations?.['backstage.io/managed-by-location'] ?? ''
  ).startsWith(BRUNO_PROVIDER_LOCATION_PREFIX);
}
