import type { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations
} from '@backstage/integration';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  BrunoSourceConfig,
  CollectionDetail,
  CollectionSummary,
  Dashboard,
  DashboardCollection,
  DiscoveredCollection,
  DiscoverResult,
  SourceFailure
} from '../types';
import type { BrunoConnectionRow } from '../store/connectionStore';
import type { ImportedCollectionRow } from '../store/collectionsStore';
import {
  createScmProviderRegistry,
  isBrunoJsonManifest,
  normalizePathStyleUrl,
  readTreeViaUrlReader,
  selectCollectionFiles,
  type ScmProvider
} from '../scm';
// Parsing lives in its own module — the part of this file that survives the
// deletion of the annotation model. One direction only: never the reverse.
import {
  countRequests,
  findAllCollectionRoots,
  findBrunoJson,
  findOpenCollectionYml,
  parseCollection,
  sliceTreeAtRoot,
  toPosix,
  type FileTree
} from './collectionParser';

interface CachedCollection extends CollectionDetail {}

type ConnectedEntry = { detail: CachedCollection; fetchedAt: number };

type DiscoverEntry = { result: DiscoverResult; fetchedAt: number };

export interface CollectionService {
  listCollections(): CollectionSummary[];
  getCollection(id: string): CollectionDetail | undefined;
  connectFromUrl(input: {
    url: string;
    userToken?: string;
  }): Promise<{ collectionId: string; detail: CollectionDetail }>;
  syncCollection(input: {
    id: string;
    url: string;
    userToken?: string;
  }): Promise<CollectionDetail>;
  discoverCollections(input: {
    url: string;
    userToken?: string;
  }): Promise<DiscoverResult>;
  refresh(): Promise<void>;
  rebuildConnected(links: BrunoConnectionRow[]): Promise<void>;
  evictConnected(collectionId: string): void;
  getDashboard(
    links: BrunoConnectionRow[],
    imported: ImportedCollectionRow[]
  ): Dashboard;
}

const CONNECTED_TTL_MS = 10 * 60_000;
const CONNECTED_MAX = 200;
// A just-connected entry is written to the cache before its DB row is committed
// (POST /connections writes the cache, then upserts). Spare entries younger than
// this from the row-gone ghost-drop so a concurrent rebuild tick can't evict a
// connection that is mid-flight.
const CONNECTED_GRACE_MS = 10_000;
const DISCOVER_TTL_MS = 60_000;
const DISCOVER_MAX = 50;

/** Reads the `bruno.sources` block from Backstage config. Returns [] if absent. */
export function readBrunoSources(config: Config): BrunoSourceConfig[] {
  const brunoConfig = config.getOptionalConfig('bruno');
  if (!brunoConfig) {
    return [];
  }
  const sources = brunoConfig.getOptionalConfigArray('sources') ?? [];
  return sources.map((s) => ({
    id: s.getString('id'),
    name: s.getString('name'),
    type: s.getString('type') as 'local' | 'url',
    target: s.getString('target')
  }));
}

/** Sanitizes a source id into a valid Backstage entity name. */
export function sanitizeName(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || 'bruno-collection';
}

/**
 * Derives the stable cache key / collection id from a collection URL.
 *
 * Normalization is per-provider. Callers without a resolved provider fall back
 * to the shared path-style normalization — which is the same algorithm all three
 * implemented providers use, so the fallback is exact for GitHub, GitLab, and
 * Bitbucket Cloud alike. It would be wrong only for a query-string-ref provider
 * (Bitbucket Server, Azure); adding one means giving those callers a provider.
 */
