/**
 * Whether a repo-relative path is a file the collection parser needs: Bruno
 * request/environment files, the `bruno.json` manifest, OpenCollection YAML, and
 * the collection README.
 *
 * One definition shared by every read path (UrlReader and the per-provider
 * user-token readers) so no provider can drift into fetching a different file
 * set than another.
 */
export function isCollectionFile(relPath: string): boolean {
  return (
    relPath.endsWith('.bru')
    || relPath.endsWith('bruno.json')
    || relPath.endsWith('.yml')
    || /(^|\/)readme\.md$/i.test(relPath)
  );
}
