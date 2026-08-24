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
// @usebruno/lang@0.38.0 exports the v2 parsers with a `V2` suffix; alias them
// to the names the rest of this module uses. `collectionBruToJson` is unsuffixed.
import {
  bruToJsonV2 as bruToJson,
  collectionBruToJson,
  bruToEnvJsonV2 as bruToEnvJson
} from '@usebruno/lang';
// OpenCollection (yml) parsers. Aliased so `parseCollection` does not collide
// with the local function of the same name. Only the SYNC exports are used.
import {
  parseRequest,
  parseCollection as parseYmlCollection,
  parseFolder as parseYmlFolder,
  parseEnvironment as parseYmlEnvironment
} from '@usebruno/filestore';
import type {
  Assertion,
  BrunoSourceConfig,
  CollectionDetail,
  CollectionSummary,
  Dashboard,
  DashboardCollection,
  DiscoveredCollection,
  DiscoverResult,
  Environment,
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody,
  SourceFailure
} from '../types';
import type { BrunoConnectionRow } from '../store/connectionStore';
import type { ImportedCollectionRow } from '../store/collectionsStore';
import {
  createScmProviderRegistry,
  normalizePathStyleUrl,
  readTreeViaUrlReader,
  type ScmProvider
} from '../scm';

/**
 * A parsed .bru request as produced by `@usebruno/lang`'s `bruToJson`.
 *
 * The parser merges all blocks into a single object. Notably:
 *  - `meta`: `{ name, type, seq }`
 *  - `http`: `{ method, url, body: <modeString>, auth: <modeString> }`
 *      (`http.body`/`http.auth` hold the MODE string, e.g. 'none' | 'json' | 'basic')
 *  - `headers`: `Array<{ name, value, enabled }>`
 *  - `params`:  `Array<{ name, value, enabled, type: 'query'|'path' }>`
 *  - `body`:    `{ json?, text?, xml?, graphql?: {query,variables},
 *                  formUrlEncoded?: KeyVal[], multipartForm?: KeyVal[] }`
 *  - `auth`:    `{ basic?: {username,password}, bearer?: {token},
 *                  apikey?: {key,value,placement}, digest?: {username,password}, ... }`
 *  - `script`:  `{ req?, res? }`
 *  - `tests`:   `string`
 *  - `docs`:    `string`
 *  - `assertions`: `Array<{ name, value, enabled }>` (name = LHS expr, value = "op rhs")
 */
type RawRequest = {
  meta?: { name?: string; type?: string; seq?: number };
  http?: { method?: string; url?: string; body?: string; auth?: string };
  headers?: Array<{ name: string; value: string; enabled?: boolean }>;
  params?: Array<{
    name: string;
    value: string;
    enabled?: boolean;
    type?: 'query' | 'path';
  }>;
  body?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  script?: { req?: string; res?: string };
  tests?: string;
  docs?: string;
  assertions?: Array<{ name: string; value: string; enabled?: boolean }>;
};

/** Parsed collection.bru / folder.bru as produced by `collectionBruToJson`. */
type RawCollectionBru = {
  meta?: { name?: string };
  headers?: unknown;
  auth?: Record<string, unknown>;
  script?: { req?: string; res?: string };
  tests?: string;
  docs?: string;
};

/** Parsed environment file as produced by `bruToEnvJson`. */
type RawEnv = {
  variables?: Array<{
    name: string;
    value: string;
    enabled?: boolean;
    secret?: boolean;
  }>;
};

/**
 * An intermediate representation of the on-disk directory tree, independent of
 * whether it came from the local filesystem or a `UrlReaderService` tree.
 * `files` maps a POSIX-relative path (from the collection root) to its contents.
 */
type FileTree = {
  files: Map<string, string>;
};

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

const BODY_MODES: RequestBody['mode'][] = [
  'json',
  'text',
  'xml',
  'formUrlEncoded',
  'multipartForm',
  'graphql'
];

