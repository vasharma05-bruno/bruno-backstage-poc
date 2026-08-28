#!/usr/bin/env node
/**
 * Validates `examples/bruno-collections.yaml` on two axes:
 *
 *  1. Catalog side — each document is run through the SAME validators the
 *     catalog backend uses (`@backstage/catalog-model`'s entity policies and
 *     per-kind schema validators), so a file that passes here is a file the
 *     catalog will ingest.
 *  2. OpenAPI side — each `spec.definition` is validated against the official
 *     OpenAPI 3.0 JSON Schema (`@apidevtools/openapi-schemas`) plus the
 *     structural rules that schema cannot express: `{param}` in a path must
 *     have a matching required path parameter, every `security` requirement
 *     must name a declared scheme, and server variables must be declared.
 *
 * Usage: node scripts/bruno-catalog/validate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv-draft-04';
import { openapi } from '@apidevtools/openapi-schemas';
import {
  DefaultNamespaceEntityPolicy,
  EntityPolicies,
  FieldFormatEntityPolicy,
  NoForeignRootFieldsEntityPolicy,
  SchemaValidEntityPolicy,
  apiEntityV1alpha1Validator,
  systemEntityV1alpha1Validator
} from '@backstage/catalog-model';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(HERE, '../../examples/bruno-collections.yaml');

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateOpenApi = ajv.compile(openapi.v3);

// The catalog backend's default policy stack (see CatalogBuilder): envelope
// schema, field formats, no foreign root fields, default namespace.
const entityPolicy = EntityPolicies.allOf([
  new SchemaValidEntityPolicy(),
  new NoForeignRootFieldsEntityPolicy(),
  new FieldFormatEntityPolicy(),
  new DefaultNamespaceEntityPolicy()
]);

const KIND_VALIDATORS = {
  API: apiEntityV1alpha1Validator,
  System: systemEntityV1alpha1Validator
};

const documents = yaml
  .loadAll(fs.readFileSync(TARGET, 'utf8'))
  .filter(Boolean);

let failures = 0;
const apis = [];

for (const doc of documents) {
  const ref = `${doc.kind}:${doc.metadata?.name}`;

  for (const problem of await checkEntity(doc)) {
    console.error(`FAIL ${ref}: ${problem}`);
    failures += 1;
  }

  if (doc.kind !== 'API') {
    continue;
  }

  let spec;
  try {
    spec = yaml.load(doc.spec.definition);
  } catch (e) {
    console.error(`FAIL ${ref}: spec.definition is not valid YAML — ${e.message}`);
    failures += 1;
    continue;
  }

  const problems = [];
  if (!validateOpenApi(spec)) {
    for (const err of validateOpenApi.errors.slice(0, 8)) {
      problems.push(`schema ${err.instancePath || '/'} ${err.message}`);
    }
  }
  problems.push(...checkSpecStructure(spec));

  for (const problem of problems) {
    console.error(`FAIL ${ref}: ${problem}`);
  }
  failures += problems.length;

  apis.push({ ref, spec, ok: problems.length === 0 });
}

report(apis);

if (failures > 0) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll entities and OpenAPI definitions are valid.');

/* --------------------------------- checks --------------------------------- */

/**
 * Runs the catalog's own entity policies and per-kind validator, so failures
 * here are exactly the failures ingestion would report.
 */
async function checkEntity(doc) {
  const problems = [];

  try {
    await entityPolicy.enforce(doc);
  } catch (e) {
    problems.push(`entity policy: ${e.message}`);
  }

  const validator = KIND_VALIDATORS[doc.kind];
  if (!validator) {
    problems.push(`no validator registered for kind "${doc.kind}"`);
    return problems;
  }
  try {
    if (!(await validator.check(doc))) {
      problems.push(`kind ${doc.kind} validator did not accept the entity`);
    }
  } catch (e) {
    problems.push(`kind ${doc.kind} validator: ${e.message}`);
  }

  // Not schema-enforced, but an API entity with an empty definition renders an
  // empty docs tab rather than failing, so check it explicitly.
  if (
    doc.kind === 'API'
    && (typeof doc.spec?.definition !== 'string' || !doc.spec.definition.trim())
  ) {
    problems.push('spec.definition is missing or empty');
  }

  return problems;
}

/**
 * Structural rules the OpenAPI JSON Schema does not enforce: `{param}` in a
 * path must have a matching required path parameter (and vice versa), and every
 * `security` requirement must name a declared scheme.
 */
function checkSpecStructure(spec) {
  const problems = [];
  const schemes = new Set(
    Object.keys(spec.components?.securitySchemes ?? {})
  );

  for (const [pathKey, pathItem] of Object.entries(spec.paths ?? {})) {
    const templated = new Set(
      [...pathKey.matchAll(/\{([^}]*)\}/g)].map((m) => m[1])
    );
    if (templated.has('')) {
      problems.push(`path "${pathKey}" has an empty {} template`);
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (method === 'parameters' || method === 'servers') {
        continue;
      }
      const declared = new Set(
        (operation.parameters ?? [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name)
      );
      for (const name of templated) {
        if (!declared.has(name)) {
          problems.push(
            `${method.toUpperCase()} ${pathKey}: {${name}} has no path parameter`
          );
        }
      }
      for (const name of declared) {
        if (!templated.has(name)) {
          problems.push(
            `${method.toUpperCase()} ${pathKey}: path parameter "${name}" is not in the template`
          );
        }
      }
      if (!operation.responses || !Object.keys(operation.responses).length) {
        problems.push(`${method.toUpperCase()} ${pathKey}: no responses`);
      }
      for (const requirement of operation.security ?? []) {
        for (const scheme of Object.keys(requirement)) {
          if (!schemes.has(scheme)) {
            problems.push(
              `${method.toUpperCase()} ${pathKey}: security scheme "${scheme}" is not declared`
            );
          }
        }
      }
    }
  }

  // Server variables must have a default and be referenced by the URL template.
  for (const server of spec.servers ?? []) {
    const used = new Set(
      [...server.url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
    );
    for (const name of used) {
      if (!server.variables?.[name]) {
        problems.push(`server "${server.url}": variable {${name}} is not declared`);
      }
    }
  }

  return problems;
}

/* --------------------------------- report ---------------------------------- */

function report(apis) {
  console.log(
    `Validated ${apis.length} API entit${apis.length === 1 ? 'y' : 'ies'}:\n`
  );
  for (const { ref, spec, ok } of apis) {
    const operations = Object.values(spec.paths ?? {}).reduce(
      (n, p) =>
        n
        + Object.keys(p).filter((k) => k !== 'parameters' && k !== 'servers')
          .length,
      0
    );
    const responseCodes = new Set();
    const bodies = new Set();
    for (const pathItem of Object.values(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (method === 'parameters' || method === 'servers') {
          continue;
        }
        Object.keys(op.responses ?? {}).forEach((c) => responseCodes.add(c));
        Object.keys(op.requestBody?.content ?? {}).forEach((m) => bodies.add(m));
      }
    }
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${ref.padEnd(30)} `
      + `${String(operations).padStart(2)} ops, `
      + `${String(Object.keys(spec.paths ?? {}).length).padStart(2)} paths, `
      + `codes [${[...responseCodes].sort().join(' ')}]`
      + (bodies.size ? `, bodies [${[...bodies].sort().join(' ')}]` : '')
      + (spec.components?.securitySchemes
        ? `, auth [${Object.keys(spec.components.securitySchemes).join(' ')}]`
        : '')
    );
  }
}