export function collectionIdFromUrl(
  url: string,
  provider?: Pick<ScmProvider, 'normalizeUrl'>
): string {
  const normalized = provider
    ? provider.normalizeUrl(url)
    : normalizePathStyleUrl(url);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Creates the collection loader / parse service. Parses all configured sources
 * once eagerly (on the first `refresh()`), and keeps the parsed collections in
 * an in-memory cache.
 */
export async function createCollectionService(options: {
  logger: LoggerService;
  config: Config;
  reader: UrlReaderService;
  /** Repo root, used to resolve `local` targets robustly. */
  workingDir?: string;
}): Promise<CollectionService> {
  const { logger, config, reader } = options;
  const workingDir = options.workingDir ?? process.cwd();

  const cache = new Map<string, CachedCollection>();
  const connectedCache = new Map<string, ConnectedEntry>();
  const discoverCache = new Map<string, DiscoverEntry>();
  let failures: SourceFailure[] = [];
  const integrations = ScmIntegrations.fromConfig(config);
  const providers = createScmProviderRegistry({
    integrations,
    githubCredentials: DefaultGithubCredentialsProvider.fromIntegrations(integrations)
  });

  async function loadSource(
    source: BrunoSourceConfig
  ): Promise<CachedCollection | undefined> {
    try {
      let tree: FileTree;
      let sourceUrl: string | undefined;

      if (source.type === 'local') {
        tree = await readLocalTree(source.target, workingDir, logger);
      } else {
        sourceUrl = source.target;
        // Same diagnostic the connect/discover paths get: a self-hosted target
        // with no matching `integrations` entry otherwise fails with the
        // FetchUrlReader's error, which names neither the cause nor the fix.
        // The message lands in `failures` and surfaces on the dashboard.
        providers.byUrl(source.target).assertConfigured(source.target);
        tree = await readUrlTree(reader, source.target, logger);
      }

      const collection = parseCollection(source, tree, logger);
      const requestCount = countRequests(collection.items);

      return {
        id: source.id,
        name: collection.name,
        source: source.type,
        sourceUrl,
        requestCount,
        collection
      };
    } catch (error) {
      logger.error(
        `Failed to load Bruno collection "${source.id}" (${source.type}:${source.target}): ${
          (error as Error).message
        }`
      );
      failures.push({
        id: source.id,
        target: source.target,
        error: (error as Error).message
      });
      return undefined;
    }
  }

  /** Inserts `k`→`v` at the MRU tail, evicting the oldest key past `max`. */
  function lruSet<V>(m: Map<string, V>, k: string, v: V, max: number): void {
    m.delete(k);
    m.set(k, v);
    if (m.size > max) {
      m.delete(m.keys().next().value as string);
    }
  }

  /** Reads `k`, promoting it to the MRU tail on a hit. */
  function lruTouch<V>(m: Map<string, V>, k: string): V | undefined {
    const v = m.get(k);
    if (v !== undefined) {
      m.delete(k);
      m.set(k, v);
    }
    return v;
  }

  async function connectFromUrl(input: {
    url: string;
    userToken?: string;
  }): Promise<{ collectionId: string; detail: CollectionDetail }> {
    const provider = providers.byUrl(input.url);
    provider.assertConfigured(input.url);
    const normalized = provider.normalizeUrl(input.url);
    const collectionId = collectionIdFromUrl(normalized, provider);
    const tree = await readUrlTreeWithCreds(
      reader,
      provider,
      normalized,
      logger,
      { userToken: input.userToken }
    );
    const hasManifest
      = findBrunoJson(tree) !== undefined || findOpenCollectionYml(tree) !== undefined;
    if (!hasManifest) {
      throw new InputError(
        `No Bruno collection found at ${normalized} (missing bruno.json / opencollection.yml/.yaml)`
      );
    }
    const source: BrunoSourceConfig = {
      id: collectionId,
      name: collectionId,
      type: 'url',
      target: normalized
    };
    const collection = parseCollection(source, tree, logger);
    const requestCount = countRequests(collection.items);
    const detail: CachedCollection = {
      id: collectionId,
      name: collection.name,
      source: 'url',
      sourceUrl: normalized,
      requestCount,
      collection
    };
    lruSet(
      connectedCache,
      collectionId,
      { detail, fetchedAt: Date.now() },
      CONNECTED_MAX
    );
    return { collectionId, detail };
  }

  async function syncCollection(input: {
    id: string;
    url: string;
    userToken?: string;
  }): Promise<CollectionDetail> {
    // Re-fetch + re-parse from the SCM host. connectFromUrl refreshes
    // connectedCache
    // under collectionIdFromUrl(url) — the same key runtime-connected
    // collections already use, so their cache is updated in place.
    const { detail } = await connectFromUrl({
      url: input.url,
      userToken: input.userToken
    });
    // A static/provider collection lives in `cache` under its own id (which
    // may differ from collectionIdFromUrl(url)); mirror the fresh parse so
    // getCollection(id) returns updated data.
    if (cache.has(input.id)) {
      const mirrored: CachedCollection = { ...detail, id: input.id };
      cache.set(input.id, mirrored);
      return mirrored;
    }
    return detail;
  }

  /**
   * Reconciles `connectedCache` against the store rows: drops entries whose row
   * is gone (the only eviction path), and re-fetches stale/absent entries with
   * the SERVICE token. A re-fetch failure keeps the last good entry (D6).
   */
  async function rebuildConnected(
    links: BrunoConnectionRow[]
  ): Promise<void> {
    const liveIds = new Set(links.map((l) => l.collectionId));
    const now = Date.now();
    for (const [id, e] of [...connectedCache.entries()]) {
      if (!liveIds.has(id) && now - e.fetchedAt >= CONNECTED_GRACE_MS) {
        connectedCache.delete(id);
      }
    }
    for (const link of links) {
      const e = connectedCache.get(link.collectionId);
      if (e && now - e.fetchedAt <= CONNECTED_TTL_MS) {
        continue;
      }
      try {
        await connectFromUrl({ url: link.sourceUrl });
      } catch {
        logger.warn(
          `Background refresh of connected collection ${link.collectionId} failed; keeping cached copy.`
        );
      }
    }
  }

  async function refresh(): Promise<void> {
    const sources = readBrunoSources(config);
    if (sources.length === 0) {
      logger.warn('No `bruno.sources` configured; nothing to load.');
    }
    failures = [];
    const loaded = await Promise.all(sources.map(loadSource));
    cache.clear();
    for (const c of loaded) {
      if (c) {
        cache.set(c.id, c);
      }
    }
    logger.info(`Loaded ${cache.size} Bruno collection(s).`);
  }

  // Eager initial load.
  await refresh();

  return {
    listCollections(): CollectionSummary[] {
      return Array.from(cache.values()).map(
        ({ id, name, requestCount, source, sourceUrl }) => ({
          id,
          name,
          requestCount,
          source,
          sourceUrl
        })
      );
    },
    getCollection(id: string): CollectionDetail | undefined {
      const hit = cache.get(id);
      if (hit) {
        return hit;
      }
      const e = lruTouch(connectedCache, id);
      return e?.detail;
    },
    connectFromUrl,
    syncCollection,
    async discoverCollections(input: {
      url: string;
      userToken?: string;
    }): Promise<DiscoverResult> {
      const provider = providers.byUrl(input.url);
      provider.assertConfigured(input.url);
      const normalized = provider.normalizeUrl(input.url);
      const cached = lruTouch(discoverCache, normalized);
      if (cached && Date.now() - cached.fetchedAt <= DISCOVER_TTL_MS) {
        return cached.result;
      }
      const tree = await readUrlTreeWithCreds(
        reader,
        provider,
        normalized,
        logger,
        { userToken: input.userToken }
      );
      const ref = await resolveRef(provider, normalized, input.userToken);
      const roots = findAllCollectionRoots(tree);

      const collections: DiscoveredCollection[] = roots.map((rootPrefix) => {
        const sub = sliceTreeAtRoot(tree, rootPrefix);
        const source: BrunoSourceConfig = {
          id: 'discover',
          name: 'discover',
          type: 'url',
          target: normalized
        };
        const collection = parseCollection(source, sub, logger);
        const requestCount = countRequests(collection.items);
        const sourceUrl = provider.composeCollectionUrl(normalized, rootPrefix, ref);
        return {
          collectionPath: rootPrefix,
          name: collection.name,
          requestCount,
          collectionId: collectionIdFromUrl(sourceUrl, provider),
          sourceUrl
        };
      });

      lruSet(
        discoverCache,
        normalized,
        { result: { collections }, fetchedAt: Date.now() },
        DISCOVER_MAX
      );
      return { collections };
    },
    refresh,
    rebuildConnected,
    evictConnected(collectionId: string): void {
      connectedCache.delete(collectionId);
      logger.info(`Evicted connected collection ${collectionId} from cache.`);
    },
    getDashboard(
      links: BrunoConnectionRow[],
      imported: ImportedCollectionRow[]
    ): Dashboard {
      const byId = new Map<string, CachedCollection>();
      for (const c of cache.values()) {
        byId.set(c.id, c);
      }
      for (const e of connectedCache.values()) {
        byId.set(e.detail.id, e.detail);
      }
      const importedStubs = new Map<string, ImportedCollectionRow>();
      for (const row of imported) {
        if (!byId.has(row.collectionId)) {
          importedStubs.set(row.collectionId, row);
        }
      }
      const linksByCollectionId = new Map<string, BrunoConnectionRow>();
      for (const link of links) {
        linksByCollectionId.set(link.collectionId, link);
      }

      let totalRequests = 0;
      const collections: DashboardCollection[] = [];
      for (const c of byId.values()) {
        const link = linksByCollectionId.get(c.id);
        totalRequests += c.requestCount;
        collections.push({
          id: c.id,
          name: c.name,
          requestCount: c.requestCount,
          envCount: c.collection.environments.length,
          activeEnv: c.collection.environments[0]?.name,
          specType: 'bruno-collection',
          linked: link !== undefined,
          entityRef: link?.entityRef ?? `api:default/${sanitizeName(c.id)}`,
          sourceUrl: c.sourceUrl
        });
      }

      for (const row of importedStubs.values()) {
        collections.push({
          id: row.collectionId,
          name: row.name,
          requestCount: 0,
          envCount: 0,
          specType: undefined,
          linked: false,
          imported: true,
          sourceUrl: row.sourceUrl
          // entityRef intentionally omitted for stubs (D4)
        });
      }

      return {
        stats: {
          collections: collections.length,
          totalRequests,
          linkedEntities: links.length
        },
        collections,
        failures
      };
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Tree readers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reads a local collection directory from the filesystem. `target` in config is
 * documented as relative to `packages/backend` (like catalog locations), but we
 * are robust: we try a set of candidate base directories and use the first that
 * exists. The sample collections live at `<repoRoot>/sample-collections/*`.
 */
async function readLocalTree(
  target: string,
  workingDir: string,
  logger: LoggerService
): Promise<FileTree> {
  const candidates = path.isAbsolute(target)
    ? [target]
    : [
        // Relative to the Backstage working dir (usually the repo root when
        // running `yarn start`, or packages/backend depending on invocation).
        path.resolve(workingDir, target),
        // Relative to packages/backend, matching catalog location conventions.
        path.resolve(workingDir, 'packages', 'backend', target),
        // Relative to the repo root, two levels up from packages/backend.
        path.resolve(workingDir, '..', '..', target)
      ];

  let root: string | undefined;
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        root = candidate;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!root) {
    throw new Error(
      `Could not resolve local collection directory. Tried: ${candidates.join(
        ', '
      )}`
    );
  }

  logger.info(`Reading local Bruno collection from ${root}`);

  const walked = new Map<string, string>();
  await walkLocal(root, root, walked);

  // Post-pass, so a local tree gets exactly the admission rule and the sorted
  // order a remote one gets: whether a bare `.yaml` is a collection body file
  // depends on the presence of an `opencollection.yaml`, which no per-entry test
  // during the walk can know, and item order must not depend on readdir order
  // (`sortItems` falls back to insertion index when `seq` is absent).
  const files = new Map<string, string>();
  for (const rel of selectCollectionFiles(walked.keys())) {
    files.set(rel, walked.get(rel)!);
  }
  return { files };
}

async function walkLocal(
  dir: string,
  root: string,
  files: Map<string, string>
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      await walkLocal(full, root, files);
    } else if (entry.isFile()) {
      // The CANDIDATE set only. `.yaml` is admitted here and narrowed again by
      // the `selectCollectionFiles` post-pass in `readLocalTree`: telling an
      // OpenCollection body file from a stray `catalog-info.yaml` needs the
      // whole path set, which a directory entry does not have.
      if (
        entry.name.endsWith('.bru')
        || isBrunoJsonManifest(entry.name)
        || entry.name.endsWith('.yml')
        || entry.name.endsWith('.yaml')
        || /^readme\.md$/i.test(entry.name)
      ) {
        const rel = toPosix(path.relative(root, full));
        files.set(rel, await fs.readFile(full, 'utf8'));
      }
    }
  }
}

/**
 * Reads a collection tree from a URL via Backstage's `UrlReaderService`.
 *
 * RISK #1 (credential isolation): credentials come from the host's
 * `integrations.*` config and are applied server-side by the UrlReader. The
 * token is NEVER exposed to the browser or included in any response — the only
 * egress is Backstage -> the SCM host. Do not log or return the raw token.
 */
async function readUrlTree(
  reader: UrlReaderService,
  url: string,
  logger: LoggerService
): Promise<FileTree> {
  return { files: await readTreeViaUrlReader({ reader, url, logger }) };
}

/**
 * Reads a collection tree, preferring the host's service credential via the
 * Backstage reader. If that fails and the caller supplied their own SCM OAuth
 * token, retries through the provider adapter's user-token read.
 *
 * Which providers have that second tier is a platform fact, not a choice: the
 * GitHub and GitLab readers accept a per-call token, Bitbucket Cloud's ignores
 * it and its integration config silently drops a bare one. An adapter without
 * `readTreeWithUserToken` therefore gets an explicit error naming the fix rather
 * than a retry that would read anonymously and look like a "not found". The user
 * token is never logged, returned, or stored.
 */
async function readUrlTreeWithCreds(
  reader: UrlReaderService,
  provider: ScmProvider,
  url: string,
  logger: LoggerService,
  opts?: { userToken?: string }
): Promise<FileTree> {
  try {
    return await readUrlTree(reader, url, logger);
  } catch (error) {
    if (!opts?.userToken) {
      throw error;
    }
    if (!provider.readTreeWithUserToken) {
      throw new Error(
        `${provider.label} cannot use your personal access token for this read: `
        + `its Backstage reader accepts only the host's configured credential. `
        + `A private ${provider.label} repository needs an `
        + `\`integrations.${provider.type}\` entry with credentials. `
        + `(Underlying error: ${(error as Error).message})`
      );
    }
    logger.info(
      `Service reader failed; retrying with the caller's ${provider.label} OAuth token.`
    );
    return {
      files: await provider.readTreeWithUserToken({
        url,
        userToken: opts.userToken,
        reader,
        logger
      })
    };
  }
}

/**
 * Resolves the git ref for a URL: the explicit ref carried by the URL if
 * present, otherwise the repo's default branch via the provider adapter.
 * The token is never logged.
 */
async function resolveRef(
  provider: ScmProvider,
  url: string,
  userToken?: string
): Promise<string> {
  const { ref } = provider.parseRepoUrl(url);
  if (ref) {
    return ref;
  }
  return provider.resolveDefaultBranch(url, { userToken });
}