const AUTH_MODES: RequestAuth['mode'][] = [
  'basic',
  'bearer',
  'apikey',
  'digest'
];

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
        `No Bruno collection found at ${normalized} (missing bruno.json / opencollection.yml)`
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

  const files = new Map<string, string>();
  await walkLocal(root, root, files);
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
      // Keep .bru files, bruno.json, OpenCollection .yml files, and the
      // collection README.
      if (
        entry.name.endsWith('.bru')
        || entry.name === 'bruno.json'
        || entry.name.endsWith('.yml')
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

/* -------------------------------------------------------------------------- */
/*  Parsing / normalization                                                    */
/* -------------------------------------------------------------------------- */

/** Builds the NormalizedCollection from an in-memory file tree. */
function parseCollection(
  source: BrunoSourceConfig,
  tree: FileTree,
  logger: LoggerService
): NormalizedCollection {
  // OpenCollection (yml) collections are handled by a self-contained parallel
  // path. `opencollection.yml` wins over `bruno.json` if both are present.
  if (detectFormat(tree) === 'yml') {
    return parseCollectionYml(source, tree, logger);
  }

  // Determine the collection root within the tree. A UrlReader tree may be
  // nested under one top-level directory; the local reader is already rooted at
  // the collection. We locate `bruno.json` and treat its directory as the root.
  const brunoJsonPath = findBrunoJson(tree);
  const rootPrefix = brunoJsonPath
    ? posixDirname(brunoJsonPath)
    : commonRootPrefix(tree);

  let collectionName = source.name;
  let version: string | undefined;
  if (brunoJsonPath) {
    try {
      const parsed = JSON.parse(tree.files.get(brunoJsonPath)!);
      if (typeof parsed.name === 'string' && parsed.name) {
        collectionName = parsed.name;
      }
      if (parsed.version !== undefined && parsed.version !== null) {
        version = String(parsed.version);
      }
    } catch (e) {
      logger.warn(
        `Could not parse bruno.json for "${source.id}": ${(e as Error).message}`
      );
    }
  }

  const environments = parseEnvironments(tree, rootPrefix, logger);
  const items = buildTree(tree, rootPrefix, logger);
  const readme = findReadme(tree, rootPrefix);

  return {
    id: source.id,
    name: collectionName,
    version,
    environments,
    items,
    readme
  };
}

function findBrunoJson(tree: FileTree): string | undefined {
  let best: string | undefined;
  for (const key of tree.files.keys()) {
    if (key === 'bruno.json' || key.endsWith('/bruno.json')) {
      if (best === undefined || key.length < best.length) {
        best = key;
      }
    }
  }
  return best;
}

/**
 * Detects the collection format. A tree is treated as OpenCollection (`yml`)
 * when it contains an `opencollection.yml` manifest anywhere; otherwise the
 * classic `.bru`/`bruno.json` path is used. `opencollection.yml` wins over
 * `bruno.json`, matching Bruno's `getCollectionFormat`.
 */
function detectFormat(tree: FileTree): 'bru' | 'yml' {
  return findOpenCollectionYml(tree) ? 'yml' : 'bru';
}

function findOpenCollectionYml(tree: FileTree): string | undefined {
  let best: string | undefined;
  for (const key of tree.files.keys()) {
    if (key === 'opencollection.yml' || key.endsWith('/opencollection.yml')) {
      if (best === undefined || key.length < best.length) {
        best = key;
      }
    }
  }
  return best;
}

/**
 * Collects EVERY collection root in the tree (not just the shortest, unlike
 * `findBrunoJson`/`findOpenCollectionYml`). A root is the directory of a
 * `bruno.json` or `opencollection.yml` manifest. When both formats sit in the
 * same directory, `yml` wins on tie (matching `detectFormat`). Sorted by
 * `rootPrefix` for stable output.
 */
function findAllCollectionRoots(tree: FileTree): string[] {
  // The directory of every Bruno manifest. `parseCollection` re-detects the
  // format (yml wins) on each sliced sub-tree, so only the root path matters.
  const roots = new Set<string>();
  for (const key of tree.files.keys()) {
    if (
      key === 'bruno.json'
      || key.endsWith('/bruno.json')
      || key === 'opencollection.yml'
      || key.endsWith('/opencollection.yml')
    ) {
      roots.add(posixDirname(key));
    }
  }
  return Array.from(roots).sort((a, b) => a.localeCompare(b));
}

/**
 * Slices a sub-tree at `rootPrefix`, re-keying files to be root-relative so the
 * existing `parseCollection` sees a single manifest at its own root. When
 * `rootPrefix` is `''` the tree is returned unchanged.
 */
function sliceTreeAtRoot(tree: FileTree, rootPrefix: string): FileTree {
  if (rootPrefix === '') {
    return tree;
  }
  const prefix = `${rootPrefix}/`;
  const files = new Map<string, string>();
  for (const [key, value] of tree.files) {
    if (key.startsWith(prefix)) {
      files.set(key.slice(prefix.length), value);
    }
  }
  return { files };
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

/** Finds the collection-root README (case-insensitive) at `rootPrefix`. */
function findReadme(tree: FileTree, rootPrefix: string): string | undefined {
  const prefix = rootPrefix ? `${rootPrefix}/` : '';
  for (const [key, value] of tree.files) {
    if (key.toLowerCase() === `${prefix}readme.md`) {
      return value;
    }
  }
  return undefined;
}

/** Fallback: the shortest common leading directory of all files. */
function commonRootPrefix(tree: FileTree): string {
  const keys = Array.from(tree.files.keys());
  if (keys.length === 0) {
    return '';
  }
  const firstSegments = keys[0].split('/').slice(0, -1);
  let prefixLen = firstSegments.length;
  for (const key of keys) {
    const segs = key.split('/').slice(0, -1);
    let i = 0;
    while (i < prefixLen && i < segs.length && segs[i] === firstSegments[i]) {
      i++;
    }
    prefixLen = i;
  }
  return firstSegments.slice(0, prefixLen).join('/');
}

/** Parses `environments/*.bru` files into Environment[]. */
function parseEnvironments(
  tree: FileTree,
  rootPrefix: string,
  logger: LoggerService
): Environment[] {
  const envDir = joinPosix(rootPrefix, 'environments');
  const environments: Environment[] = [];

  for (const [key, contents] of tree.files.entries()) {
    if (!key.endsWith('.bru')) {
      continue;
    }
    const inEnvDir
      = key === envDir + '.bru'
        || key.startsWith(envDir + '/')
        || (rootPrefix === '' && key.startsWith('environments/'));
    if (!inEnvDir) {
      continue;
    }

    try {
      const parsed = bruToEnvJson(contents) as RawEnv;
      const name = baseName(key).replace(/\.bru$/, '');
      const variables: KeyValue[] = (parsed.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value ?? '',
        enabled: v.enabled !== false
      }));
      environments.push({ name, variables });
    } catch (e) {
      logger.warn(
        `Failed to parse environment file ${key}: ${(e as Error).message}`
      );
    }
  }

  environments.sort((a, b) => a.name.localeCompare(b.name));
  return environments;
}

