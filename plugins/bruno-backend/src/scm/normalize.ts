/**
 * Normalizes a path-style SCM collection URL to a stable identity string.
 * Lower-cases the host, drops query/hash, collapses duplicate slashes and a
 * single trailing slash. The path itself is preserved, so distinct subpaths stay
 * distinct collections.
 *
 * Shared by every path-style provider (GitHub `/tree/<ref>/`, GitLab
 * `/-/tree/<ref>/`, Bitbucket Cloud `/src/<ref>/`) so their collection ids are
 * derived by one algorithm. It is byte-for-byte the normalization GitHub URLs
 * went through before the other providers existed, which is what keeps existing
 * GitHub collection ids stable.
 *
 * NOT usable by providers that carry the ref in the query string (Bitbucket
 * Server `?at=`, Azure `?version=`) — dropping `search` would destroy their ref.
 * Those need their own `normalizeUrl`; see docs/MULTI-SCM-PLAN.md B1/B2.
 */
export function normalizePathStyleUrl(url: string): string {
  const u = new URL(url.trim());
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  u.search = '';
  let normalizedPath = u.pathname.replace(/\/{2,}/g, '/');
  if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  return `${u.protocol}//${u.host}${normalizedPath}`;
}

/** Joins POSIX path parts, skipping empty ones. */
export function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

/**
 * Reduces a URL to its origin plus the first `depth` path segments. Total:
 * returns the input unchanged on a malformed URL or too few segments, so
 * `repoRootFromUrl` implementations built on it never throw.
 */
export function originPlusSegments(url: string, depth: number): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < depth) {
      return url;
    }
    return `${u.origin}/${seg.slice(0, depth).join('/')}`;
  } catch {
    return url;
  }
}

/**
 * Rejects a ref that cannot be represented unambiguously in a path-style URL.
 *
 * Every provider grammar here carries the ref as a SINGLE path segment, so a ref
 * like `release/1.x` is indistinguishable from a ref plus a subpath. Composing
 * one anyway yields a stored `sourceUrl` that re-parses as a different
 * ref/subpath pair, and the next sync silently reads the wrong path — so fail
 * loudly at compose time instead. Reached mainly via `resolveDefaultBranch`,
 * where the ref is the repo's default branch and not the user's choice.
 */
export function assertSingleSegmentRef(ref: string, provider: string): void {
  if (ref.includes('/')) {
    throw new Error(
      `${provider} ref "${ref}" contains a slash, which this URL grammar cannot `
      + `represent unambiguously. Use a ref without a slash, or point the `
      + `collection at a repository whose default branch has none.`
    );
  }
}

/** Host of `url`, or the raw string when it will not parse. For messages only. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
