/**
 * The gate in front of the two routes that take a URL from a REQUEST BODY —
 * `POST /collections/probe` and `POST /collections` — plus the per-user floor
 * on how often one caller may spend a cold probe.
 *
 * What it is defending against, precisely, because the obvious answer is the
 * wrong one. This is NOT an arbitrary-URL SSRF primitive: `readTree` dispatches
 * through `UrlReaderPredicateMux`, every SCM reader's predicate is
 * `url.host === integration.config.host`, and the only catch-all reader
 * (`FetchUrlReader`) has no `readTree` at all — so a link-local or loopback URL
 * already dies in the mux before a socket opens. What an ungated route DOES
 * hand any authenticated user is:
 *
 *  - A CROSS-TENANT EXISTENCE ORACLE. `integrations.byUrl()` is no guard here:
 *    `readGithubIntegrationConfigs` unconditionally appends a default
 *    `github.com` entry when the host configured none, and GitLab and Bitbucket
 *    Cloud self-default their public hosts the same way — so `byUrl` is truthy
 *    for every public repository URL on earth. "Does `<private-org>/<repo>`
 *    exist, and can this server's token read it?" is one POST away, and the
 *    reader's own error string comes back verbatim.
 *  - A QUOTA-BURNING PRIMITIVE. Each cold probe costs API calls plus a full
 *    tarball download, charged to the OPERATOR's integration credential.
 *  - A MEMORY AMPLIFIER. The probe cache holds 100 entries of up to
 *    `bruno.definition.maxBytes` each.
 *
 * Which is why the allowlist is TWO-DIMENSIONAL — host AND repo-path prefix.
 * A host-only allowlist naming `github.com`, which every adopter would write,
 * would buy nothing at all against the first of those.
 *
 * FAIL CLOSED: with no `bruno.allowedSources` configured, every URL from a
 * request body is refused. That is a deliberate break with the PoC's
 * paste-any-URL behaviour, so every refusal names the key to add.
 *
 * It does NOT apply to `bruno.collections[]` or `bruno.discovery[]`. Those URLs
 * were written by the operator in app-config.yaml; an operator who wrote one
 * has already consented to it, and gating them would break ingestion on every
 * existing install for no gain.
 */
import type { Config } from '@backstage/config';
import { InputError, NotAllowedError } from '@backstage/errors';
import type { ScmIntegrationRegistry } from '@backstage/integration';
import { inferTypeFromHost } from '../scm';
import { joinPosix } from '../posixPath';

/** The config key, quoted back in every refusal so an operator reading a
 *  browser console knows what to add without reading the source. */
const CONFIG_KEY = 'bruno.allowedSources';

/**
 * Hostnames that name the machine Backstage itself runs on, or the cloud
 * metadata endpoint. Neither can hold a Bruno collection, and both are the
 * classic SSRF targets — so they are refused by NAME as well as by the IP-literal
 * rule above them, which a hostname resolving to them would slip past.
 */
const REFUSED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** A dotted quad, in the canonical form the WHATWG URL parser rewrites every
 *  other IPv4 spelling (`2130706433`, `0177.0.0.1`) into for an http(s) URL. */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** One `bruno.allowedSources[]` entry. */
export interface AllowedSource {
  /** Exact hostname, or `*.example.com` for it and any deeper subdomain. */
  host: string;
  /** Whole-segment path prefixes. Absent or empty allows the whole host. */
  pathPrefixes?: string[];
  /** Whether `http:` is accepted for this host. */
  allowInsecure?: boolean;
}

/**
 * Reads `bruno.allowedSources`. Returns [] when the key is absent, which is
 * what makes the gate refuse everything.
 *
 * Unlike `readBrunoCollections`, a malformed entry THROWS rather than being
 * logged and skipped. That loader runs inside a scheduled task where one bad
 * entry must not unpublish the others; this one is a security control read once
 * at construction, and an entry silently dropped is a rule the operator
 * believes is in force and is not. Failing the plugin's init is the honest
 * outcome.
 */