/**
 * Walks the file tree (rooted at `rootPrefix`) and builds the ordered folder /
 * request tree, sorted by `meta.seq`.
 */
function buildTree(
  tree: FileTree,
  rootPrefix: string,
  logger: LoggerService
): Item[] {
  return buildTreeForDir(tree, rootPrefix, rootPrefix, logger);
}

function buildTreeForDir(
  tree: FileTree,
  rootPrefix: string,
  dir: string,
  logger: LoggerService
): Item[] {
  const relDir = dir === '' ? '' : dir + '/';
  const childFiles = new Set<string>();
  const childDirs = new Set<string>();

  for (const key of tree.files.keys()) {
    if (!key.startsWith(relDir)) {
      continue;
    }
    const rest = key.slice(relDir.length);
    if (rest.length === 0) {
      continue;
    }
    const slash = rest.indexOf('/');
    if (slash === -1) {
      childFiles.add(rest);
    } else {
      childDirs.add(rest.slice(0, slash));
    }
  }

  const items: Item[] = [];

  // Requests directly in this directory (skip folder.bru, collection.bru, envs).
  for (const file of childFiles) {
    if (!file.endsWith('.bru')) {
      continue;
    }
    if (
      file === 'folder.bru'
      || file === 'collection.bru'
      || dir === joinPosix(rootPrefix, 'environments')
    ) {
      continue;
    }
    const key = relDir + file;
    const req = parseRequestFile(tree.files.get(key)!, key, logger);
    if (req) {
      items.push(req);
    }
  }

  // Sub-folders (skip the environments directory at the collection root).
  const envDir = joinPosix(rootPrefix, 'environments');
  for (const sub of childDirs) {
    const subDir = joinPosix(dir, sub);
    if (subDir === envDir) {
      continue;
    }
    const folder = buildFolder(tree, rootPrefix, subDir, sub, logger);
    items.push(folder);
  }

  return sortItems(items);
}

