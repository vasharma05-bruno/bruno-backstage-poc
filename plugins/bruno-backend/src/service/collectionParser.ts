/**
 * Bruno collection parsing: an in-memory file tree in, a `NormalizedCollection`
 * out. Two self-contained paths — the classic `.bru`/`bruno.json` one and the
 * OpenCollection `.yml`/`.yaml` one — behind a single {@link parseCollection}.
 *
 * The one parser in the plugin. It was split out of the annotation-model
 * collection service — since deleted — because it is the part that SURVIVES:
 * both the `/api/bruno/*` docs routes and the `kind: Bruno` entity spine need a
 * parse, and a second copy for either would have drifted from the definition
 * stored on the entity.
 *
 * Dependency direction is one-way: this module is imported by
 * `definitionBuilder.ts` and reads only `../types`, `../scm`'s path predicates
 * and `../posixPath`. Nothing here imports the SCM readers, the probe, or
 * anything under `provider/` or `processor/`, so there is no cycle.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
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
  Environment,
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody
} from '../types';
import {
  isFolderManifest,
  isOpenCollectionBodyFile,
  isOpenCollectionManifest,
  stripOpenCollectionExtension
} from '../scm';
import { joinPosix, posixBaseName, posixDirname } from '../posixPath';

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
  // `seq` really does arrive as a STRING here — see {@link readSeq}.
  meta?: { name?: string; type?: string; seq?: number | string };
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
export type FileTree = {
  files: Map<string, string>;
};

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

/* -------------------------------------------------------------------------- */
/*  Parsing / normalization                                                    */
/* -------------------------------------------------------------------------- */

/** Builds the NormalizedCollection from an in-memory file tree. */
export function parseCollection(
  source: BrunoSourceConfig,
  tree: FileTree,
  logger: LoggerService
): NormalizedCollection {
  // OpenCollection (yml) collections are handled by a self-contained parallel
  // path. `opencollection.yml/.yaml` wins over `bruno.json` if both are present.
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
 * when it contains an `opencollection.yml/.yaml` manifest anywhere; otherwise
 * the classic `.bru`/`bruno.json` path is used. `opencollection.yml/.yaml` wins over
 * `bruno.json`, matching Bruno's `getCollectionFormat`.
 */
function detectFormat(tree: FileTree): 'bru' | 'yml' {
  return findOpenCollectionYml(tree) ? 'yml' : 'bru';
}

function findOpenCollectionYml(tree: FileTree): string | undefined {
  let best: string | undefined;
  for (const key of tree.files.keys()) {
    if (isOpenCollectionManifest(key)) {
      // Shortest path wins, so the shallowest manifest is chosen. Note this
      // also settles the two spellings inside one directory: `.yml` is one
      // character shorter than `.yaml`, so `.yml` always wins — which is what
      // Bruno writes today. The length-tie branch below is for equal-length
      // paths in *sibling* directories, replacing Map iteration order with a
      // deterministic choice.
      if (
        best === undefined
        || key.length < best.length
        || (key.length === best.length && key < best)
      ) {
        best = key;
      }
    }
  }
  return best;
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

/**
 * Orders environment names by UTF-16 code unit — deliberately NOT
 * `localeCompare`.
 *
 * `localeCompare` with no locale argument collates by the runtime's default
 * locale, which `LANG`/`LC_ALL` and the ICU build both move: a small-icu Node
 * and a full-icu Node, or two ICU versions, can order the same names
 * differently. That is not cosmetic here. The result reaches the catalog twice
 * over — as `spec.environments` and inside the generated `spec.definition` —
 * and `DefaultCatalogProcessingEngine` decides whether to write an entity by
 * hashing `stableStringify(completedEntity)`, which sorts object keys but
 * PRESERVES array order. Two replicas that disagree therefore rewrite and
 * re-stitch every Bruno entity in the catalog every reprocess cycle, forever
 * and invisibly (R8).
 *
 * Code-unit order is the same on every runtime, which is the only property
 * this sort needs — nobody reads an environment list for alphabetization
 * nuance. Same discipline as the bare `.sort()` in `scm/treeFilter.ts`.
 *
 * Exported so the byte-stability test can pin it as a pure function; a
 * regression to `localeCompare` is otherwise only visible on a machine whose
 * locale happens to differ.
 */
/**
 * Reads `meta.seq`, which arrives as a NUMBER from the YAML folder files and as
 * a STRING from `@usebruno/lang` — `bruToJsonV2` hands back each `meta` value
 * as written, unconverted, so `seq: 3` parses to `'3'`.
 *
 * That asymmetry was silently losing every `.bru` request's ordering. The
 * ambient shim for `@usebruno/lang` types the parsers as `any` and `RawRequest`
 * declared `seq` as `number`, so a `typeof seq === 'number'` guard type-checked
 * cleanly and then never matched at runtime: `sortItems` saw no seq at all and
 * fell back to insertion order — the order `selectCollectionFiles` listed the
 * files, which is alphabetical by path, rather than the order the author
 * arranged them in Bruno.
 *
 * Non-numeric and non-finite values yield `undefined`, which `sortItems`
 * already treats as "unordered, keep insertion position".
 */
function readSeq(value: unknown): number | undefined {
  const parsed
    = typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : value;
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

export function compareEnvironmentNames(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
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
      const name = posixBaseName(key).replace(/\.bru$/, '');
      const variables: KeyValue[] = (parsed.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value ?? '',
        enabled: v.enabled !== false,
        // Carried through rather than dropped: the OpenCollection converter is
        // what withholds a secret variable's value, and it keys off this flag.
        ...(v.secret === true && { secret: true })
      }));
      environments.push({ name, variables });
    } catch (e) {
      logger.warn(
        `Failed to parse environment file ${key}: ${(e as Error).message}`
      );
    }
  }

  environments.sort((a, b) => compareEnvironmentNames(a.name, b.name));
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
        meta?: { name?: string; seq?: number | string };
      };
      if (parsed.meta?.name) {
        name = parsed.meta.name;
      }
      seq = readSeq(parsed.meta?.seq);
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

  const name = raw.meta?.name ?? posixBaseName(key).replace(/\.bru$/, '');
  const seq = readSeq(raw.meta?.seq);

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

