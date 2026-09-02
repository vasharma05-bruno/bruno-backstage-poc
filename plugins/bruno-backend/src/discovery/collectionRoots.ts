/**
 * The pure decisions of a sweep: which directories of a repository are
 * collection roots, what each one's entity is called, and whether an authored
 * descriptor already claims it.
 *
 * Separate from `githubDiscovery.ts` because these are the rules worth pinning
 * with tests — they decide entity NAMES, which are frozen identities the
 * catalog will not let a processor change later.
 */
import yaml from 'js-yaml';
import { posixDirname } from '../posixPath';
import { isBrunoJsonManifest, isOpenCollectionManifest } from '../scm';
import { sanitizeName } from '../service/entityName';

/** The descriptor filename Backstage reads, in both spellings people write. */
const CATALOG_INFO_NAMES = ['catalog-info.yaml', 'catalog-info.yml'] as const;

/**
 * Every directory of a repo tree that holds a Bruno manifest, repo-relative and
 * sorted, with `''` meaning the repository root.
 *
 * The SAME two predicates the probe uses (`scm/treeFilter.ts`), so a directory
 * this yields is one `detectManifest` will also accept — a sweep that found a
 * root the probe then rejects would publish an entity and immediately delete it
 * again on the next tick.
 *
 * A directory holding BOTH manifests yields one root, and a manifest nested
 * inside another collection's tree yields its own: Bruno marks a subfolder of a
 * collection with `folder.bru`/`folder.yml`, never with `bruno.json`, so a
 * nested manifest really is a second collection rather than part of the outer
 * one.
 */
export function collectionRootsFromPaths(paths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    if (isOpenCollectionManifest(path) || isBrunoJsonManifest(path)) {
      roots.add(posixDirname(path));
    }
  }
  return Array.from(roots).sort();
}

/**
 * The entity name for a discovered collection.
 *
 * REPO-QUALIFIED, unlike `collectionNameFromUrl`, which takes the URL's last
 * segment. That rule is right for a hand-written `bruno.collections[]` entry,
 * where the operator sees the name and can override it with `name:`; applied to
 * a sweep it collides on contact, because a folder called `collection`, `api` or
 * `tests` is the single most likely thing to find in two different
 * repositories — and a collision is resolved by SKIPPING the loser, so the
 * second repository's collection would simply never appear.
 *
 * There is no `name:` override for a discovered collection, so the name has to
 * be unambiguous by construction: the repository name, plus the collection's
 * path within it when it is not at the root. Names are also required to be
 * stable — renaming an entity orphans the old one — which is why this is
 * derived from the path and not from the manifest's `name`, a field anyone can
 * edit in a pull request. The manifest name lands in `metadata.title` instead.
 *
 * `sanitizeName` clamps to 63 characters, so two very deep paths in one
 * repository can still collide after truncation; the provider's `claimed` guard
 * reports that with both URLs rather than silently keeping one.
 */
export function discoveredCollectionName(
  repo: string,
  rootPrefix: string
): string {
  return sanitizeName(
    rootPrefix === '' ? repo : `${repo}-${rootPrefix.split('/').join('-')}`
  );
}

/**
 * The descriptor paths that could declare the collection at `rootPrefix`,
 * restricted to the ones the tree actually contains — so a repository with no
 * `catalog-info.yaml` costs no extra API call at all.
 *
 * Two locations are considered: the collection's own directory and the
 * repository root. Not every descriptor in the repository, on purpose — that
 * would be one fetch per `catalog-info.yaml` in a monorepo, to catch a layout
 * (a descriptor in an unrelated directory pointing back at this collection)
 * that nothing generates. A collection declared from a third location is
 * discovered as well as authored, which the `deferToCatalogInfo` note in
 * `config.d.ts` says out loud.
 */
export function catalogInfoCandidates(
  rootPrefix: string,
  paths: Iterable<string>
): string[] {
  const present = paths instanceof Set ? paths : new Set(paths);
  const candidates = new Set<string>();
  for (const name of CATALOG_INFO_NAMES) {
    for (const dir of new Set([rootPrefix, ''])) {
      const path = dir === '' ? name : `${dir}/${name}`;
      if (present.has(path)) {
        candidates.add(path);
      }
    }
  }
  return Array.from(candidates).sort();
}

/**
 * Whether a `catalog-info.yaml` declares a `kind: Bruno` entity — i.e. whether
 * leaving this collection to its descriptor means it still reaches the catalog.
 *
 * `loadAll`, because a descriptor may be a multi-document file and the Bruno
 * entity can be any document in it. Tolerant of everything else: a descriptor
 * that will not parse is not our error to report (the catalog reports it
 * against the location that read it), and treating it as "no Bruno entity here"
 * errs towards publishing the discovered entity, which is the recoverable
 * direction — a duplicate is visible and fixable, a collection that silently
 * never appears is not.
 */
export function declaresBrunoKind(descriptor: string): boolean {
  let documents: unknown[];
  try {
    documents = yaml.loadAll(descriptor);
  } catch {
    return false;
  }
  return documents.some((doc) => {
    const kind = (doc as { kind?: unknown } | null)?.kind;
    return typeof kind === 'string' && kind.toLowerCase() === 'bruno';
  });
}