function buildFolder(
  tree: FileTree,
  rootPrefix: string,
  dir: string,
  fallbackName: string,
  logger: LoggerService
): Item {
  const folderBruKey = joinPosix(dir, 'folder.bru');
  let name = fallbackName;
  let docs: string | undefined;
  let seq: number | undefined;

  const folderBru = tree.files.get(folderBruKey);
  if (folderBru) {
    try {
      const parsed = collectionBruToJson(folderBru) as RawCollectionBru & {
        meta?: { name?: string; seq?: number };
      };
      if (parsed.meta?.name) {
        name = parsed.meta.name;
      }
      if (typeof parsed.meta?.seq === 'number') {
        seq = parsed.meta.seq;
      }
      if (parsed.docs) {
        docs = parsed.docs;
      }
    } catch (e) {
      logger.warn(
        `Failed to parse ${folderBruKey}: ${(e as Error).message}`
      );
    }
  }

  const item: Item = {
    type: 'folder',
    name,
    docs,
    items: buildTreeForDir(tree, rootPrefix, dir, logger)
  };
  // Preserve seq for ordering; not part of the public FolderItem shape but used
  // internally by sortItems via the symbol below.
  (item as Item & { seq?: number }).seq = seq;
  return item;
}

/** Parses a single request .bru file into a RequestItem. */
function parseRequestFile(
  contents: string,
  key: string,
  logger: LoggerService
): Item | undefined {
  let raw: RawRequest;
  try {
    raw = bruToJson(contents) as RawRequest;
  } catch (e) {
    logger.warn(`Failed to parse ${key}: ${(e as Error).message}`);
    return undefined;
  }

  const metaType = raw.meta?.type ?? 'http';
  // Only http/graphql items become requests. gRPC / ws / etc. are skipped for
  // the POC's normalized model.
  const type: 'http' | 'graphql'
    = metaType === 'graphql' ? 'graphql' : 'http';

  const name = raw.meta?.name ?? baseName(key).replace(/\.bru$/, '');
  const seq
    = typeof raw.meta?.seq === 'number' ? raw.meta.seq : undefined;

  const headers: KeyValue[] = (raw.headers ?? []).map((h) => ({
    name: h.name,
    value: h.value ?? '',
    enabled: h.enabled !== false
  }));

  const params: Param[] = (raw.params ?? []).map((p) => ({
    name: p.name,
    value: p.value ?? '',
    type: p.type === 'path' ? 'path' : 'query',
    enabled: p.enabled !== false
  }));

  const item: RequestItemInternal = {
    type,
    name,
    seq,
    docs: raw.docs || undefined,
    method: (raw.http?.method ?? 'get').toUpperCase(),
    url: raw.http?.url ?? '',
    headers,
    params,
    body: mapBody(raw),
    auth: mapAuth(raw),
    script: mapScript(raw),
    tests: raw.tests || undefined,
    assertions: mapAssertions(raw)
  };

  return item;
}

