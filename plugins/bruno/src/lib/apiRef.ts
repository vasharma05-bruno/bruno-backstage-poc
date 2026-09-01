import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';

/**
 * The one reading of an API entity reference this plugin uses.
 *
 * `spec.partOf` is written by hand, so the same API can be named three ways —
 * `github-rest-api`, `api:github-rest-api`, `api:default/github-rest-api` — and
 * all three key the same relation. Two flows depend on that being resolved
 * identically: `generateCatalogInfo` writes normalised refs into the descriptor
 * it generates, and `unlinkPr` compares normalised refs to find the entry to
 * add or remove. A second, subtly different normalisation in either place would
 * make a link the UI just wrote invisible to the unlink that follows it.
 *
 * `defaultKind: 'API'` matches the catalog's own default for `partOf` targets;
 * `defaultNamespace: 'default'` matches its namespace default.
 */

/** Normalises an API reference, throwing on one the catalog cannot parse. */
export function normaliseApiRef(ref: string): string {
  return stringifyEntityRef(
    parseEntityRef(ref, { defaultKind: 'API', defaultNamespace: 'default' })
  );
}

/**
 * {@link normaliseApiRef}, returning `undefined` instead of throwing.
 *
 * For the callers whose right answer to an unparseable ref is to DROP it: a
 * descriptor naming a ref the catalog cannot parse fails validation for the
 * whole entity, and a ref in a file that will not parse is not the one a search
 * is looking for.
 */
export function tryNormaliseApiRef(ref: string): string | undefined {
  try {
    return normaliseApiRef(ref);
  } catch {
    return undefined;
  }
}
