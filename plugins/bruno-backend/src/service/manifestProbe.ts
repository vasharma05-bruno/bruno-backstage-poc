/**
 * The single fetch + detect + extract + GENERATE seam behind `kind: Bruno`.
 *
 * `BrunoKindProcessor` is the only background consumer: the catalog reprocesses
 * every entity every 100-150s by default, so an uncached probe would hammer the
 * SCM host. (`BrunoCollectionEntityProvider` deliberately does NOT probe — its
 * enrichment was a duplicate of the processor's, so it now reads nothing; see
 * that class's header.)
 *
 * One tree read produces BOTH the manifest metadata and the collection's
 * OpenCollection definition, cached as one entry — splitting them into a cheap
 * and an expensive probe would cost a second read whenever one warmed a
 * manifest-only entry that the other then had to upgrade.
 *
 * PAST THE TTL, TWO REVALIDATION TIERS, cheapest first:
 *
 *  1. A conditional HTTP request via `ScmProvider.checkTreeIdentity`. An
 *     authenticated GitHub 304 costs no rate-limit quota at all, so an unchanged
 *     collection on a host with an `integrations.github` credential is free.
 *     GitLab and Bitbucket Cloud have no implementation and skip to tier 2.
 *  2. The reader's ETag. Worth being precise about, because the shape of this
 *     module used to assume otherwise: it is a CLIENT-SIDE commit-sha compare,
 *     not an HTTP 304 — the reader spends 1-2 API calls resolving the sha and
 *     only then throws `NotModifiedError`. It saves the tarball download and
 *     the parse; it saves no quota. Hence tier 1.
 *
 * Either tier matching is also a stronger byte-stability guarantee than
 * generator determinism alone.
 *
 * Credential isolation: reads go through the injected `UrlReaderService` using
 * the host's `integrations.*` credentials only. There is deliberately NO
 * `userToken` parameter — no user request exists behind a processor or a
 * scheduled provider run, and not having the parameter is the strongest
 * guarantee a caller's OAuth token can never reach a log line here.
 */
