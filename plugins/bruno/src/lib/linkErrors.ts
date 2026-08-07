export type LinkErrorKind = 'notFound' | 'needsAuth' | 'other';

/** Classify a scan/link failure from its (string-wrapped) message. */
export function classifyLinkError(e: unknown): LinkErrorKind {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
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
