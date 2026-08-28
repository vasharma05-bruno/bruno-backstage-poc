/**
 * Reads a Bruno collection off disk into the in-memory `BrunoCollection` shape
 * that `@usebruno/converters`' `brunoToOpenCollection` consumes.
 *
 * Deliberately mirrors `plugins/bruno-backend/src/service/collectionService.ts`:
 * both collection formats are supported and parsed with the same libraries the
 * backend plugin uses, so a collection that renders in the Bruno card and one
 * that converts here agree on structure.
 *
 *  - legacy `.bru`  -> `@usebruno/lang` (`bruToJsonV2`, `collectionBruToJson`,
 *                      `bruToEnvJsonV2`)
 *  - OpenCollection `.yml` -> `@usebruno/filestore` (`parseRequest`,
 *                      `parseCollection`, `parseFolder`, `parseEnvironment`)
 *
 * Format is chosen per collection root: an `opencollection.yml` marker (or the
 * absence of `bruno.json`) selects the yml parsers.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  bruToJsonV2,
  collectionBruToJson,
  bruToEnvJsonV2
} from '@usebruno/lang';
import {
  parseRequest as parseYmlRequest,
  parseCollection as parseYmlCollection,
  parseFolder as parseYmlFolder,
  parseEnvironment as parseYmlEnvironment
} from '@usebruno/filestore';

/** Directories never walked when collecting requests. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.github', 'environments']);

const YML_OPTS = { format: 'yml' };

/**
 * @param {string} root absolute path of the collection root
 * @param {object} [options]
 * @param {string[]} [options.excludeFolders] folder names to skip entirely
 * @returns {{ collection: object, format: 'bru'|'yml', warnings: string[] }}
 */
export function readBrunoCollection(root, options = {}) {
  const warnings = [];
  const format = detectFormat(root);
  const meta = readRootMeta(root, format, warnings);
  const excluded = new Set(options.excludeFolders ?? []);

  const collection = {
    name: meta.name || path.basename(root),
    ...(meta.version ? { brunoConfig: { version: meta.version } } : {}),
    environments: readEnvironments(root, format, warnings),
    items: readDir(root, root, format, warnings, excluded),
    ...(meta.docs ? { root: { docs: meta.docs } } : {})
  };

  return { collection, format, warnings, meta };
}

function detectFormat(root) {
  if (exists(path.join(root, 'opencollection.yml'))) {
    return 'yml';
  }
  if (exists(path.join(root, 'bruno.json'))) {
    return 'bru';
  }
  // No marker: fall back on whichever request extension is present.
  return hasExtension(root, '.bru') ? 'bru' : 'yml';
}

/** Collection name / version / root docs, from bruno.json + collection.bru. */
function readRootMeta(root, format, warnings) {
  const meta = {};

  if (format === 'yml') {
    const ocPath = path.join(root, 'opencollection.yml');
    if (exists(ocPath)) {
      try {
        const parsed = parseYmlCollection(read(ocPath), YML_OPTS);
        meta.name = parsed?.brunoConfig?.name;
        meta.version = parsed?.brunoConfig?.opencollection;
        meta.docs = parsed?.collectionRoot?.docs || undefined;
        meta.openapi = parsed?.brunoConfig?.openapi || undefined;
        meta.auth = parsed?.collectionRoot?.request?.auth || undefined;
      } catch (e) {
        warnings.push(`opencollection.yml: ${e.message}`);
      }
    }
    return meta;
  }

  const cfgPath = path.join(root, 'bruno.json');
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(read(cfgPath));
      meta.name = cfg.name;
      meta.version = cfg.version;
    } catch (e) {
      warnings.push(`bruno.json: ${e.message}`);
    }
  }
  const collectionBru = path.join(root, 'collection.bru');
  if (exists(collectionBru)) {
    try {
      const parsed = collectionBruToJson(read(collectionBru));
      meta.docs = parsed?.docs || undefined;
      meta.auth = parsed?.auth || undefined;
      meta.authMode = parsed?.http?.auth || parsed?.auth?.mode || undefined;
    } catch (e) {
      warnings.push(`collection.bru: ${e.message}`);
    }
  }
  return meta;
}

function readEnvironments(root, format, warnings) {
  const dir = path.join(root, 'environments');
  if (!exists(dir)) {
    return [];
  }
  const ext = format === 'yml' ? '.yml' : '.bru';
  const envs = [];
  for (const entry of sorted(fs.readdirSync(dir, { withFileTypes: true }))) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) {
      continue;
    }
    const file = path.join(dir, entry.name);
    try {
      const parsed
        = format === 'yml'
          ? parseYmlEnvironment(read(file), YML_OPTS)
          : bruToEnvJsonV2(read(file));
      envs.push({
        name: parsed?.name || entry.name.replace(ext, ''),
        variables: (parsed?.variables ?? []).map((v) => ({
          name: v.name,
          value: v.value ?? '',
          enabled: v.enabled !== false,
          secret: v.secret === true
        }))
      });
    } catch (e) {
      warnings.push(`environments/${entry.name}: ${e.message}`);
    }
  }
  return envs;
}

/** Recursively builds folder/request items for one directory. */
function readDir(root, dir, format, warnings, excluded) {
  const reqExt = format === 'yml' ? '.yml' : '.bru';
  const folderFile = format === 'yml' ? 'folder.yml' : 'folder.bru';
  const items = [];

  for (const entry of sorted(fs.readdirSync(dir, { withFileTypes: true }))) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || excluded.has(entry.name)) {
        continue;
      }
      const folder = readFolder(root, full, entry.name, format, warnings, excluded);
      if (folder.items.length > 0) {
        items.push(folder);
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(reqExt)) {
      continue;
    }
    // Collection/folder metadata files are not requests.
    if (
      entry.name === folderFile
      || entry.name === 'collection.bru'
      || entry.name === 'opencollection.yml'
    ) {
      continue;
    }

    const item = readRequest(full, entry.name, reqExt, format, warnings);
    if (item) {
      items.push(item);
    }
  }

  return sortBySeq(items);
}

