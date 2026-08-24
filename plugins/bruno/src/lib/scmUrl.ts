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
