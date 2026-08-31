/** Both accepted spellings of the OpenCollection manifest. `.yml` is what
 *  Bruno writes today; `.yaml` is what the PRD specifies. Precedence between
 *  them is resolved in `findOpenCollectionYml`, not here. */
export const OPEN_COLLECTION_MANIFEST_NAMES = [
  'opencollection.yml',
  'opencollection.yaml'
] as const;

/** True when a repo-relative path IS an OpenCollection manifest (either
 *  spelling), at the tree root or in any subdirectory. Also correct for a bare
 *  filename, which is why the local walker can use it too. */
export function isOpenCollectionManifest(relPath: string): boolean {
  return OPEN_COLLECTION_MANIFEST_NAMES.some(
    (n) => relPath === n || relPath.endsWith(`/${n}`)
  );
}

/** True when a repo-relative path IS a `bruno.json` manifest. */
export function isBrunoJsonManifest(relPath: string): boolean {
  return relPath === 'bruno.json' || relPath.endsWith('/bruno.json');
}

/**
 * Whether a repo-relative path is a file the collection parser needs: Bruno
 * request/environment files, the `bruno.json` manifest, OpenCollection YAML
 * (`opencollection.yml` or `opencollection.yaml`), and the collection README.
 *
 * Shared by every REMOTE read path (the UrlReader and the per-provider
 * user-token readers) so no provider can drift into fetching a different file
 * set than another. The local-filesystem walker in `collectionService` matches
 * on directory entries rather than relative paths and keeps its own equivalent
 * check.
 *
 * The `.yaml` spelling is admitted by name rather than by extension: a blanket
 * `.yaml` clause would pull `catalog-info.yaml` and `.github/**` into the tree,
 * shifting `commonRootPrefix` — the fallback collection root when no manifest
 * is found — and silently mis-rooting manifest-less collections.
 */
export function isCollectionFile(relPath: string): boolean {
  return (
    relPath.endsWith('.bru')
    || relPath.endsWith('bruno.json')
    || relPath.endsWith('.yml')
    || isOpenCollectionManifest(relPath)
    || /(^|\/)readme\.md$/i.test(relPath)
  );
}
