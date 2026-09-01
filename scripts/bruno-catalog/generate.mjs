#!/usr/bin/env node
/**
 * Regenerates `examples/bruno-collections.yaml` — five Backstage `kind: API`
 * entities, one per production Bruno collection in https://github.com/bruno-collections,
 * each carrying a generated OpenAPI 3.0.3 document in `spec.definition`.
 *
 * Pipeline per collection:
 *
 *   git clone --depth 1                     (cached under <tmp>/bruno-catalog-cache)
 *     -> readBrunoCollection()              @usebruno/lang + @usebruno/filestore
 *     -> brunoToOpenCollection()            @usebruno/converters
 *     -> openCollectionToOpenApi()          OpenAPI 3.0.3
 *     -> ApiEntity with spec.definition
 *
 * Usage:
 *   node scripts/bruno-catalog/generate.mjs            # write examples/bruno-collections.yaml
 *   node scripts/bruno-catalog/generate.mjs --check    # fail if the file is stale
 *   node scripts/bruno-catalog/generate.mjs --refresh  # re-clone instead of using the cache
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { brunoToOpenCollection } from '@usebruno/converters';
import { readBrunoCollection } from './readBrunoCollection.mjs';
import { attachBrunoSignals } from './attachBrunoSignals.mjs';
import { openCollectionToOpenApi } from './openCollectionToOpenApi.mjs';
import { SOURCES, ORG, SYSTEM_NAME, OWNER, sourceUrl } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const OUTPUT = path.join(REPO_ROOT, 'examples/bruno-collections.yaml');
const CACHE = path.join(os.tmpdir(), 'bruno-catalog-cache');

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const REFRESH = argv.has('--refresh');

main();

function main() {
  fs.mkdirSync(CACHE, { recursive: true });

  const documents = [systemEntity()];
  const report = [];

  for (const source of SOURCES) {
    const repoDir = ensureRepo(source);
    const root = path.join(repoDir, source.subpath);
    if (!fs.existsSync(root)) {
      throw new Error(
        `${source.id}: collection root not found at ${source.subpath || '.'}`
      );
    }

    const { collection, format, warnings: parseWarnings, meta }
      = readBrunoCollection(root, { excludeFolders: source.excludeFolders });

    // @usebruno/converters normalizes the Bruno model; the OpenAPI mapping in
    // openCollectionToOpenApi runs on its canonical output. The converter drops
    // assert/tests/script blocks, so those are re-attached before mapping —
    // they carry the status codes most collections document responses with.
    const oc = brunoToOpenCollection(collection);
    const enriched = attachBrunoSignals(oc, collection);

    const { spec, stats, warnings: mapWarnings } = openCollectionToOpenApi(oc, {
      title: source.title,
      version: source.apiVersionLabel,
      description: specDescription(source, meta),
      environments: collection.environments,
      sourceUrl: sourceUrl(source)
    });

    documents.push(apiEntity(source, spec, stats, format));
    report.push({
      id: source.id,
      format,
      enriched,
      ...stats,
      warnings: [...parseWarnings, ...mapWarnings]
    });
  }

  const rendered = render(documents);

  if (CHECK_ONLY) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== rendered) {
      console.error(
        `${path.relative(REPO_ROOT, OUTPUT)} is stale — run `
        + 'node scripts/bruno-catalog/generate.mjs'
      );
      process.exit(1);
    }
    console.log(`${path.relative(REPO_ROOT, OUTPUT)} is up to date.`);
  } else {
    fs.writeFileSync(OUTPUT, rendered);
    console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT)}`);
  }

  printReport(report);
}

/* ------------------------------- source fetch ------------------------------ */

function ensureRepo(source) {
  const dir = path.join(CACHE, source.repo);
  if (fs.existsSync(dir) && !REFRESH) {
    return dir;
  }
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Cloning ${ORG}/${source.repo}...`);
  execFileSync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      source.ref,
      `https://github.com/${ORG}/${source.repo}.git`,
      dir
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  return dir;
}

/* --------------------------------- entities -------------------------------- */

