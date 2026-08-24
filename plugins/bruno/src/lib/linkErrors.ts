export type LinkErrorKind = 'configError' | 'notFound' | 'needsAuth' | 'other';

/**
 * Classify a scan/link failure from its (string-wrapped) message.
 *
 * `configError` is tested FIRST, and that order is load-bearing. The backend's
 * provider diagnostics nest the underlying reader error, and every reader's
 * message ends in "404 Not Found" — so a failure whose real content is "this
 * host has no integration configured" or "this provider cannot use your token"
 * would otherwise classify as `notFound` and be replaced by "no collection found
 * here" copy, burying the only text that says what to do about it.
 */
export function classifyLinkError(e: unknown): LinkErrorKind {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (
    msg.includes('cannot use your personal access token')
    || msg.includes('integration is configured for')
  ) {
    return 'configError';
  }
  if (msg.includes('no bruno collection found')
    || msg.includes('(404)') || msg.includes('not found')) {
    return 'notFound';
  }
  if (msg.includes('(401)') || msg.includes('(403)')
    || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'needsAuth';
  }
  return 'other';
}
