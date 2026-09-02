import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';

/**
 * The one reading of the two entity references a runtime link is made of.
 *
 * A runtime link is a row keyed by `(collection ref, api ref)`, and both halves
 * arrive as strings a user's browser sent. `spec.partOf` is written by hand, so
 * the same API can be named three ways — `github-rest-api`,
 * `api:github-rest-api`, `api:default/github-rest-api` — and all three key the
 * same relation. If the row and the `spec.partOf` entry were normalised
 * differently, `POST /links` would accept a link the descriptor already
 * declares, the processor would emit the same relation twice, and
 * `DELETE /links` would not find the row it wrote.
 *
 * Mirrors `lib/apiRef.ts` in the `bruno` frontend plugin — the two are separate
 * packages, and the frontend already duplicates `BRUNO_API_VERSION` and the
 * entity-name grammar for the same reason. Keep them in step: the frontend
 * normalises before it compares an annotation against a ref, and a drift makes
 * a link this backend just wrote invisible to the dialog that offers to remove
 * it.
 *
 * The defaults match the catalog's own: `partOf` targets default to `kind: API`,
 * and every ref defaults to the `default` namespace.
 */

/** Normalises an API reference, throwing on one the catalog cannot parse. */
export function normaliseApiRef(ref: string): string {
  return stringifyEntityRef(
    parseEntityRef(ref, { defaultKind: 'API', defaultNamespace: 'default' })
  );
}

/**
 * Normalises a Bruno collection reference, throwing on an unparseable one.
 *
 * `defaultKind: 'Bruno'` so a bare `payments` names the collection rather than
 * being read as a component; the routes still verify the ref resolves to a
 * `kind: Bruno` entity, because a caller can also send `api:default/payments`
 * explicitly and a link whose "collection" is an API entity would produce
 * relations nothing renders.
 */
export function normaliseCollectionRef(ref: string): string {
  return stringifyEntityRef(
    parseEntityRef(ref, { defaultKind: 'Bruno', defaultNamespace: 'default' })
  );
}
