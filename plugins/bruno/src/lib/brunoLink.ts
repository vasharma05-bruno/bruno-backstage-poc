import { collectionPathFromUrl, repoRootFromCollectionUrl } from './scmUrl';

/**
 * Helpers for the "Open in Bruno" action.
 *
 * "Open in Bruno" hands the collection's repo-root URL to Bruno's hosted fetch
 * endpoint (`https://fetch.usebruno.com/?url=<repoUrl>`), which loads the
 * collection in Bruno. We also offer a "Clone & open in Bruno" fallback that
 * gives the user a `git clone` command to run and then open the folder in
 * Bruno.
 *
 * Keep the exact URL format in ONE place (below) so it's easy to change.
 */

/**
 * Base URL of Bruno's hosted "fetch collection from URL" endpoint.
 * Centralized so the exact format is a one-line change.
 */
const BRUNO_FETCH_BASE_URL = 'https://fetch.usebruno.com/';

/**
 * Build the `https://fetch.usebruno.com/?url=<repoUrl>` open link.
 *
 * We send only the repo root (`https://<host>/<owner>/<repo>`), not the deeper
 * `/tree/<ref>/<subpath>` collection path.
 *
 * @param sourceUrl - The `usebruno.com/source-url` annotation (a git repo / tree
 *   URL pointing at the collection).
 */
export function buildBrunoDeepLink(sourceUrl: string): string {
  const encoded = encodeURIComponent(repoRootFromCollectionUrl(sourceUrl));
  return `${BRUNO_FETCH_BASE_URL}?url=${encoded}`;
}

/**
 * The repository root of a collection URL, or undefined when there is not one
 * to be had.
 *
 * `repoRootFromCollectionUrl` returns its INPUT unchanged when it cannot find a
 * `<namespace>/<repo>` pair — an unparseable URL, or a host with too few path
 * segments — and both the `.git` clone URL and the cloned directory name below
 * would be nonsense built on that. So the "did it actually reduce?" test lives
 * here once and its callers get `undefined`, rather than a string each of them
 * has to re-check.
 */
function repoRoot(sourceUrl: string): string | undefined {
  const root = repoRootFromCollectionUrl(sourceUrl);
  return /^https?:\/\/[^/]+(\/[^/]+){2,}$/.test(root) ? root : undefined;
}

/**
 * Converts a collection URL into its HTTPS clone URL.
 *
 * `repoRootFromCollectionUrl` already strips each provider's in-repo view
 * (`/tree/`, `/-/tree/`, `/src/`), and all three then take the same
 * `<repo-root>.git` clone form — so this needs no provider branch. Returns the
 * input unchanged when the URL cannot be reduced to a repo root.
 */
function toCloneUrl(sourceUrl: string): string {
  const root = repoRoot(sourceUrl);
  return root ? `${root}.git` : sourceUrl;
}

/**
 * The directory `git clone` leaves behind: the repository root's last path
 * segment, which is the name git derives too.
 *
 * Needed because the clone lands the user in the PARENT of that directory, so a
 * `cd` straight into the repo-relative collection path would miss by one level
 * and fail.
 */
function clonedDirectory(root: string): string {
  return root.split('/').filter(Boolean).pop() ?? '';
}

/**
 * POSIX single-quoting for the one value this file interpolates into a shell
 * command.
 *
 * Applied unconditionally rather than only when a space is present: `$`, `&`,
 * `(` and `'` are all legal in a Git path too, and one rule is easier to keep
 * correct than a predicate listing them. `collectionPathFromUrl` hands back a
 * percent-DECODED path, so a folder the user sees as `my collection` arrives
 * with a real space in it and would otherwise word-split.
 */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell instruction we surface for the clone-and-open fallback.
 *
 * A collection in a subfolder gets a `cd` into it. Without one this drops the
 * subpath that `collectionPathFromUrl` already computes for the descriptor
 * path, and leaves the user at the repository root to hunt for a folder this
 * side knows the name of — worst in the repositories that hold several
 * collections, where the folder is the only thing telling them apart.
 *
 * A collection that IS its repository gets exactly the instruction it got
 * before, and so does an input nothing can parse: `collectionPathFromUrl`
 * answers `''` for a bare repo URL and for anything it cannot read as a path
 * inside a repository, and a URL with no repository root to clone into is not
 * given a `cd` at all. The degenerate cases fall back to today's single line
 * rather than to a `cd` into nowhere.
 */
export function buildCloneInstruction(sourceUrl: string): string {
  const root = repoRoot(sourceUrl);
  const cloneUrl = toCloneUrl(sourceUrl);
  const folder = root === undefined ? '' : collectionPathFromUrl(sourceUrl);
  if (root === undefined || !folder) {
    return `git clone ${cloneUrl}\n# then in Bruno: Open Collection -> select the cloned folder`;
  }
  const target = `${clonedDirectory(root)}/${folder}`;
  return `git clone ${cloneUrl}\ncd ${shellQuote(target)}\n# then in Bruno: Open Collection -> select that folder`;
}