import type {
  LoggerService,
  UrlReaderService
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { NotModifiedError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations
} from '@backstage/integration';
import yaml from 'js-yaml';
import {
  createScmProviderRegistry,
  isBrunoJsonManifest,
  isOpenCollectionManifest,
  readTreeWithEtag
} from '../scm';
import type { TreeIdentity, TreeIdentityCheck } from '../scm/treeIdentity';
import type { ScmProvider } from '../scm/types';
import { buildDefinition, type DefinitionOptions } from './definitionBuilder';
import { posixDirname } from '../posixPath';

/**
 * Deliberately short. It is the upper bound on how long the PRD's Sync button
 * takes to show new content — a five-minute window makes it look broken — and
 * the marginal cost of a stale entry is now a conditional request the host
 * answers 304 to, which on an authenticated GitHub host is free.
 */
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
/** Entries now carry a whole definition, so the cache's worst-case footprint is
 *  `max × bruno.definition.maxBytes` — 100 MiB at the 1 MiB cap, ~15 MB at
 *  realistic collection sizes. */
const DEFAULT_MAX = 100;
/** `metadata.description` is prose; title and version are single-line labels. */
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_LABEL_LENGTH = 255;

/** The collection metadata a Bruno manifest carries. */
export interface CollectionManifest {
  format: 'bru' | 'yml';
  /** Repo-relative path of the manifest that was found. */
  manifestPath: string;
  /** The manifest's directory — the collection root within the tree. */
  rootPrefix: string;
  name?: string;
  version?: string;
  description?: string;
}

/**
 * A manifest plus the generated OpenCollection definition for the whole
 * collection. One `readTree` produces both, so the processor and the provider
 * share a single fetch.
 */
export interface CollectionSnapshot extends CollectionManifest {
  /** OpenCollection YAML, redacted per `bruno.definition.redaction`.
   *  Undefined when generation failed or the cap was exceeded. */
  definition?: string;
  definitionBytes: number;
  definitionOmitted?: 'size' | 'error';
  /** Executable requests in the collection. Present whenever the parse
   *  succeeded, INCLUDING when the definition was omitted for size. */
  requestCount?: number;
  /** Environment names. Same availability as `requestCount`. */
  environments?: string[];
}

export interface ManifestProbe {
  /** Resolves to the collection snapshot, or `undefined` when the tree read
   *  fine but contained NO bruno.json / opencollection.{yml,yaml}.
   *  THROWS only on a read/auth/network failure. Callers must distinguish. */
  probe(url: string): Promise<CollectionSnapshot | undefined>;
  /**
   * Drops the cache entry for `url`.
   *
   * Still unused, and deliberately so: the obvious caller would be a Sync HTTP
   * route, but this instance is constructed inside the CATALOG module and the
   * Bruno router lives in the `bruno` plugin, so reaching it from there is a
   * shared in-process import across a plugin boundary — and silently wrong on
   * any multi-replica deployment, where the evict lands in a process that is not
   * the one serving the next processing run. Sync instead converges within
   * `bruno.cacheTtlSeconds`, which conditional-request revalidation makes cheap
   * enough to keep short. Do not wire a cross-plugin import to reach this (BE-P2 §1 Q3); it
   * stays as the correct seam for the day the cache becomes shared.
   */
  evict(url: string): void;
  /** The provider-normalized form of `url`; the cache key and the value the
   *  provider stamps as its location annotation. */
  normalize(url: string): string;
}

/**
 * Two identities per entry, for the two revalidation paths, cheapest first.
 *
 * `identity` is the provider's handle for a CONDITIONAL HTTP request. When the
 * host answers 304 the entry is current and, on GitHub, the exchange cost no
 * rate-limit quota at all.
 *
 * `etag` is the reader's own tree identity, which it compares CLIENT-SIDE after
 * spending 1-2 API calls to resolve the commit sha. It saves the tarball
 * download, not the quota — which is exactly why `identity` is tried first.
 */
type CacheEntry
  = | {
    kind: 'found';
    value: CollectionSnapshot;
    etag?: string;
    identity?: TreeIdentity;
    fetchedAt: number;
  }
  | {
    kind: 'absent';
    etag?: string;
    identity?: TreeIdentity;
    fetchedAt: number;
  }
  | { kind: 'error'; message: string; fetchedAt: number };

export function createManifestProbe(options: {
  config: Config;
  reader: UrlReaderService;
  logger: LoggerService;
  /** The resolved `bruno.definition` block. Required: the caller reads it from
   *  config, so there is no sensible default to invent here. */
  definition: DefinitionOptions;
  ttlMs?: number;
  failureTtlMs?: number;
  max?: number;
}): ManifestProbe {
  const { config, reader, logger, definition } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  // Never longer than `ttlMs`, so a repaired repo (a fixed token, a pushed
  // manifest) recovers within a single catalog reprocess cycle.
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const max = options.max ?? DEFAULT_MAX;

  const integrations = ScmIntegrations.fromConfig(config);
  const providers = createScmProviderRegistry({
    integrations,
    githubCredentials:
      DefaultGithubCredentialsProvider.fromIntegrations(integrations)
  });

  const cache = new Map<string, CacheEntry>();

  /** Inserts `k`→`v` at the MRU tail, evicting the oldest key past `max`. */
  function lruSet(k: string, v: CacheEntry): void {
    cache.delete(k);
    cache.set(k, v);
    if (cache.size > max) {
      cache.delete(cache.keys().next().value as string);
    }
  }

  /** Reads `k`, promoting it to the MRU tail on a hit. */
  function lruTouch(k: string): CacheEntry | undefined {
    const v = cache.get(k);
    if (v !== undefined) {
      cache.delete(k);
      cache.set(k, v);
    }
    return v;
  }

  function isFresh(entry: CacheEntry, now: number): boolean {
    const ttl = entry.kind === 'error' ? failureTtlMs : ttlMs;
    return now - entry.fetchedAt < ttl;
  }

  function normalize(url: string): string {
    return providers.byUrl(url).normalizeUrl(url);
  }

  function unwrap(entry: CacheEntry): CollectionSnapshot | undefined {
    if (entry.kind === 'error') {
      throw new Error(entry.message);
    }
    return entry.kind === 'found' ? entry.value : undefined;
  }

  /**
   * `instanceof` alone is not enough here. It holds only while exactly one copy
   * of `@backstage/errors` is installed, and the reader that constructs this
   * error lives in a different package. Were a second copy ever hoisted, every
   * revalidation would silently fall through to the error branch — the entity
   * would keep landing (the processor degrades rather than failing), but the
   * whole ETag optimisation would be dead with nothing to show for it. The name
   * check costs one comparison and makes that failure impossible.
   */
  function isNotModified(e: unknown): boolean {
    return e instanceof NotModifiedError || (e as Error)?.name === 'NotModifiedError';
  }

  /**
   * Runs the provider's conditional-request check, downgrading EVERY failure to
   * "could not tell".
   *
   * Total by design. This is an optimisation in front of a read the caller is
   * willing to make anyway, so a provider with no implementation (GitLab,
   * Bitbucket Cloud), a host that answers oddly, and a network blip must all
   * land on that read rather than failing the probe. The read's error is the one
   * worth surfacing — it is the one that names the URL and the credential.
   */
  async function checkIdentity(
    provider: ScmProvider,
    url: string,
    cached: TreeIdentity | undefined
  ): Promise<TreeIdentityCheck | undefined> {
    if (!provider.checkTreeIdentity) {
      return undefined;
    }
    try {
      return await provider.checkTreeIdentity({ url, cached });
    } catch (e) {
      logger.debug(
        `Bruno collection tree identity check failed for ${url}; falling back `
        + `to a full read: ${String((e as Error)?.message ?? e)}`
      );
      return undefined;
    }
  }

  async function probe(url: string): Promise<CollectionSnapshot | undefined> {
    const provider = providers.byUrl(url);
    const normalized = provider.normalizeUrl(url);

    const cached = lruTouch(normalized);
    if (cached && isFresh(cached, Date.now())) {
      return unwrap(cached);
    }

    // The only entry worth revalidating. An `error` entry has no tree behind it,
    // so there is nothing to compare against and both cheap paths are unusable.
    const reusable = cached && cached.kind !== 'error' ? cached : undefined;

    // Hoisted out of the `try` because the `NotModifiedError` branch below has
    // to store it too — see the comment there. It is the identity to persist
    // with whatever this run produces.
    let nextIdentity: TreeIdentity | undefined = reusable?.identity;

    let entry: CacheEntry;
    try {
      // Before the first read, so a self-hosted host with no `integrations`
      // entry produces the named diagnostic rather than a bare FetchUrlReader
      // failure further down.
      provider.assertConfigured(url);

      // TIER 1 — a conditional HTTP request, and the whole reason for this
      // ordering. An authenticated GitHub 304 costs no rate-limit quota, so a
      // collection nobody has pushed to is free per cycle. Skipped when there
      // is nothing cached: with no snapshot to keep, the check could only ever
      // report `changed` and would be a pure extra call.
      const check = reusable
        ? await checkIdentity(provider, normalized, reusable.identity)
        : undefined;

      // `reusable` is implied by `check` being defined at all, but restating it
      // is what lets the spread below narrow.
      if (reusable && check?.status === 'unchanged') {
        // Restart the TTL and hand back the SAME value instance — regenerating
        // would produce an equal string, but skipping it avoids a whole-tree
        // parse. `debug`, not `info`: this is the hot path, once per entity per
        // TTL forever.
        logger.debug(
          `Bruno collection tree unchanged (conditional request): ${normalized}`
        );
        const revalidated: CacheEntry = { ...reusable, fetchedAt: Date.now() };
        lruSet(normalized, revalidated);
        return unwrap(revalidated);
      }
      if (check?.status === 'changed') {
        nextIdentity = check.identity;
      }

      // TIER 2 — the reader's own etag. Reached when nothing is cached, when
      // tier 1 said the tree moved, or when it could not tell. Handing back the
      // etag it gave us still saves the TARBALL when only the repo's identity
      // moved; it does not save the 1-2 calls spent reaching that verdict.
      const read = await readTreeWithEtag({
        reader,
        url: normalized,
        logger,
        etag: reusable?.etag
      });
      const manifest = detectManifest(read.files, normalized, logger);
      entry = manifest
        ? {
            kind: 'found',
            value: toSnapshot(manifest, read.files, normalized),
            etag: read.etag,
            identity: nextIdentity,
            fetchedAt: Date.now()
          }
        // Both identities are stored for the manifest-less case too, so a repo
        // that is not a Bruno collection is revalidated just as cheaply.
        : {
            kind: 'absent',
            etag: read.etag,
            identity: nextIdentity,
            fetchedAt: Date.now()
          };
    } catch (e) {
      if (isNotModified(e) && reusable) {
        // The tree is byte-for-byte what we already parsed.
        logger.debug(`Bruno collection tree unchanged (ETag): ${normalized}`);
        const revalidated: CacheEntry = {
          ...reusable,
          // Carried forward HERE TOO, and this is load-bearing rather than
          // tidy. An entry with no stored identity — every entry on its first
          // cycle — makes tier 1 answer `changed` for want of an
          // `If-None-Match`, and it is this read that discovers nothing moved.
          // Dropping the identity tier 1 just learned would replay the empty
          // `If-None-Match` forever, so the free path would never be reached at
          // all: the seeding call has to be paid once, not every cycle.
          identity: nextIdentity,
          fetchedAt: Date.now()
        };
        lruSet(normalized, revalidated);
        return unwrap(revalidated);
      }
      lruSet(normalized, {
        kind: 'error',
        message: String((e as Error)?.message ?? e),
        fetchedAt: Date.now()
      });
      throw e;
    }

    lruSet(normalized, entry);
    return unwrap(entry);
  }

  /** Pairs the manifest metadata with the generated definition. `buildDefinition`
   *  never throws, so this cannot fail the probe. */
  function toSnapshot(
    manifest: CollectionManifest,
    tree: Map<string, string>,
    normalizedUrl: string
  ): CollectionSnapshot {
    const built = buildDefinition({
      tree,
      url: normalizedUrl,
      name: manifest.name,
      logger,
      options: definition
    });
    return {
      ...manifest,
      ...(built.definition !== undefined && { definition: built.definition }),
      definitionBytes: built.bytes,
      ...(built.omitted !== undefined && { definitionOmitted: built.omitted }),
      ...(built.requestCount !== undefined && {
        requestCount: built.requestCount
      }),
      ...(built.environments !== undefined && {
        environments: built.environments
      })
    };
  }

  return {
    probe,
    normalize,
    evict(url: string): void {
      cache.delete(normalize(url));
    }
  };
}

/**
 * Picks the manifest for a tree. `opencollection.yml/.yaml` wins over
 * `bruno.json`, matching `detectFormat` in `collectionParser.ts`; among
 * manifests
 * of the same kind the shortest path wins, so the shallowest is chosen. Within
 * one directory that also settles the two spellings: `.yml` is a character
 * shorter than `.yaml`, so `.yml` wins — which is what Bruno writes today. The
 * length-tie branch is for equal-length paths in sibling directories, replacing
 * Map iteration order with a deterministic choice.
 */
function detectManifest(
  tree: Map<string, string>,
  url: string,
  logger: LoggerService
): CollectionManifest | undefined {
  const openCollectionPath = findShallowest(tree, isOpenCollectionManifest);
  if (openCollectionPath) {
    return {
      format: 'yml',
      manifestPath: openCollectionPath,
      rootPrefix: posixDirname(openCollectionPath),
      ...extractOpenCollection(tree.get(openCollectionPath)!, url, logger)
    };
  }

  const brunoJsonPath = findShallowest(tree, isBrunoJsonManifest);
  if (brunoJsonPath) {
    return {
      format: 'bru',
      manifestPath: brunoJsonPath,
      rootPrefix: posixDirname(brunoJsonPath),
      ...extractBrunoJson(tree.get(brunoJsonPath)!, url, logger)
    };
  }

  return undefined;
}

function findShallowest(
  tree: Map<string, string>,
  matches: (relPath: string) => boolean
): string | undefined {
  let best: string | undefined;
  for (const key of tree.keys()) {
    if (!matches(key)) {
      continue;
    }
    if (
      best === undefined
      || key.length < best.length
      || (key.length === best.length && key < best)
    ) {
      best = key;
    }
  }
  return best;
}

type ManifestMetadata = Pick<
  CollectionManifest,
  'name' | 'version' | 'description'
>;

function extractBrunoJson(
  raw: string,
  url: string,
  logger: LoggerService
): ManifestMetadata {
  let parsed: { name?: unknown; version?: unknown; description?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logger.warn(
      `Could not parse bruno.json at ${url}: ${String((e as Error)?.message ?? e)}`
    );
    return {};
  }
  // `JSON.parse('null')` and `JSON.parse('"x"')` return without throwing, so
  // the catch above does not cover them; reading a property off the result
  // would throw out of the extractor and be misreported as a read failure.
  if (!parsed || typeof parsed !== 'object') {
    logger.warn(`Ignoring non-object bruno.json at ${url}`);
    return {};
  }
  return {
    name: label(parsed.name),
    version: version(parsed.version),
    description: description(parsed.description)
  };
}

/**
 * Parses the raw manifest rather than routing it through `@usebruno/filestore`'s
 * `parseCollection`: that helper defaults a nameless collection to the literal
 * `"Untitled Collection"`, which would then be written into `metadata.title` as
 * if it were a real name, and it never surfaces `info.summary`.
 *
 * `@opencollection/types` `Info` is `{ name?, summary?, version?, authors? }` —
 * `summary` IS the description field; there is no `info.description`.
 */
function extractOpenCollection(
  raw: string,
  url: string,
  logger: LoggerService
): ManifestMetadata {
  let parsed: { info?: { name?: unknown; summary?: unknown; version?: unknown } };
  try {
    parsed = (yaml.load(raw) ?? {}) as typeof parsed;
  } catch (e) {
    logger.warn(
      `Could not parse opencollection.yml/.yaml at ${url}: ${
        String((e as Error)?.message ?? e)
      }`
    );
    return {};
  }
  const info = parsed.info ?? {};
  return {
    name: label(info.name),
    version: version(info.version),
    description: description(info.summary)
  };
}

/** Trims and clamps a single-line label; empty after trimming becomes absent
 *  so the callers' `??` fallbacks behave. */
function label(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : undefined;
}

/** `EntityMeta` is `additionalProperties: true`, so an unquoted YAML version
 *  would otherwise persist as a number. Coerce scalars to a string. */
function version(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === 'object') {
    return undefined;
  }
  return label(String(value));
}

/** Collapses a multi-line summary to its first non-empty line. */
function description(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const line = value
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ? line.slice(0, MAX_DESCRIPTION_LENGTH) : undefined;
}
