import { repoRootFromCollectionUrl } from './githubUrl';

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
 * @param sourceUrl - The `bruno.dev/source-url` annotation (a git repo / tree
 *   URL pointing at the collection).
 */
export function buildBrunoDeepLink(sourceUrl: string): string {
  const encoded = encodeURIComponent(repoRootFromCollectionUrl(sourceUrl));
  return `${BRUNO_FETCH_BASE_URL}?url=${encoded}`;
}

/**
 * Best-effort conversion of a GitHub tree/blob URL into the repo clone URL.
 * Falls back to returning the input unchanged when we can't parse it.
 */
export function toCloneUrl(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    // https://github.com/<org>/<repo>/tree/<ref>/<path...>
    const match = u.pathname.match(/^\/([^/]+)\/([^/]+)/);
    if (u.hostname.includes('github') && match) {
      return `${u.protocol}//${u.hostname}/${match[1]}/${match[2]}.git`;
    }
  } catch {
    // ignore, fall through
  }
  return sourceUrl;
}

/**
 * The shell instruction we surface for the clone-and-open fallback.
 */
export function buildCloneInstruction(sourceUrl: string): string {
  const cloneUrl = toCloneUrl(sourceUrl);
  return `git clone ${cloneUrl}\n# then in Bruno: Open Collection -> select the cloned folder`;
}