type RequestItemInternal = Extract<Item, { type: 'http' | 'graphql' }> & {
  seq?: number;
};

/** Maps the raw body block to our RequestBody, using `http.body` as the mode. */
function mapBody(raw: RawRequest): RequestBody | undefined {
  const mode = raw.http?.body;
  if (!mode || mode === 'none') {
    return { mode: 'none' };
  }

  const body = raw.body ?? {};

  switch (mode) {
    case 'json':
      return { mode: 'json', raw: strOrUndefined(body.json) };
    case 'text':
      return { mode: 'text', raw: strOrUndefined(body.text) };
    case 'xml':
      return { mode: 'xml', raw: strOrUndefined(body.xml) };
    case 'graphql': {
      const gql = body.graphql as
        | { query?: string; variables?: string }
        | undefined;
      return { mode: 'graphql', raw: gql?.query ?? '' };
    }
    case 'formUrlEncoded':
      return {
        mode: 'formUrlEncoded',
        form: mapForm(body.formUrlEncoded)
      };
    case 'multipartForm':
      return {
        mode: 'multipartForm',
        form: mapForm(body.multipartForm)
      };
    default:
      // Unknown / unsupported body mode — expose raw stringified content if any.
      if (BODY_MODES.includes(mode as RequestBody['mode'])) {
        return { mode: mode as RequestBody['mode'] };
      }
      return { mode: 'none' };
  }
}

function mapForm(value: unknown): KeyValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((v: { name?: string; value?: unknown; enabled?: boolean }) => ({
    name: v.name ?? '',
    value: typeof v.value === 'string' ? v.value : String(v.value ?? ''),
    enabled: v.enabled !== false
  }));
}

/** Maps the raw auth block to our RequestAuth, using `http.auth` as the mode. */
function mapAuth(raw: RawRequest): RequestAuth | undefined {
  const mode = raw.http?.auth;
  if (!mode) {
    return undefined;
  }
  if (mode === 'none') {
    return { mode: 'none' };
  }
  if (mode === 'inherit') {
    return { mode: 'inherit' };
  }

  if (AUTH_MODES.includes(mode as RequestAuth['mode'])) {
    const auth = raw.auth ?? {};
    const fields = (auth[mode] as Record<string, unknown>) ?? {};
    return { mode: mode as RequestAuth['mode'], ...fields };
  }

  // Unsupported auth mode for the normalized model (oauth2, awsv4, ntlm, ...).
  // Surface the mode so the UI can label it, without leaking secret fields.
  return { mode: 'none', unsupportedMode: mode };
}

function mapScript(raw: RawRequest): { req?: string; res?: string } | undefined {
  const req = raw.script?.req || undefined;
  const res = raw.script?.res || undefined;
  if (!req && !res) {
    return undefined;
  }
  return { req, res };
}

/**
 * The assert block is parsed as key/value pairs where `name` is the LHS
 * expression (e.g. `res.status`) and `value` is `"<op> <rhs>"` (e.g. `eq 200`).
 */