function readFolder(root, dir, fallbackName, format, warnings, excluded) {
  const folderFile = path.join(
    dir,
    format === 'yml' ? 'folder.yml' : 'folder.bru'
  );
  let name = fallbackName;
  let docs;
  let seq;

  if (exists(folderFile)) {
    try {
      const parsed
        = format === 'yml'
          ? parseYmlFolder(read(folderFile), YML_OPTS)
          : collectionBruToJson(read(folderFile));
      name = parsed?.meta?.name || name;
      seq = numberOrUndefined(parsed?.meta?.seq);
      docs = parsed?.docs || undefined;
    } catch (e) {
      warnings.push(`${path.relative(root, folderFile)}: ${e.message}`);
    }
  }

  return {
    type: 'folder',
    name,
    seq,
    items: readDir(root, dir, format, warnings, excluded),
    ...(docs ? { root: { docs } } : {})
  };
}

function readRequest(file, fileName, reqExt, format, warnings) {
  try {
    return format === 'yml'
      ? normalizeYmlRequest(parseYmlRequest(read(file), YML_OPTS), fileName, reqExt)
      : normalizeBruRequest(bruToJsonV2(read(file)), fileName, reqExt);
  } catch (e) {
    warnings.push(`${fileName}: ${e.message}`);
    return undefined;
  }
}

/**
 * `parseRequest` already returns the `{ type: 'http-request', request: {...} }`
 * shape `brunoToOpenCollection` wants — only the name and seq need defaulting.
 */
function normalizeYmlRequest(parsed, fileName, reqExt) {
  if (!parsed) {
    return undefined;
  }
  return {
    ...parsed,
    type: parsed.type || 'http-request',
    name: parsed.name || fileName.replace(reqExt, ''),
    seq: numberOrUndefined(parsed.seq)
  };
}

/**
 * Reshapes `bruToJsonV2`'s flat block output into the nested request shape.
 * `http.body` / `http.auth` hold the MODE string; the sibling `body` / `auth`
 * blocks hold that mode's fields — same contract `collectionService` documents.
 */
function normalizeBruRequest(raw, fileName, reqExt) {
  if (!raw) {
    return undefined;
  }
  const metaType = raw.meta?.type ?? 'http';
  const type
    = metaType === 'graphql'
      ? 'graphql-request'
      : metaType === 'grpc'
        ? 'grpc-request'
        : 'http-request';

  return {
    type,
    name: raw.meta?.name || fileName.replace(reqExt, ''),
    seq: numberOrUndefined(raw.meta?.seq),
    ...(raw.meta?.tags ? { tags: raw.meta.tags } : {}),
    request: {
      method: (raw.http?.method || 'get').toUpperCase(),
      url: raw.http?.url || '',
      headers: raw.headers ?? [],
      params: raw.params ?? [],
      body: bodyBlock(raw),
      auth: authBlock(raw),
      script: { req: raw.script?.req ?? null, res: raw.script?.res ?? null },
      assertions: raw.assertions ?? [],
      tests: raw.tests ?? null,
      docs: raw.docs ?? null
    }
  };
}

function bodyBlock(raw) {
  const mode = raw.http?.body;
  if (!mode || mode === 'none') {
    return { mode: 'none' };
  }
  const body = raw.body ?? {};
  switch (mode) {
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return { mode, [mode]: body[mode] ?? '' };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: {
          query: body.graphql?.query ?? '',
          variables: body.graphql?.variables ?? ''
        }
      };
    case 'formUrlEncoded':
      return { mode, formUrlEncoded: body.formUrlEncoded ?? [] };
    case 'multipartForm':
      return {
        mode,
        multipartForm: (body.multipartForm ?? []).map((f) => ({
          ...f,
          type: f.type || 'text'
        }))
      };
    case 'file':
      return { mode, file: body.file ?? [] };
    default:
      return { mode: 'none' };
  }
}

function authBlock(raw) {
  const mode = raw.http?.auth;
  if (!mode || mode === 'none') {
    return undefined;
  }
  if (mode === 'inherit') {
    return { mode: 'inherit' };
  }
  const fields = raw.auth?.[mode];
  return fields ? { mode, [mode]: fields } : { mode };
}

/* ---------------------------------- utils --------------------------------- */

function exists(p) {
  return fs.existsSync(p);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function sorted(entries) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/** `.bru` seq values arrive as strings; keep them comparable as numbers. */
function numberOrUndefined(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Requests before folders, each ordered by `seq` then name — Bruno's order. */
function sortBySeq(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aFolder = a.item.type === 'folder';
      const bFolder = b.item.type === 'folder';
      if (aFolder !== bFolder) {
        return aFolder ? 1 : -1;
      }
      const aSeq = a.item.seq ?? Number.MAX_SAFE_INTEGER;
      const bSeq = b.item.seq ?? Number.MAX_SAFE_INTEGER;
      if (aSeq !== bSeq) {
        return aSeq - bSeq;
      }
      return a.item.name.localeCompare(b.item.name) || a.index - b.index;
    })
    .map(({ item }) => item);
}

function hasExtension(dir, ext) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
      } else if (entry.name.endsWith(ext)) {
        return true;
      }
    }
  }
  return false;
}
