import { repoRootFromCollectionUrl } from './scmUrl';

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
export const BRUNO_FETCH_BASE_URL = 'https://fetch.usebruno.com/';

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
 * Converts a collection URL into its HTTPS clone URL.
 *
 * `repoRootFromCollectionUrl` already strips each provider's in-repo view
 * (`/tree/`, `/-/tree/`, `/src/`), and all three then take the same
 * `<repo-root>.git` clone form — so this needs no provider branch. Returns the
 * input unchanged when the URL cannot be reduced to a repo root.
 */
export function toCloneUrl(sourceUrl: string): string {
  const root = repoRootFromCollectionUrl(sourceUrl);
  // It returns its input unchanged when it cannot find a `<namespace>/<repo>`
  // pair — an unparseable URL, or a host with too few path segments — and
  // appending `.git` to that would produce nonsense.
  const isRepoRoot = /^https?:\/\/[^/]+(\/[^/]+){2,}$/.test(root);
  return isRepoRoot ? `${root}.git` : sourceUrl;
}

/**
 * The shell instruction we surface for the clone-and-open fallback.
 */
export function buildCloneInstruction(sourceUrl: string): string {
  const cloneUrl = toCloneUrl(sourceUrl);
  return `git clone ${cloneUrl}\n# then in Bruno: Open Collection -> select the cloned folder`;
}
