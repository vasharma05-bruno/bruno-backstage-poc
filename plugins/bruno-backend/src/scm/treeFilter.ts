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

/** The `.yaml` spelling on its own: the marker that makes a bare `.yaml`
 *  elsewhere in the tree classifiable. See {@link selectCollectionFiles}. */
const OPEN_COLLECTION_YAML = 'opencollection.yaml';

/** Both accepted spellings of a per-folder OpenCollection manifest. */
const FOLDER_MANIFEST_NAMES = ['folder.yml', 'folder.yaml'] as const;

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

/** Both accepted spellings of an OpenCollection body file. `format: 'yml'` in
 *  @usebruno/filestore is a DIALECT name, not an extension — both spellings
 *  parse identically (filestore `dist/types.d.ts`:
 *  `CollectionFormat = 'bru' | 'yml'`). */
export function isOpenCollectionBodyFile(relPath: string): boolean {
  return relPath.endsWith('.yml') || relPath.endsWith('.yaml');
}

/** `folder.yml` or `folder.yaml`, at any depth or as a bare filename. */
export function isFolderManifest(relPath: string): boolean {
  return FOLDER_MANIFEST_NAMES.some(
    (n) => relPath === n || relPath.endsWith(`/${n}`)
  );
}

/** Drops a trailing `.yml`/`.yaml`. Used for the request-name fallback. */
export function stripOpenCollectionExtension(name: string): string {
  return name.replace(/\.ya?ml$/, '');
}

/**
 * Chooses the files a collection parse needs, from the FULL path set, and
 * returns them sorted.
 *
 * Set-aware rather than per-path because a bare `.yaml` cannot be classified in
 * isolation: a blanket clause would pull `catalog-info.yaml` and `.github/**`
 * into the tree and shift `commonRootPrefix` — the fallback collection root when
 * no manifest is found — silently mis-rooting a manifest-less collection.
 * A `.yaml` is therefore admitted only when the set
 * actually contains an `opencollection.yaml`, and only at or below that
 * manifest's directory, where every `.yaml` really is a collection body file.
 *
 * Sorted because item order is otherwise archive order: `sortItems` falls back
 * to insertion index when `seq` is absent, so an unsorted tree makes the
 * generated definition non-deterministic and rewrites the entity every cycle.
 */
export function selectCollectionFiles(paths: Iterable<string>): string[] {
  const all = Array.from(paths);

  // The directories that hold an `opencollection.yaml` — the only roots under
  // which a bare `.yaml` is unambiguously a collection body file.
  const yamlManifestDirs: string[] = [];
  for (const relPath of all) {
    if (
      relPath === OPEN_COLLECTION_YAML
      || relPath.endsWith(`/${OPEN_COLLECTION_YAML}`)
    ) {
      yamlManifestDirs.push(dirOf(relPath));
    }
  }

  const selected: string[] = [];
  for (const relPath of all) {
    if (
      isCollectionFile(relPath)
      || (relPath.endsWith('.yaml')
        && yamlManifestDirs.some((dir) => isAtOrBelow(relPath, dir)))
    ) {
      selected.push(relPath);
    }
  }
  return selected.sort();
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function isAtOrBelow(relPath: string, dir: string): boolean {
  return dir === '' || relPath.startsWith(`${dir}/`);
}
