/**
 * The cheap "did this tree move?" check that sits in FRONT of `readTree`.
 *
 * WHY THIS EXISTS, since `readTree` already takes an etag. Backstage's
 * `readTree` etag is a CLIENT-SIDE COMMIT-SHA COMPARE, not an HTTP 304: the
 * reader resolves the target's commit sha — 1-2 GitHub API calls, 2 on GitLab —
 * and only then throws `NotModifiedError`. It saves the tarball DOWNLOAD; it
 * does not save a single unit of rate-limit quota. With one probe per collection
 * per catalog cycle that is the entire steady-state cost of the plugin, and it
 * scales with `collections x time` whether or not anybody pushes anything.
 *
 * A real conditional HTTP request does not. Replaying a stored `If-None-Match`
 * against a commits endpoint makes an unchanged collection cost ZERO quota per
 * cycle — the difference between "50 collections saturates a PAT" and "request
 * volume tracks pushes".
 *
 * MEASURED, 2026-09-02, against `api.github.com`, because the exact condition
 * matters and is easy to get wrong:
 *
 *   AUTHENTICATED    three consecutive 304s left `x-ratelimit-remaining` at
 *                    4834; an unconditional call took it to 4833. Free.
 *   UNAUTHENTICATED  every 304 decremented (58 -> 57 -> 56). NOT free.
 *
 * So the zero-quota property requires a host credential — i.e. an
 * `integrations.github` token or app. Without one, a public collection still
 * benefits (the 304 skips the tarball and the second sha-resolution call) but
 * spends one of the 60/hr anonymous budget, exactly as today. Nothing regresses;
 * the big win is simply conditional on being authenticated.
 *
 * Deliberately OPTIONAL and deliberately TOTAL. `ScmProvider.checkTreeIdentity`
 * is implemented for GitHub only, because GitHub is where the free-304 property
 * was verified — GitLab and Bitbucket would spend the same quota the sha compare
 * already spends, for no gain. Every provider without it, and every failure of
 * the ones with it, reports `unknown` and falls through to exactly the `readTree`
 * that would have happened anyway. Nothing here can turn a readable collection
 * into an unreadable one.
 */

/**
 * A provider's opaque handle on one collection tree. Stored on the probe's cache
 * entry and handed back on the next check; never interpreted outside the adapter
 * that produced it.
 */
export interface TreeIdentity {
  /** The host's HTTP entity tag, replayed as `If-None-Match`. */
  httpEtag?: string;
  /** The commit sha the identity endpoint reported, for the belt-and-braces
   *  compare when a host rotates an etag without changing content. */
  commit?: string;
}

/**
 * - `unchanged` — the tree behind the cached entry is still current; reuse it.
 * - `changed` — the tree moved. `identity` is the handle for the NEXT check and
 *   must be stored even when the follow-up read turns out to be a no-op, or the
 *   free path is never reached.
 * - `unknown` — could not tell. Callers MUST fall through to a full `readTree`.
 */
export type TreeIdentityCheck
  = | { status: 'unchanged' }
    | { status: 'changed'; identity: TreeIdentity }
    | { status: 'unknown' };

/** Long enough for a cold API call, short enough that a hung host cannot stall
 *  a catalog processing slot behind an optimisation. */
const DEFAULT_TIMEOUT_MS = 10_000;

export type ConditionalGetResult
  = | { kind: 'not-modified' }
    | { kind: 'ok'; httpEtag?: string; body: unknown }
    | { kind: 'failed'; message: string };

/**
 * A GET that treats 304 as a RESULT rather than an error.
 *
 * Written against `fetch` rather than Octokit on purpose: `@octokit/request`
 * throws on a 304, which is the one status this whole path exists to observe,
 * and unpicking that from a real error is more code than the request itself.
 *
 * Total: every failure mode — a non-2xx, a timeout, a DNS error, a body that is
 * not JSON — comes back as `failed`, because the caller's fallback is the read
 * it was going to do anyway and the read's error is the one worth surfacing.
 */
export async function conditionalGetJson(args: {
  url: string;
  headers: Record<string, string>;
  ifNoneMatch?: string;
  timeoutMs?: number;
}): Promise<ConditionalGetResult> {
  const { url, headers, ifNoneMatch, timeoutMs = DEFAULT_TIMEOUT_MS } = args;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        ...(ifNoneMatch && { 'if-none-match': ifNoneMatch })
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status === 304) {
      return { kind: 'not-modified' };
    }
    if (!response.ok) {
      return {
        kind: 'failed',
        message: `${response.status} ${response.statusText}`
      };
    }
    return {
      kind: 'ok',
      httpEtag: response.headers.get('etag') ?? undefined,
      body: await response.json()
    };
  } catch (e) {
    return { kind: 'failed', message: String((e as Error)?.message ?? e) };
  }
}
