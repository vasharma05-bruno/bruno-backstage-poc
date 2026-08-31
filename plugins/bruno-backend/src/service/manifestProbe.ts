/**
 * The single fetch + detect + extract seam behind `kind: Bruno`.
 *
 * Both the `BrunoKindProcessor` (authored `catalog-info.yaml` entities) and the
 * `BrunoCollectionEntityProvider` (`bruno.collections[]` entities) go through
 * one shared instance, so two entities pointing at the same repo share a single
 * `readTree` call. The cache is not an optimisation: the catalog reprocesses
 * every entity every 100-150s by default, so an uncached probe would hammer the
 * SCM host.
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
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations
} from '@backstage/integration';
import yaml from 'js-yaml';
import {
  createScmProviderRegistry,
  isBrunoJsonManifest,
  isOpenCollectionManifest,
  readTreeViaUrlReader
} from '../scm';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const DEFAULT_MAX = 200;
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

export interface ManifestProbe {
  /** Resolves to the manifest metadata, or `undefined` when the tree read
   *  fine but contained NO bruno.json / opencollection.{yml,yaml}.
   *  THROWS only on a read/auth/network failure. Callers must distinguish. */
  probe(url: string): Promise<CollectionManifest | undefined>;
  /** Drops the cache entry for `url`. Unused in Phase 1; the seam Phase 2's
   *  Sync uses to force a re-fetch. */
  evict(url: string): void;
  /** The provider-normalized form of `url`; the cache key and the value the
   *  provider stamps as its location annotation. */
  normalize(url: string): string;
}

type CacheEntry
  = | { kind: 'found'; value: CollectionManifest; fetchedAt: number }
    | { kind: 'absent'; fetchedAt: number }
    | { kind: 'error'; message: string; fetchedAt: number };

export function createManifestProbe(options: {
  config: Config;
  reader: UrlReaderService;
  logger: LoggerService;
  ttlMs?: number;
  failureTtlMs?: number;
  max?: number;
}): ManifestProbe {
  const { config, reader, logger } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  // Shorter than `ttlMs` so a repaired repo (a fixed token, a pushed manifest)
  // recovers within a single catalog reprocess cycle instead of five minutes.
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

  function unwrap(entry: CacheEntry): CollectionManifest | undefined {
    if (entry.kind === 'error') {
      throw new Error(entry.message);
    }
    return entry.kind === 'found' ? entry.value : undefined;
  }

  async function probe(url: string): Promise<CollectionManifest | undefined> {
    const provider = providers.byUrl(url);
    const normalized = provider.normalizeUrl(url);

    const cached = lruTouch(normalized);
    if (cached && isFresh(cached, Date.now())) {
      return unwrap(cached);
    }

    let entry: CacheEntry;
    try {
      // Before the first read, so a self-hosted host with no `integrations`
      // entry produces the named diagnostic rather than a bare FetchUrlReader
      // failure further down.
      provider.assertConfigured(url);
      const tree = await readTreeViaUrlReader({
        reader,
        url: normalized,
        logger
      });
      const manifest = detectManifest(tree, normalized, logger);
      entry = manifest
        ? { kind: 'found', value: manifest, fetchedAt: Date.now() }
        : { kind: 'absent', fetchedAt: Date.now() };
    } catch (e) {
      lruSet(normalized, {
        kind: 'error',
        message: (e as Error).message,
        fetchedAt: Date.now()
      });
      throw e;
    }

    lruSet(normalized, entry);
    return unwrap(entry);
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
        (e as Error).message
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
