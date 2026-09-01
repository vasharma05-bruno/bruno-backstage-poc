/**
 * Which SCM provider a repository URL belongs to, and the copy that goes with
 * it. Frontend-side only: the backend's `ScmIntegrationRegistry` is the
 * authority on what is actually readable, so treat this as the input validator
 * and the label source, not as a capability check.
 */

export type ScmProviderId = 'github' | 'gitlab' | 'bitbucket';

export interface ScmProviderInfo {
  id: ScmProviderId;
  /** Display name, used in buttons and messages ("Connect GitLab"). */
  label: string;
}

const PROVIDERS: Record<ScmProviderId, ScmProviderInfo> = {
  github: { id: 'github', label: 'GitHub' },
  gitlab: { id: 'gitlab', label: 'GitLab' },
  bitbucket: { id: 'bitbucket', label: 'Bitbucket' }
};

/** The public host of each provider, matched exactly. */
const PUBLIC_HOSTS: Record<string, ScmProviderId> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket'
};

const SELF_HOSTED_ORDER: ScmProviderId[] = ['gitlab', 'bitbucket', 'github'];

/**
 * Identifies the provider behind a repo URL, or `undefined` for a host we do not
 * recognize.
 *
 * Self-hosted instances are matched by name — first on the leading hostname
 * label (`gitlab.company.com`), then anywhere in the hostname. The second, looser
 * pass is what the GitHub-only predecessor did (`hostname.includes('github')`),
 * kept so no URL that used to be accepted is now rejected, and extended to the
 * other two providers for symmetry. A host that only *mentions* a provider name
 * can therefore be misread; the backend then reports the real provider mismatch.
 */
export function scmProviderFromUrl(url: string): ScmProviderInfo | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const exact = PUBLIC_HOSTS[hostname];
  if (exact) {
    return PROVIDERS[exact];
  }
  const firstLabel = hostname.split('.')[0];
  const byLabel = SELF_HOSTED_ORDER.find((id) => firstLabel === id);
  if (byLabel) {
    return PROVIDERS[byLabel];
  }
  const bySubstring = SELF_HOSTED_ORDER.find((id) => hostname.includes(id));
  return bySubstring ? PROVIDERS[bySubstring] : undefined;
}

/**
 * Validates a pasted repository URL. Returns an error string, or `undefined`
 * when the URL is usable.
 *
 * Deliberately shallow — it rejects what is definitely wrong (an unparseable
 * URL, an unknown host, a file URL, a bare host with no project) and leaves
 * everything else to the backend, whose per-provider grammar is authoritative.
 */
export function validateScmRepoUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a valid URL.';
  }
  const provider = scmProviderFromUrl(value);
  if (!provider) {
    return 'Enter a GitHub, GitLab, or Bitbucket repository URL.';
  }
  // GitHub `/blob/<ref>/<file>` and GitLab `/-/blob/<ref>/<file>` are file URLs,
  // not trees. Bitbucket has no distinct form — `/src/` serves both — so a
  // Bitbucket file URL falls through to the backend.
  if (parsed.pathname.includes('/blob/')) {
    return 'Enter a repository URL, not a file (/blob/) URL.';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return provider.id === 'gitlab'
      ? 'URL must include a group and project (group/project).'
      : 'URL must include owner and repository (owner/repo).';
  }
  return undefined;
}