export function readAllowedSources(config: Config): AllowedSource[] {
  const entries = config.getOptionalConfigArray(CONFIG_KEY) ?? [];
  return entries.map((entry) => ({
    host: entry.getString('host').trim().toLowerCase(),
    pathPrefixes: entry.getOptionalStringArray('pathPrefixes'),
    allowInsecure: entry.getOptionalBoolean('allowInsecure')
  }));
}

/**
 * `*.example.com` matches any subdomain at any depth but NOT `example.com`
 * itself — an operator who wants the apex adds it as its own entry, so
 * delegating a subdomain is never the same decision as trusting the apex.
 */
function hostMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('*.')) {
    return hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2);
  }
  return hostname === pattern;
}

/**
 * A path reduced to its non-empty segments, lower-cased, so the comparison is
 * over SEGMENTS rather than characters: `/acme` covers `/acme/payments` and not
 * `/acme-legacy/x`, which a `startsWith` on the raw strings gets wrong.
 *
 * Lower-cased because SCM owner and repository names are case-insensitive on
 * all three supported hosts, so `/ACME/x` and `/acme/x` are one repository and
 * must be one answer. NOT percent-decoded: an escape in an owner segment cannot
 * occur on those hosts, and decoding would let `%2F` forge a segment boundary.
 */
function pathKey(path: string): string {
  return joinPosix(
    ...path.split('/').filter((s) => s !== '')
  ).toLocaleLowerCase('en-US');
}

/** Whether `prefix` covers `path`, on whole segments. An empty prefix — an
 *  entry naming the host root — covers everything under it. */
function pathCoveredBy(prefix: string, path: string): boolean {
  const p = pathKey(prefix);
  return p === '' || path === p || path.startsWith(`${p}/`);
}

/**
 * The `integrations.*` key an operator has to add for `hostname`, when the
 * grammar is guessable. Message-only, so a wrong guess costs nothing.
 */
function missingIntegrationHint(url: string, hostname: string): string {
  const type = inferTypeFromHost(url);
  return type
    ? `Add an \`integrations.${type}\` entry for ${hostname}`
    : `Add an \`integrations\` entry for ${hostname}`;
}

/**
 * Refuses a request-body URL that the operator has not allow-listed, BEFORE any
 * fetch is attempted, and returns the URL that was checked so the caller fetches
 * the exact string this approved rather than re-deriving one.
 *
 * The checks run cheapest-and-broadest first — parse, scheme, host shape,
 * integration, allowlist — so a refusal names the FIRST thing wrong rather than
 * the last, which is what makes the message actionable.
 *
 * @throws InputError when the URL will not parse, NotAllowedError otherwise.
 */
