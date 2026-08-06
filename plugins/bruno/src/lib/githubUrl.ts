/** Reduce a stored collection URL (…/tree/<ref>/<subpath> or bare repo) to its
 *  repo-root URL https://<host>/<owner>/<repo>. Total: never throws. */
export function repoRootFromCollectionUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) {
      return url;
    }
    return `${u.origin}/${seg[0]}/${seg[1]}`;
  } catch {
    return url;
  }
}
