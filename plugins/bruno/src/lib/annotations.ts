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
