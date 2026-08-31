/**
 * The single fetch + detect + extract + GENERATE seam behind `kind: Bruno`.
 *
 * Both the `BrunoKindProcessor` (authored `catalog-info.yaml` entities) and the
 * `BrunoCollectionEntityProvider` (`bruno.collections[]` entities) go through
 * one shared instance, so two entities pointing at the same repo share a single
 * `readTree` call. The cache is not an optimisation: the catalog reprocesses
 * every entity every 100-150s by default, so an uncached probe would hammer the
 * SCM host.
 *
 * One tree read produces BOTH the manifest metadata and the collection's
 * OpenCollection definition, cached as one entry — splitting them into a cheap
 * and an expensive probe would cost a second read whenever the provider warmed a
 * manifest-only entry that the processor then had to upgrade.
 *
 * Past the TTL the read is an ETag revalidation, not a re-download: every reader
 * we use resolves the commit sha first and throws `NotModifiedError` before
 * fetching the tarball, so a stale-but-unchanged entry costs one metadata API
 * call and skips parsing and generation entirely. A matching etag is also a
 * stronger byte-stability guarantee than generator determinism alone.
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
import { buildDefinition, type DefinitionOptions } from './definitionBuilder';

/**
 * Deliberately short. With ETag revalidation the marginal cost of a stale entry
 * is one metadata API call rather than a tarball download plus a full parse, and
 * this value is the upper bound on how long the PRD's Sync button takes to show
 * new content — a five-minute window makes it look broken.
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
   * `bruno.cacheTtlSeconds`, which ETag revalidation makes cheap enough to keep
   * short. Do not wire a cross-plugin import to reach this (BE-P2 §1 Q3); it
   * stays as the correct seam for the day the cache becomes shared.
   */
  evict(url: string): void;
  /** The provider-normalized form of `url`; the cache key and the value the
   *  provider stamps as its location annotation. */
  normalize(url: string): string;
}

/** `etag` is the reader's identity for the tree the entry was built from; with
 *  it a stale entry can be revalidated instead of re-read. */
type CacheEntry
  = | {
    kind: 'found';
    value: CollectionSnapshot;
    etag?: string;
    fetchedAt: number;
  }
  | { kind: 'absent'; etag?: string; fetchedAt: number }
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

  async function probe(url: string): Promise<CollectionSnapshot | undefined> {
    const provider = providers.byUrl(url);
    const normalized = provider.normalizeUrl(url);

    const cached = lruTouch(normalized);
    if (cached && isFresh(cached, Date.now())) {
      return unwrap(cached);
    }

    // A stale non-error entry is REVALIDATED rather than re-read: handing the
    // reader the etag it gave us makes it resolve the commit sha and stop there
    // when nothing moved, so the whole cycle is one metadata API call.
    const previousEtag
      = cached && cached.kind !== 'error' ? cached.etag : undefined;

    let entry: CacheEntry;
    try {
      // Before the first read, so a self-hosted host with no `integrations`
      // entry produces the named diagnostic rather than a bare FetchUrlReader
      // failure further down.
      provider.assertConfigured(url);
      const read = await readTreeWithEtag({
        reader,
        url: normalized,
        logger,
        etag: previousEtag
      });
      const manifest = detectManifest(read.files, normalized, logger);
      entry = manifest
        ? {
            kind: 'found',
            value: toSnapshot(manifest, read.files, normalized),
            etag: read.etag,
            fetchedAt: Date.now()
          }
        // The etag is stored for the manifest-less case too, so a repo that is
        // not a Bruno collection is revalidated just as cheaply.
        : { kind: 'absent', etag: read.etag, fetchedAt: Date.now() };
    } catch (e) {
      if (isNotModified(e) && cached && cached.kind !== 'error') {
        // The tree is byte-for-byte what we already parsed. Restart the TTL and
        // hand back the SAME value instance: regenerating would produce an equal
        // string, but skipping it avoids a whole-tree parse on the hot path.
        // `debug`, not `info` — this runs once per entity per TTL.
        logger.debug(`Bruno collection tree unchanged (ETag): ${normalized}`);
        const revalidated: CacheEntry = { ...cached, fetchedAt: Date.now() };
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
 * `bruno.json`, matching `detectFormat` in `collectionService`; among manifests
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

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}