function mapAssertions(raw: RawRequest): Assertion[] | undefined {
  if (!raw.assertions || raw.assertions.length === 0) {
    return undefined;
  }
  return raw.assertions.map((a) => {
    const rhs = (a.value ?? '').trim();
    const spaceIdx = rhs.indexOf(' ');
    let op = rhs;
    let value = '';
    if (spaceIdx !== -1) {
      op = rhs.slice(0, spaceIdx);
      value = rhs.slice(spaceIdx + 1).trim();
    }
    return {
      expr: a.name,
      op,
      value,
      enabled: a.enabled !== false
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  OpenCollection (yml) parsing                                               */
/* -------------------------------------------------------------------------- */

/**
 * Builds the NormalizedCollection from an OpenCollection (yml) file tree.
 * Mirrors `parseCollection` but delegates to `@usebruno/filestore` parsers.
 */
function parseCollectionYml(
  source: BrunoSourceConfig,
  tree: FileTree,
  logger: LoggerService
): NormalizedCollection {
  const manifestPath = findOpenCollectionYml(tree);
  const rootPrefix = manifestPath
    ? posixDirname(manifestPath)
    : commonRootPrefix(tree);

  let name = source.name;
  let version: string | undefined;
  if (manifestPath) {
    try {
      const parsed = parseYmlCollection(tree.files.get(manifestPath)!, {
        format: 'yml'
      });
      const brunoConfig = (parsed?.brunoConfig ?? {}) as {
        name?: string;
        version?: unknown;
      };
      if (typeof brunoConfig.name === 'string' && brunoConfig.name) {
        name = brunoConfig.name;
      }
      if (brunoConfig.version !== undefined && brunoConfig.version !== null) {
        version = String(brunoConfig.version);
      }
    } catch (e) {
      logger.warn(
        `Could not parse opencollection.yml for "${source.id}": ${
          (e as Error).message
        }`
      );
    }
  }

  const environments = parseEnvironmentsYml(tree, rootPrefix, logger);
  const items = buildTreeYml(tree, rootPrefix, logger);
  const readme = findReadme(tree, rootPrefix);

  return {
    id: source.id,
    name,
    version,
    environments,
    items,
    readme
  };
}

/** Parses `environments/*.yml` files into Environment[]. */
function parseEnvironmentsYml(
  tree: FileTree,
  rootPrefix: string,
  logger: LoggerService
): Environment[] {
  const envDir = joinPosix(rootPrefix, 'environments');
  const environments: Environment[] = [];

  for (const [key, contents] of tree.files.entries()) {
    if (!key.endsWith('.yml')) {
      continue;
    }
    const inEnvDir
      = key === envDir + '.yml'
        || key.startsWith(envDir + '/')
        || (rootPrefix === '' && key.startsWith('environments/'));
    if (!inEnvDir) {
      continue;
    }

    try {
      const parsed = parseYmlEnvironment(contents, { format: 'yml' }) as {
        name?: string;
        variables?: Array<{ name: string; value?: string; enabled?: boolean }>;
      };
      const name = parsed.name || baseName(key).replace(/\.yml$/, '');
      const variables: KeyValue[] = (parsed.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value ?? '',
        enabled: v.enabled !== false
      }));
      environments.push({ name, variables });
    } catch (e) {
      logger.warn(
        `Failed to parse environment file ${key}: ${(e as Error).message}`
      );
    }
  }

  environments.sort((a, b) => a.name.localeCompare(b.name));
  return environments;
}

function buildTreeYml(
  tree: FileTree,
  rootPrefix: string,
  logger: LoggerService
): Item[] {
  return buildTreeForDirYml(tree, rootPrefix, rootPrefix, logger);
}

function buildTreeForDirYml(
  tree: FileTree,
  rootPrefix: string,
  dir: string,
  logger: LoggerService
): Item[] {
  const relDir = dir === '' ? '' : dir + '/';
  const childFiles = new Set<string>();
  const childDirs = new Set<string>();

  for (const key of tree.files.keys()) {
    if (!key.startsWith(relDir)) {
      continue;
    }
    const rest = key.slice(relDir.length);
    if (rest.length === 0) {
      continue;
    }
    const slash = rest.indexOf('/');
    if (slash === -1) {
      childFiles.add(rest);
    } else {
      childDirs.add(rest.slice(0, slash));
    }
  }

  const items: Item[] = [];

  // Requests directly in this directory (skip manifests and the envs dir).
  for (const file of childFiles) {
    if (!file.endsWith('.yml')) {
      continue;
    }
    if (
      file === 'opencollection.yml'
      || file === 'folder.yml'
      || dir === joinPosix(rootPrefix, 'environments')
    ) {
      continue;
    }
    const key = relDir + file;
    const req = parseRequestFileYml(tree.files.get(key)!, key, logger);
    if (req) {
      items.push(req);
    }
  }

  // Sub-folders (skip the environments directory at the collection root).
  const envDir = joinPosix(rootPrefix, 'environments');
  for (const sub of childDirs) {
    const subDir = joinPosix(dir, sub);
    if (subDir === envDir) {
      continue;
    }
    const folder = buildFolderYml(tree, rootPrefix, subDir, sub, logger);
    items.push(folder);
  }

  return sortItems(items);
}

function buildFolderYml(
  tree: FileTree,
  rootPrefix: string,
  dir: string,
  fallbackName: string,
  logger: LoggerService
): Item {
  const folderYmlKey = joinPosix(dir, 'folder.yml');
  let name = fallbackName;
  let docs: string | undefined;
  let seq: number | undefined;

  const folderYml = tree.files.get(folderYmlKey);
  if (folderYml) {
    try {
      const parsed = parseYmlFolder(folderYml, { format: 'yml' }) as {
        meta?: { name?: string; seq?: number };
        docs?: string;
      };
      if (parsed.meta?.name) {
        name = parsed.meta.name;
      }
      if (typeof parsed.meta?.seq === 'number') {
        seq = parsed.meta.seq;
      }
      if (parsed.docs) {
        docs = parsed.docs;
      }
    } catch (e) {
      logger.warn(`Failed to parse ${folderYmlKey}: ${(e as Error).message}`);
    }
  }

  const item: Item = {
    type: 'folder',
    name,
    docs,
    items: buildTreeForDirYml(tree, rootPrefix, dir, logger)
  };
  (item as Item & { seq?: number }).seq = seq;
  return item;
}

/** Parses a single request .yml file into a RequestItem. */
function parseRequestFileYml(
  contents: string,
  key: string,
  logger: LoggerService
): Item | undefined {
  let item: FilestoreItem;
  try {
    // `parseRequest` THROWS for folder / unknown item types and re-throws
    // parse errors, so it must be guarded and skipped on failure.
    item = parseRequest(contents, { format: 'yml' }) as FilestoreItem;
  } catch (e) {
    logger.warn(`Failed to parse ${key}: ${(e as Error).message}`);
    return undefined;
  }
  return adaptFilestoreItem(item, key);
}

/** Shape of a request as produced by `@usebruno/filestore`'s `parseRequest`. */
type FilestoreItem = {
  type?: string;
  name?: string;
  seq?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value?: string; enabled?: boolean }>;
    params?: Array<{
      name: string;
      value?: string;
      enabled?: boolean;
      type?: 'query' | 'path';
    }>;
    body?: Record<string, unknown> & { mode?: string };
    auth?: (Record<string, unknown> & { mode?: string }) | null;
    script?: { req?: string | null; res?: string | null };
    tests?: string | null;
    assertions?: Array<{ name: string; value: string; enabled?: boolean }>;
    docs?: string | null;
  };
};

