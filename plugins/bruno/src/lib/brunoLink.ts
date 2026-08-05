/**
 * Helpers for the "Open in Bruno" action.
 *
 * IMPORTANT (POC gap, see docs/POC-DECISIONS.md D3 / Q3):
 * Today's Bruno desktop only registers the `bruno://app/oauth2/callback`
 * deep-link handler. There is currently NO `bruno://open` or import-from-URL
 * verb — that is a documented Beta desktop dependency. We therefore:
 *   1. build the intended `bruno://` deep link (so it's trivial to flip on once
 *      the desktop verb ships), and
 *   2. offer a "Clone & open in Bruno" fallback that gives the user a
 *      `git clone` command they can run and then open the folder in Bruno.
 *
 * Keep the exact deep-link format in ONE place (below) so it's easy to change.
 */

/**
 * The deep-link scheme + verb we intend to use once the desktop app supports
 * it. Centralized so the exact format is a one-line change.
 *
 * VERIFY: `bruno://open` is aspirational — not yet handled by Bruno desktop.
 */
export const BRUNO_DEEP_LINK_SCHEME = 'bruno';
export const BRUNO_OPEN_VERB = 'open';

/**
 * Build the intended `bruno://open?url=<sourceUrl>` deep link.
 *
 * @param sourceUrl - The `bruno.dev/source-url` annotation (a git repo / tree
 *   URL pointing at the collection).
 */
export function buildBrunoDeepLink(sourceUrl: string): string {
  const encoded = encodeURIComponent(sourceUrl);
  return `${BRUNO_DEEP_LINK_SCHEME}://${BRUNO_OPEN_VERB}?url=${encoded}`;
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
