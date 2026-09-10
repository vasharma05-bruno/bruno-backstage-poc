import { scmProviderFromUrl } from './scmProviders';

/**
 * Reduce a stored collection URL to its repository-root URL, per provider:
 *
 *   GitHub     https://host/<owner>/<repo>/tree/<ref>/<path>    -> …/<owner>/<repo>
 *   Bitbucket  https://host/<workspace>/<repo>/src/<ref>/<path> -> …/<workspace>/<repo>
 *   GitLab     https://host/<group…>/<repo>/-/tree/<ref>/<path> -> …/<group…>/<repo>
 *
 * GitLab is why this needs the provider and not just the URL shape. Its
 * namespace is arbitrary-depth, so the project path is everything before the
 * `/-/` separator — and a bare project URL has no separator at all, making
 * `https://gitlab.com/group/subgroup/project` indistinguishable by shape from a
 * two-segment repo plus a stray path segment. Counting segments truncates it.
 *
 * Mirrors `repoRootFromUrl` in each backend adapter under
 * plugins/bruno-backend/src/scm — keep both in step (MSCM-P3 unifies them).
 *
 * Total: never throws.
 */
export function repoRootFromCollectionUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    // GitHub, Bitbucket and unknown hosts share a fixed `<namespace>/<repo>`
    // pair, with everything after it being the in-repo view. Only GitLab needs
    // the separator scan.
    const projectSegments
      = scmProviderFromUrl(url)?.id === 'gitlab'
        ? gitlabProjectSegments(seg)
        : seg.slice(0, 2);
    if (projectSegments.length < 2) {
      return url;
    }
    return `${u.origin}/${projectSegments.join('/')}`;
  } catch {
    return url;
  }
}

/** Everything before GitLab's `/-/` separator, or the whole path without one. */
function gitlabProjectSegments(segments: string[]): string[] {
  const dash = segments.indexOf('-');
  return dash === -1 ? segments : segments.slice(0, dash);
}

/**
 * The segment each provider puts between the project and the ref when it is
 * showing something inside the repository. `src` is Bitbucket's; the rest are
 * GitHub's and GitLab's.
 */
const VIEW_SEGMENTS = ['tree', 'blob', 'raw', 'src'];

/**
 * The in-repo folder a collection URL points at, or `''` when it points at the
 * repository itself:
 *
 *   GitHub     https://host/<owner>/<repo>/tree/<ref>/<path>    -> <path>
 *   Bitbucket  https://host/<workspace>/<repo>/src/<ref>/<path> -> <path>
 *   GitLab     https://host/<group…>/<repo>/-/tree/<ref>/<path> -> <path>
 *
 * The exact complement of {@link repoRootFromCollectionUrl}, and split the same
 * way for the same reason: GitLab's namespace is arbitrary-depth, so its path
 * begins after the `/-/<view>/<ref>` run rather than at a fixed offset.
 *
 * This is what decides where a generated `catalog-info.yaml` belongs. A
 * collection in `github-rest-api-collection/` wants its descriptor beside it,
 * not at the repository root — one root descriptor per repository is a ceiling
 * of one collection per repository, and a repository holding several would be
 * able to describe only the first.
 *
 * Segments are percent-decoded, because that is the form the SCM APIs take
 * paths in: a folder with a space in its name arrives as `my%20collection` in
 * the browser URL the user pasted, and has to be committed to as
 * `my collection`.
 *
 * Total: never throws. Anything it cannot read as a path inside a repository
 * comes back as `''`, which every caller treats as the repository root.
 */
export function collectionPathFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    if (scmProviderFromUrl(url)?.id === 'gitlab') {
      // `<namespace…>/<repo>/-/<view>/<ref>/<path…>`
      const dash = segments.indexOf('-');
      if (dash === -1 || !VIEW_SEGMENTS.includes(segments[dash + 1] ?? '')) {
        return '';
      }
      return segments.slice(dash + 3).join('/');
    }

    // `<namespace>/<repo>/<view>/<ref>/<path…>`
    if (segments.length < 5 || !VIEW_SEGMENTS.includes(segments[2])) {
      return '';
    }
    return segments.slice(4).join('/');
  } catch {
    return '';
  }
}

/**
 * Where a collection's descriptor belongs: `<collection folder>/<filename>`, or
 * bare `<filename>` for a collection that is its whole repository.
 *
 * Repo-relative and never leading-slashed, which is the form both the GitHub
 * contents API and a `catalog.locations` entry want.
 */
export function descriptorPathForCollection(
  collectionUrl: string,
  filename: string
): string {
  const folder = collectionPathFromUrl(collectionUrl);
  return folder ? `${folder}/${filename}` : filename;
}

/**
 * Default longest a collection URL is rendered before its middle is elided.
 */
const DEFAULT_MAX_URL_CHARS = 48;

/**
 * Shortens a collection URL for a narrow surface — a table cell, a card row, a
 * header metadata line: the host and the last two path segments carry the
 * meaning, and a full `/tree/<ref>/<deep>/<path>` would widen the column past
 * everything else beside it.
 *
 * Elides the MIDDLE rather than the tail, which is what CSS `text-overflow`
 * would do: the tail is the collection folder — the one segment that
 * distinguishes two collections in the same repo — so truncating it makes rows
 * indistinguishable exactly where the surface has to disambiguate.
 *
 * `maxChars` is the only thing that varied between the three hand-rolled copies
 * this replaces, so it is the only knob: a caller with a tighter column passes
 * its own budget rather than reimplementing the elision.
 *
 * Total: an unparseable string falls back to a plain tail cut rather than
 * throwing.
 */
export function elideCollectionUrl(
  url: string,
  maxChars: number = DEFAULT_MAX_URL_CHARS
): string {
  if (url.length <= maxChars) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return `${parsed.host}/…/${segments.slice(-2).join('/')}`;
  } catch {
    return `${url.slice(0, maxChars - 1)}…`;
  }
}