export function assertSourceAllowed(args: {
  url: string;
  integrations: ScmIntegrationRegistry;
  allowed: AllowedSource[];
}): string {
  const { integrations, allowed } = args;

  let parsed: URL;
  try {
    parsed = new URL(args.url.trim());
  } catch {
    // The caller's raw string is NOT quoted back: it is unvalidated input that
    // can hold newlines, and it is about to be echoed into an HTTP response.
    throw new InputError(
      'That is not a valid URL. Point at a collection folder on a host '
      + `listed under \`${CONFIG_KEY}\`, for example `
      + 'https://github.com/acme/payments/tree/main/collection.'
    );
  }
  const hostname = parsed.hostname.toLocaleLowerCase('en-US');
  const entries = allowed.filter((entry) => hostMatches(entry.host, hostname));

  if (parsed.protocol !== 'https:') {
    const insecureAllowed
      = parsed.protocol === 'http:' && entries.some((e) => e.allowInsecure);
    if (!insecureAllowed) {
      throw new NotAllowedError(
        `Only https:// collection URLs are accepted (got ${parsed.protocol}//). `
        + `Set \`allowInsecure: true\` on this host's \`${CONFIG_KEY}\` entry `
        + 'to accept http:// as well.'
      );
    }
  }

  // An IP literal can never be a host with an SCM integration — every
  // integration matches on a hostname — so this rejects nothing legitimate,
  // and it is the shape that makes 169.254.169.254 and [::1] interesting.
  if (
    hostname.startsWith('[')
    || IPV4_LITERAL.test(hostname)
    || REFUSED_HOSTNAMES.has(hostname)
    || hostname.endsWith('.localhost')
  ) {
    throw new NotAllowedError(
      'A collection URL must name a source-control host. '
      + `${hostname} is not one.`
    );
  }

  if (!integrations.byUrl(parsed.toString())) {
    throw new NotAllowedError(
      `Backstage has no source-control integration for ${hostname}, so it `
      + `cannot read a collection there. ${missingIntegrationHint(
        parsed.toString(),
        hostname
      )}, then list it under \`${CONFIG_KEY}\`.`
    );
  }

  const path = pathKey(parsed.pathname);
  const permitted = entries.some(
    (entry) =>
      (entry.pathPrefixes ?? []).length === 0
      || entry.pathPrefixes!.some((prefix) => pathCoveredBy(prefix, path))
  );
  if (!permitted) {
    throw new NotAllowedError(
      `This Backstage instance does not accept collection URLs under `
      + `${hostname}/${path}. An administrator adds it with a \`${CONFIG_KEY}\` `
      + `entry: \`- host: ${hostname}\` with \`pathPrefixes: [/<owner>]\`. `
      + 'Collections declared in `bruno.collections[]` or found by '
      + '`bruno.discovery[]` are unaffected by this list.'
    );
  }

  return parsed.toString();
}

/** Probes one user may spend per window before the backstop refuses them. */
const DEFAULT_PROBE_LIMIT = 30;
const DEFAULT_PROBE_WINDOW_MS = 60_000;
/** Buckets retained before expired ones are swept. One small object per user
 *  who has probed inside the current window. */
const MAX_TRACKED_PRINCIPALS = 10_000;

export interface ProbeRateLimiter {
  /**
   * Records one probe against `userEntityRef`'s budget. Returns the seconds to
   * wait when the budget is spent, or `undefined` when it is not.
   */
  spend(userEntityRef: string): number | undefined;
}

/**
 * A fixed-window, in-memory, per-USER floor under the probe route.
 *
 * Be honest about what this is and is not. It is PER REPLICA and per process,
 * so it is a weak quota: n replicas multiply the real limit by n, and a restart
 * clears it. The production answer is Backstage's own
 * `createRateLimitMiddleware`, which sits in front of `/api/bruno` and turns on
 * purely by the presence of `backend.rateLimit.plugin.bruno` — it supports a
 * Redis store, so it counts correctly across replicas. Its limitation is the
 * mirror image of this one's: it is IP-keyed and plugin-wide, so a shared
 * corporate egress IP makes one user's burst everyone's 429, and it cannot tell
 * a cold probe from a `/health` poll.
 *
 * This one is therefore the floor for an operator who never configured that
 * key: it costs nothing, it is keyed on the authenticated principal rather than
 * a spoofable transport detail, and it bounds the single most expensive thing
 * one authenticated user can ask this plugin to do.
 */
export function createProbeRateLimiter(options?: {
  limit?: number;
  windowMs?: number;
}): ProbeRateLimiter {
  const limit = options?.limit ?? DEFAULT_PROBE_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_PROBE_WINDOW_MS;
  const buckets = new Map<string, { windowStart: number; count: number }>();

  return {
    spend(userEntityRef: string): number | undefined {
      const now = Date.now();
      if (buckets.size > MAX_TRACKED_PRINCIPALS) {
        for (const [ref, bucket] of buckets) {
          if (now - bucket.windowStart >= windowMs) {
            buckets.delete(ref);
          }
        }
      }

      const bucket = buckets.get(userEntityRef);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        buckets.set(userEntityRef, { windowStart: now, count: 1 });
        return undefined;
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        // At least 1: a `Retry-After: 0` reads as "retry immediately", which is
        // the opposite of what a spent budget means.
        return Math.max(
          1,
          Math.ceil((bucket.windowStart + windowMs - now) / 1000)
        );
      }
      return undefined;
    }
  };
}
