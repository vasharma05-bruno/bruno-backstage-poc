/**
 * POSIX path arithmetic on the repo-relative keys that travel through this
 * plugin.
 *
 * Every tree key here is POSIX by contract — they come from tarball entries and
 * SCM tree APIs, not from the local filesystem — so Node's `path` is the wrong
 * tool: on Windows it would join with backslashes and fail to split keys that
 * are already `/`-separated.
 *
 * A leaf module with no imports, so both the SCM adapters under `scm/` and the
 * parsers under `service/` can share one copy without either direction of that
 * dependency. Three near-identical private copies of these lived across
 * `scm/normalize.ts`, `service/collectionParser.ts` and
 * `service/manifestProbe.ts` before this.
 */

/** Joins POSIX path parts, skipping empty ones. */
export function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/** The directory part of a POSIX path, or `''` for a bare filename. */
export function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** The filename part of a POSIX path, or the whole string with no `/`. */
export function posixBaseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}