/** Parses `environments/*.yml|.yaml` files into Environment[]. */
function parseEnvironmentsYml(
  tree: FileTree,
  rootPrefix: string,
  logger: LoggerService
): Environment[] {
  const envDir = joinPosix(rootPrefix, 'environments');
  const environments: Environment[] = [];

  for (const [key, contents] of tree.files.entries()) {
    if (!isOpenCollectionBodyFile(key)) {
      continue;
    }
    // A single-file `environments.yml|.yaml` beside the manifest is the
    // degenerate case of the directory below it; both spellings count.
    const inEnvDir
      = key === envDir + '.yml'
        || key === envDir + '.yaml'
        || key.startsWith(envDir + '/')
        || (rootPrefix === '' && key.startsWith('environments/'));
    if (!inEnvDir) {
      continue;
    }

    try {
      const parsed = parseYmlEnvironment(contents, { format: 'yml' }) as {
        name?: string;
        variables?: Array<{
          name: string;
          value?: string;
          enabled?: boolean;
          secret?: boolean;
        }>;
      };
      const name
        = parsed.name || stripOpenCollectionExtension(posixBaseName(key));
      const variables: KeyValue[] = (parsed.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value ?? '',
        enabled: v.enabled !== false,
        // Carried through rather than dropped: the OpenCollection converter is
        // what withholds a secret variable's value, and it keys off this flag.
        ...(v.secret === true && { secret: true })
      }));
      environments.push({ name, variables });
    } catch (e) {
      logger.warn(
        `Failed to parse environment file ${key}: ${(e as Error).message}`
      );
    }
  }

  environments.sort((a, b) => compareEnvironmentNames(a.name, b.name));
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
    if (!isOpenCollectionBodyFile(file)) {
      continue;
    }
    // `isOpenCollectionManifest` / `isFolderManifest` are correct for a bare
    // filename as well as a path, which is what these are.
    if (
      isOpenCollectionManifest(file)
      || isFolderManifest(file)
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
  // Both spellings, `.yml` first so a directory carrying both keeps today's
  // behaviour — the same precedence `findOpenCollectionYml` gives the manifest.
  const folderYmlKey = [
    joinPosix(dir, 'folder.yml'),
    joinPosix(dir, 'folder.yaml')
  ].find((candidate) => tree.files.has(candidate)) ?? joinPosix(dir, 'folder.yml');
  let name = fallbackName;
  let docs: string | undefined;
  let seq: number | undefined;

  const folderYml = tree.files.get(folderYmlKey);
  if (folderYml) {
    try {
      const parsed = parseYmlFolder(folderYml, { format: 'yml' }) as {
        meta?: { name?: string; seq?: number | string };
        docs?: string;
      };
      if (parsed.meta?.name) {
        name = parsed.meta.name;
      }
      seq = readSeq(parsed.meta?.seq);
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

  const name = item.name || stripOpenCollectionExtension(posixBaseName(key));
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