/**
 * Adapts a filestore request item into our `Item`. Returns `undefined` for
 * non-request item types (grpc / websocket / script / app) so they are skipped.
 */
function adaptFilestoreItem(
  item: FilestoreItem,
  key: string
): Item | undefined {
  let type: 'http' | 'graphql';
  if (item.type === 'graphql-request') {
    type = 'graphql';
  } else if (item.type === 'http-request') {
    type = 'http';
  } else {
    return undefined;
  }

  const name = item.name || baseName(key).replace(/\.yml$/, '');
  const seq = typeof item.seq === 'number' ? item.seq : undefined;
  const req = item.request ?? {};

  const headers: KeyValue[] = (req.headers ?? []).map((h) => ({
    name: h.name,
    value: h.value ?? '',
    enabled: h.enabled !== false
  }));

  const params: Param[] = (req.params ?? []).map((p) => ({
    name: p.name,
    value: p.value ?? '',
    type: p.type === 'path' ? 'path' : 'query',
    enabled: p.enabled !== false
  }));

  const script = mapScript({ script: req.script } as RawRequest);

  const result: RequestItemInternal = {
    type,
    name,
    seq,
    docs: req.docs || undefined,
    method: (req.method ?? 'get').toUpperCase(),
    url: req.url ?? '',
    headers,
    params,
    body: adaptBodyYml(req.body),
    auth: adaptAuthYml(req.auth),
    script,
    tests: req.tests || undefined,
    assertions: mapAssertions({
      assertions: req.assertions
    } as RawRequest)
  };

  return result;
}