function systemEntity() {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'System',
    metadata: {
      name: SYSTEM_NAME,
      title: 'Bruno Collections',
      description:
        'Production Bruno collections published at github.com/bruno-collections, '
        + 'each exposed as an API entity with an OpenAPI definition generated '
        + 'from the collection itself.',
      tags: ['bruno']
    },
    spec: { owner: OWNER }
  };
}

function apiEntity(source, spec, stats, format) {
  const url = sourceUrl(source);
  const repoUrl = `https://github.com/${ORG}/${source.repo}`;

  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'API',
    metadata: {
      name: source.id,
      title: source.title,
      description:
        `${source.description} ${stats.requests} Bruno request${
          stats.requests === 1 ? '' : 's'
        } -> ${stats.operations} OpenAPI operation${
          stats.operations === 1 ? '' : 's'
        } across ${stats.paths} path${stats.paths === 1 ? '' : 's'}.`,
      annotations: {
        // Informational only. `usebruno.com/collection-id` and
        // `usebruno.com/collection-path` are deliberately absent: those are owned
        // by BrunoEntityProvider (config-materialized collections) and
        // BrunoLinkProcessor (runtime connections), and setting
        // `collection-path` here makes the processor skip the entity, breaking
        // the Bruno card's Connect flow.
        'usebruno.com/source-url': url,
        'backstage.io/source-location': `url:${url}/`,
        'usebruno.com/collection-format': format === 'yml'
          ? 'opencollection-yml'
          : 'bru'
      },
      tags: source.tags,
      links: [
        {
          url: `https://fetch.usebruno.com/?url=${encodeURIComponent(repoUrl)}`,
          title: 'Open in Bruno',
          icon: 'code'
        },
        {
          url,
          title: 'Bruno collection (source)',
          icon: 'github'
        }
      ]
    },
    spec: {
      type: 'openapi',
      lifecycle: source.lifecycle,
      owner: OWNER,
      system: SYSTEM_NAME,
      definition: yaml.dump(spec, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false
      })
    }
  };
}

/* --------------------------------- output ---------------------------------- */

function specDescription(source, meta) {
  const lines = [
    source.description,
    '',
    `Generated from the Bruno collection at ${sourceUrl(source)} — `
    + 'the requests, params, bodies, recorded response examples and auth blocks '
    + 'in that collection are the only source for this document. Regenerate '
    + 'with `node scripts/bruno-catalog/generate.mjs`.'
  ];
  if (meta?.openapi?.[0]?.sourceUrl) {
    lines.push(
      '',
      'The collection itself is kept in sync with an upstream OpenAPI document '
      + `via Bruno OpenAPI Sync (${meta.openapi[0].sourceUrl}).`
    );
  }
  if (meta?.docs) {
    lines.push('', String(meta.docs).trim());
  }
  return lines.join('\n');
}

function render(documents) {
  const header = [
    '# GENERATED FILE — do not edit by hand.',
    '#',
    '# Five production Bruno collections from https://github.com/bruno-collections,',
    '# each as a kind: API entity whose spec.definition is an OpenAPI 3.0.3',
    '# document generated from the collection.',
    '#',
    '# Regenerate:  node scripts/bruno-catalog/generate.mjs',
    '# Verify:      node scripts/bruno-catalog/generate.mjs --check',
    ''
  ].join('\n');

  const body = documents
    .map((doc) =>
      yaml.dump(doc, {
        indent: 2,
        lineWidth: 100,
        noRefs: true,
        sortKeys: false
      })
    )
    .join('---\n');

  return `${header}${body}`;
}

function printReport(report) {
  console.log('');
  for (const row of report) {
    console.log(
      `  ${row.id.padEnd(24)} ${String(row.format).padEnd(4)} `
      + `${String(row.requests).padStart(3)} req -> `
      + `${String(row.operations).padStart(3)} ops  `
      + `${String(row.paths).padStart(3)} paths  `
      + `${String(row.enriched).padStart(2)} with asserts/tests`
      + (row.skipped ? `  (${row.skipped} skipped)` : '')
    );
    for (const w of row.warnings) {
      console.log(`      ! ${w}`);
    }
  }
}
