/**
 * Entity-name derivation for Bruno collections.
 *
 * The parse itself lives in `collectionParser.ts` and the fetch/cache in
 * `manifestProbe.ts`; what is left here is the one rule shared by every path
 * that has to turn a collection's identity into a catalog entity name.
 */

/** Sanitizes a source id into a valid Backstage entity name. */
export function sanitizeName(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || 'bruno-collection';
}