/** Maps a filestore body block to our RequestBody, keyed by `body.mode`. */
function adaptBodyYml(
  body: (Record<string, unknown> & { mode?: string }) | undefined
): RequestBody | undefined {
  const mode = body?.mode;
  if (!body || !mode || mode === 'none') {
    return { mode: 'none' };
  }

  switch (mode) {
    case 'json':
      return { mode: 'json', raw: strOrUndefined(body.json) };
    case 'text':
      return { mode: 'text', raw: strOrUndefined(body.text) };
    case 'xml':
      return { mode: 'xml', raw: strOrUndefined(body.xml) };
    case 'graphql': {
      const gql = body.graphql as { query?: string } | undefined;
      return { mode: 'graphql', raw: gql?.query ?? '' };
    }
    case 'formUrlEncoded':
      return { mode: 'formUrlEncoded', form: mapForm(body.formUrlEncoded) };
    case 'multipartForm':
      return { mode: 'multipartForm', form: mapForm(body.multipartForm) };
    default:
      // sparql / file / unknown modes are not representable — treat as none.
      return { mode: 'none' };
  }
}

/**
 * Maps a filestore auth block to our RequestAuth. The block is `{ mode, ... }`
 * where the mode-specific fields live under `auth[mode]`.
 */
function adaptAuthYml(
  auth: (Record<string, unknown> & { mode?: string }) | null | undefined
): RequestAuth | undefined {
  if (!auth) {
    return undefined;
  }
  const mode = auth.mode;
  if (!mode) {
    return undefined;
  }
  if (mode === 'none' || mode === 'inherit') {
    return { mode: mode as RequestAuth['mode'] };
  }
  if (AUTH_MODES.includes(mode as RequestAuth['mode'])) {
    const fields = (auth[mode] as Record<string, unknown>) ?? {};
    return { mode: mode as RequestAuth['mode'], ...fields };
  }
  // Unsupported auth mode (oauth2, awsv4, ntlm, ...) — surface the mode only.
  return { mode: 'none', unsupportedMode: mode };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Sorts items by seq (undefined last), then by name for stability. */
function sortItems(items: Item[]): Item[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sa = (a.item as Item & { seq?: number }).seq;
      const sb = (b.item as Item & { seq?: number }).seq;
      if (sa !== undefined && sb !== undefined && sa !== sb) {
        return sa - sb;
      }
      if (sa !== undefined && sb === undefined) {
        return -1;
      }
      if (sa === undefined && sb !== undefined) {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Recursively counts http/graphql items in the tree. */
export function countRequests(items: Item[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === 'folder') {
      count += countRequests(item.items);
    } else {
      count += 1;
    }
  }
  return count;
}

function strOrUndefined(v: unknown): string | undefined {
  if (typeof v === 'string') {
    return v;
  }
  return undefined;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function joinPosix(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}
