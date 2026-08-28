/**
 * Maps an OpenCollection `1.0.0` document (as produced by
 * `@usebruno/converters`' `brunoToOpenCollection`) to an OpenAPI `3.0.3`
 * document.
 *
 * WHY THIS FILE EXISTS: `@usebruno/converters` converts *into* Bruno
 * (`openApiToBruno`, `postmanToBruno`, `insomniaToBruno`, `wsdlToBruno`) and
 * sideways (`brunoToPostman`, `brunoToOpenCollection`) — it has no
 * `brunoToOpenApi`. So the converter package does the Bruno-side normalization
 * (nested auth/body blocks, request-type tagging, example passthrough) and this
 * module does the OpenAPI-side mapping on top of its canonical output. Working
 * from OpenCollection rather than raw `.bru`/`.yml` means we inherit the
 * converter's handling of both on-disk formats.
 *
 * Mapping summary:
 *  - `{{var}}` / `:param` URL templating  -> server variables + `{param}` paths
 *  - `params[type=path|query]`            -> `in: path` (required) / `in: query`
 *  - `headers`                            -> `in: header` (auth/content headers dropped)
 *  - `http.body`                          -> `requestBody` with a schema inferred
 *                                            from the recorded example payload
 *  - `examples[].response`                -> real `responses` with status codes,
 *                                            media types, schemas and examples
 *  - asserted `res.status` / `res.getStatus()` -> extra response codes
 *  - `auth`                               -> `components.securitySchemes` + `security`
 *  - `info.tags` else folder path         -> `tags` (Swagger UI grouping)
 *
 * Everything the mapper cannot express in OpenAPI (scripts, tests, seq, source
 * paths) is preserved under `x-bruno-*` extensions rather than dropped.
 */

const OPENAPI_VERSION = '3.0.3';

/** Header names carried by OpenAPI constructs rather than `in: header` params. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'host',
  'cookie'
]);

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace'
]);

/**
 * @param {object} oc OpenCollection document from `brunoToOpenCollection`
 * @param {object} opts
 * @param {string} opts.title           `info.title`
 * @param {string} opts.version         `info.version`
 * @param {string} [opts.description]   prepended to `info.description`
 * @param {Array}  [opts.environments]  Bruno environments, used to resolve
 *                                      `{{var}}` server defaults
 * @param {string} [opts.sourceUrl]     recorded under `x-bruno-source`
 * @returns {{ spec: object, stats: object, warnings: string[] }}
 */
export function openCollectionToOpenApi(oc, opts) {
  const warnings = [];
  const vars = variableMap(opts.environments ?? []);
  const operations = [];
  const tagDescriptions = new Map();

  collectOperations(oc.items ?? [], [], operations, tagDescriptions, warnings);

  const servers = buildServers(operations, vars);
  const primaryServer = servers[0]?.url;
  const securitySchemes = {};
  const paths = {};
  const seenOperationIds = new Set();
  let skipped = 0;
  let emitted = 0;
  let folded = 0;

  for (const op of operations) {
    if (op.kind === 'unsupported') {
      warnings.push(
        `skipped "${op.name}": ${op.reason} is not representable in OpenAPI`
      );
      skipped += 1;
      continue;
    }

    const method = op.method.toLowerCase();
    if (!HTTP_METHODS.has(method)) {
      warnings.push(`skipped "${op.name}": unsupported method ${op.method}`);
      skipped += 1;
      continue;
    }

    const pathItem = paths[op.path] ?? (paths[op.path] = {});
    if (pathItem[method]) {
      // Two requests hitting the same method+path (a happy path and its error
      // case, typically). Fold the second into the first as extra responses and
      // extra body examples rather than silently dropping it.
      mergeOperation(pathItem[method], op, warnings);
      folded += 1;
      continue;
    }

    const operation = {
      operationId: uniqueId(operationId(op), seenOperationIds),
      summary: op.name,
      ...(op.description ? { description: op.description } : {}),
      ...(op.tags.length ? { tags: op.tags } : {}),
      ...(op.parameters.length ? { parameters: op.parameters } : {}),
      ...(op.requestBody ? { requestBody: op.requestBody } : {}),
      responses: op.responses
    };

    const security = securityFor(op.auth, securitySchemes, warnings);
    if (security) {
      operation.security = security;
    }
    // A request pointing somewhere other than the primary server keeps its own
    // `servers` so the path stays resolvable.
    if (op.serverUrl && primaryServer && op.serverUrl !== primaryServer) {
      operation.servers = [{ url: op.serverUrl }];
    }
    Object.assign(operation, op.extensions);

    pathItem[method] = operation;
    emitted += 1;
  }

  const tags = [...tagDescriptions.entries()]
    .map(([name, description]) => ({
      name,
      ...(description ? { description } : {})
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const spec = {
    openapi: OPENAPI_VERSION,
    info: {
      title: opts.title,
      version: opts.version,
      description: infoDescription(opts.description, oc)
    },
    ...(servers.length ? { servers } : {}),
    ...(tags.length ? { tags } : {}),
    paths,
    ...(Object.keys(securitySchemes).length
      ? { components: { securitySchemes } }
      : {})
  };

  if (opts.sourceUrl) {
    spec['x-bruno-source'] = opts.sourceUrl;
  }
  spec['x-bruno-generated-by']
    = '@usebruno/converters brunoToOpenCollection + scripts/bruno-catalog';

  return {
    spec,
    stats: {
      // `requests` counts what the collection holds; `operations` counts what
      // OpenAPI ended up with — they differ whenever several requests hit the
      // same method+path and got folded together.
      requests: operations.length,
      operations: emitted,
      folded,
      paths: Object.keys(paths).length,
      skipped
    },
    warnings
  };
}

/* --------------------------- item tree traversal --------------------------- */

function collectOperations(items, folderPath, out, tagDescriptions, warnings) {
  for (const item of items) {
    // A folder in OpenCollection is any item carrying children.
    if (Array.isArray(item.items) && item.items.length > 0 && !item.http) {
      const name = item.info?.name ?? 'folder';
      const docs = item.docs || undefined;
      if (!tagDescriptions.has(name) || docs) {
        tagDescriptions.set(name, firstLine(docs));
      }
      collectOperations(
        item.items,
        [...folderPath, name],
        out,
        tagDescriptions,
        warnings
      );
      continue;
    }

    const type = item.info?.type;
    if (type === 'grpc' || type === 'ws' || type === 'websocket') {
      out.push({
        kind: 'unsupported',
        name: item.info?.name ?? 'request',
        reason: type
      });
      continue;
    }
    if (!item.http) {
      continue;
    }

    const op = buildOperation(item, folderPath, warnings);
    if (op) {
      for (const tag of op.tags) {
        if (!tagDescriptions.has(tag)) {
          tagDescriptions.set(tag, undefined);
        }
      }
      out.push(op);
    }
  }
}

function buildOperation(item, folderPath, warnings) {
  const http = item.http;
  const name = item.info?.name ?? 'request';
  const isGraphql = item.info?.type === 'graphql';

  const { serverRaw, pathTemplate, queryFromUrl } = splitUrl(http.url ?? '');
  const declaredParams = http.params ?? [];

  const parameters = [
    ...pathParameters(pathTemplate, declaredParams),
    ...queryParameters(declaredParams, queryFromUrl),
    ...headerParameters(http.headers ?? [])
  ];

  const requestBody = isGraphql
    ? graphqlRequestBody(http)
    : buildRequestBody(http.body, name, warnings);

  const responses = buildResponses(item, warnings);

  const tags = (item.info?.tags?.length ? item.info.tags : folderPath).filter(
    Boolean
  );

  const extensions = {};
  if (typeof item.info?.seq === 'number') {
    extensions['x-bruno-seq'] = item.info.seq;
  }
  if (http.script?.req || http.script?.res || item.script) {
    extensions['x-bruno-has-scripts'] = true;
  }
  const asserts = assertionSummary(item);
  if (asserts.length) {
    extensions['x-bruno-assertions'] = asserts;
  }
  if (isGraphql) {
    extensions['x-bruno-request-type'] = 'graphql';
  }

  return {
    kind: 'http',
    name,
    method: isGraphql ? 'POST' : (http.method ?? 'GET').toUpperCase(),
    path: pathTemplate,
    serverRaw,
    description: item.docs || undefined,
    tags,
    parameters,
    requestBody,
    responses,
    auth: http.auth,
    extensions
  };
}

/**
 * Folds a duplicate method+path request into the operation already recorded:
 * its responses are added (new status codes only) and its request-body example
 * is kept alongside the first one.
 */
function mergeOperation(existing, op, warnings) {
  for (const [status, response] of Object.entries(op.responses)) {
    if (!existing.responses[status]) {
      existing.responses[status] = response;
    }
  }
  const media = 'application/json';
  const from = op.requestBody?.content?.[media];
  const into = existing.requestBody?.content?.[media];
  if (from?.example !== undefined && into && into.example !== undefined) {
    into.examples = into.examples ?? {
      [existing.summary]: { value: into.example }
    };
    into.examples[op.name] = { value: from.example };
    delete into.example;
  }
  const alsoKnownAs = existing['x-bruno-also-from'] ?? [];
  existing['x-bruno-also-from'] = [...alsoKnownAs, op.name];
  warnings.push(
    `"${op.name}" shares ${op.method} ${op.path} with "${existing.summary}" — `
    + 'folded in as extra responses/examples'
  );
}

/* ------------------------------ URL handling ------------------------------ */

/**
 * Splits a Bruno URL into its server part, an OpenAPI path template and any
 * inline query string.
 *
 * `{{baseUrl}}/orders/:orderId?limit=5`
 *   -> serverRaw '{{baseUrl}}', path '/orders/{orderId}', query { limit: '5' }
 *
 * `https://api.github.com/repos/:owner/:repo`
 *   -> serverRaw 'https://api.github.com', path '/repos/{owner}/{repo}'
 */
function splitUrl(rawUrl) {
  const url = (rawUrl ?? '').trim();
  const [beforeQuery, ...queryParts] = url.split('?');
  const queryFromUrl = parseQuery(queryParts.join('?'));

  let serverRaw = '';
  let rest = beforeQuery;

  const leadingVar = beforeQuery.match(/^\{\{\s*([^}]+?)\s*\}\}/);
  const absolute = beforeQuery.match(/^([a-zA-Z][\w+.-]*:\/\/[^/]+)/);

  if (leadingVar) {
    serverRaw = leadingVar[0];
    rest = beforeQuery.slice(leadingVar[0].length);
  } else if (absolute) {
    serverRaw = absolute[1];
    rest = beforeQuery.slice(absolute[1].length);
  }

  // A `{{var}}` server may itself carry a static path suffix that is part of
  // every request (e.g. `{{host}}/api`); OpenAPI keeps that on the server URL
  // only when it is literally in the variable, so leave it in the path here.
  let pathTemplate = rest || '/';
  if (!pathTemplate.startsWith('/')) {
    pathTemplate = `/${pathTemplate}`;
  }
  pathTemplate = toPathTemplate(pathTemplate);

  return { serverRaw, pathTemplate, queryFromUrl };
}

/** `:id` and `{{id}}` path segments become OpenAPI `{id}` placeholders. */
function toPathTemplate(pathname) {
  // Bruno tolerates an empty `{{}}` placeholder (a variable the author has not
  // named yet); `{}` is not a legal OpenAPI template, so number those instead.
  let anonymous = 0;
  const named = (v) => paramName(v) || `param${(anonymous += 1)}`;

  return pathname
    .replace(/\{\{([^}]*)\}\}/g, (_m, v) => `{${named(v)}}`)
    .replace(/:([A-Za-z_][\w-]*)/g, (_m, v) => `{${named(v)}}`)
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    || '/';
}

/** OpenAPI parameter names allow only a safe subset; normalize to it. */
function paramName(raw) {
  return String(raw).trim().replace(/[^A-Za-z0-9_.-]/g, '_');
}

function parseQuery(queryString) {
  const out = [];
  if (!queryString) {
    return out;
  }
  for (const pair of queryString.split('&')) {
    if (!pair) {
      continue;
    }
    const idx = pair.indexOf('=');
    const name = idx === -1 ? pair : pair.slice(0, idx);
    const value = idx === -1 ? '' : pair.slice(idx + 1);
    out.push({ name: safeDecode(name), value: safeDecode(value) });
  }
  return out;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Builds the `servers` list. Every distinct server part is resolved against the
 * collection's environment variables; the most-used one comes first and becomes
 * the document-level server.
 */
function buildServers(operations, vars) {
  const counts = new Map();
  for (const op of operations) {
    if (op.kind !== 'http') {
      continue;
    }
    const resolved = resolveServer(op.serverRaw, vars);
    op.serverUrl = resolved.url;
    if (!resolved.url) {
      continue;
    }
    const entry = counts.get(resolved.url) ?? { ...resolved, count: 0 };
    entry.count += 1;
    counts.set(resolved.url, entry);
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .map(({ url, description, variables }) => ({
      url,
      ...(description ? { description } : {}),
      ...(variables ? { variables } : {})
    }));
}

/**
 * Resolves a raw server part to an OpenAPI server. A `{{var}}` server becomes a
 * templated `{var}` URL with the environment value as its default, so the spec
 * documents the variable AND is usable in Swagger UI's "try it".
 */
function resolveServer(serverRaw, vars) {
  if (!serverRaw) {
    return { url: '' };
  }
  const varMatch = serverRaw.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (!varMatch) {
    return { url: serverRaw };
  }
  const raw = varMatch[1].trim();
  const name = paramName(raw);
  const entry = vars.get(raw);

  // No environment defines the variable — say so rather than letting an invented
  // placeholder read as the real base URL.
  if (!entry?.value) {
    return {
      url: `{${name}}`,
      description: `Bruno variable {{${raw}}} — not set in any collection environment`,
      variables: {
        [name]: {
          default: 'https://replace-me.example.com',
          description:
            `No collection environment defines {{${raw}}}; substitute the base `
            + 'URL for the deployment you are calling.'
        }
      }
    };
  }

  return {
    url: `{${name}}`,
    description: `Bruno variable {{${raw}}} (from environment "${entry.env}")`,
    variables: {
      [name]: {
        default: entry.value,
        description: entry.secret
          ? `Marked secret in the Bruno environment "${entry.env}"`
          : `Base URL from the Bruno environment "${entry.env}"`
      }
    }
  };
}

/** First non-empty value wins; records which environment supplied it. */
function variableMap(environments) {
  const map = new Map();
  for (const env of environments) {
    for (const v of env.variables ?? []) {
      if (v.enabled === false || map.has(v.name)) {
        continue;
      }
      map.set(v.name, { value: v.value ?? '', env: env.name, secret: v.secret });
    }
  }
  return map;
}

/* ------------------------------- parameters ------------------------------- */

function pathParameters(pathTemplate, declaredParams) {
  const names = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const declared = new Map(
    declaredParams
      .filter((p) => p.type === 'path')
      .map((p) => [paramName(p.name), p])
  );

  return names.map((name) => {
    const source = declared.get(name);
    return {
      name,
      in: 'path',
      required: true,
      ...(source?.description ? { description: source.description } : {}),
      ...typedSchemaAndExample(source?.value)
    };
  });
}

function queryParameters(declaredParams, queryFromUrl) {
  const params = [];
  const seen = new Set();

  for (const p of declaredParams) {
    if (p.type === 'path' || p.enabled === false || !p.name) {
      continue;
    }
    const name = p.name;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    params.push({
      name,
      in: 'query',
      required: false,
      ...(p.description ? { description: p.description } : {}),
      ...typedSchemaAndExample(p.value)
    });
  }

  for (const p of queryFromUrl) {
    if (!p.name || seen.has(p.name)) {
      continue;
    }
    seen.add(p.name);
    params.push({
      name: p.name,
      in: 'query',
      required: false,
      ...typedSchemaAndExample(p.value)
    });
  }

  return params;
}

function headerParameters(headers) {
  const params = [];
  const seen = new Set();
  for (const h of headers) {
    const name = h.name ?? h.key;
    if (!name || h.enabled === false) {
      continue;
    }
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    params.push({
      name,
      in: 'header',
      required: false,
      ...(h.description ? { description: h.description } : {}),
      schema: { type: 'string' },
      ...(h.value ? { example: String(h.value) } : {})
    });
  }
  return params;
}

/* ------------------------------ request body ------------------------------ */

/**
 * OpenCollection spells body types in kebab-case where the Bruno model uses
 * camelCase (`form-urlencoded` vs `formUrlEncoded`). Accept both so the mapper
 * works on either shape.
 */
const BODY_TYPE_ALIASES = {
  'form-urlencoded': 'formUrlEncoded',
  'formurlencoded': 'formUrlEncoded',
  'multipart-form': 'multipartForm',
  'multipart-form-data': 'multipartForm',
  'multipartform': 'multipartForm',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/plain': 'text'
};

function canonicalBodyType(type) {
  if (!type) {
    return type;
  }
  return BODY_TYPE_ALIASES[String(type).toLowerCase()] ?? type;
}

function buildRequestBody(body, requestName, warnings) {
  if (!body) {
    return undefined;
  }
  const rawType = body.type ?? body.mode;
  const type = canonicalBodyType(rawType);
  const data = body.data ?? body[rawType] ?? body[type];

  switch (type) {
    case undefined:
    case 'none':
      return undefined;

    case 'json': {
      const parsed = parseJsonish(data);
      if (parsed.ok) {
        return jsonBody(inferSchema(parsed.value), parsed.value);
      }
      if (isBlank(data)) {
        return undefined;
      }
      warnings.push(
        `"${requestName}": JSON body is not parseable (likely Bruno templating) `
        + '— emitted as a free-form object'
      );
      return {
        required: true,
        content: {
          'application/json': {
            'schema': { type: 'object' },
            'x-bruno-raw-body': String(data)
          }
        }
      };
    }

    case 'text':
      return isBlank(data)
        ? undefined
        : rawBody('text/plain', String(data));

    case 'xml':
      return isBlank(data)
        ? undefined
        : rawBody('application/xml', String(data));

    case 'sparql':
      return isBlank(data)
        ? undefined
        : rawBody('application/sparql-query', String(data));

    case 'formUrlEncoded':
      return formBody('application/x-www-form-urlencoded', data);

    case 'multipartForm':
      return formBody('multipart/form-data', data, true);

    case 'file':
      return {
        required: true,
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' }
          }
        }
      };

    case 'graphql':
      return graphqlBodyFrom(data);

    default:
      warnings.push(`"${requestName}": unmapped body type "${type}"`);
      return undefined;
  }
}

function jsonBody(schema, example) {
  return {
    required: true,
    content: { 'application/json': { schema, example } }
  };
}

function rawBody(mediaType, example) {
  return {
    required: true,
    content: { [mediaType]: { schema: { type: 'string' }, example } }
  };
}

function formBody(mediaType, entries, allowBinary = false) {
  const fields = (Array.isArray(entries) ? entries : []).filter(
    (f) => f?.name && f.enabled !== false
  );
  if (!fields.length) {
    return undefined;
  }
  const properties = {};
  for (const f of fields) {
    properties[f.name]
      = allowBinary && f.type === 'file'
        ? { type: 'string', format: 'binary' }
        : (() => {
            const { schema, example } = typedSchemaAndExample(f.value);
            return { ...schema, ...(example === undefined ? {} : { example }) };
          })();
  }
  return {
    required: true,
    content: { [mediaType]: { schema: { type: 'object', properties } } }
  };
}

function graphqlRequestBody(http) {
  return graphqlBodyFrom(http.body?.data ?? http.body?.graphql ?? http.body);
}

function graphqlBodyFrom(data) {
  const query
    = typeof data === 'string' ? data : (data?.query ?? data?.data ?? '');
  const rawVariables = typeof data === 'object' ? data?.variables : undefined;
  const parsedVariables = parseJsonish(rawVariables);

  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'GraphQL query document' },
            variables: { type: 'object', description: 'GraphQL variables' }
          }
        },
        example: {
          query: String(query ?? ''),
          ...(parsedVariables.ok && parsedVariables.value
            ? { variables: parsedVariables.value }
            : {})
        }
      }
    }
  };
}

/* -------------------------------- responses ------------------------------- */

/**
 * Builds `responses` from every signal the collection actually carries:
 * recorded response examples first, then status codes asserted in the `assert`
 * block or checked in `tests`/`script`, then a documented fallback.
 */
function buildResponses(item, warnings) {
  const responses = {};

  for (const example of item.examples ?? []) {
    const res = example.response;
    if (!res || res.status === undefined || res.status === null) {
      continue;
    }
    const status = String(res.status);
    const description
      = example.description || res.statusText || example.name || 'Response';
    const content = responseContent(res, example.name, warnings);

    if (!responses[status]) {
      responses[status] = { description, ...(content ? { content } : {}) };
      continue;
    }
    mergeResponseExample(responses[status], content, example.name);
  }

  for (const status of assertedStatuses(item)) {
    if (!responses[status]) {
      responses[status] = {
        description: `Asserted by the Bruno request (${statusLabel(status)})`
      };
    }
  }

  if (!Object.keys(responses).length) {
    // OpenAPI requires at least one response; say plainly that the collection
    // recorded none rather than inventing a schema.
    responses.default = {
      description:
        'The Bruno collection records no response example or status assertion '
        + 'for this request.'
    };
  }

  return responses;
}

function responseContent(res, exampleName, warnings) {
  const body = res.body;
  const rawType = body?.type ?? body?.mode;
  const type = canonicalBodyType(rawType);
  const data = body?.data ?? (rawType ? body?.[rawType] : undefined);
  if (isBlank(data)) {
    return undefined;
  }

  const mediaType = responseMediaType(res, type);
  if (mediaType === 'application/json') {
    const parsed = parseJsonish(data);
    if (parsed.ok) {
      return {
        'application/json': {
          schema: inferSchema(parsed.value),
          example: parsed.value
        }
      };
    }
    warnings.push(
      `response example "${exampleName}": body is not valid JSON — kept as text`
    );
  }
  return {
    [mediaType]: { schema: { type: 'string' }, example: String(data) }
  };
}

/** Prefers the recorded `Content-Type` header, falling back to the body type. */
function responseMediaType(res, bodyType) {
  const header = (res.headers ?? []).find(
    (h) => (h.name ?? '').toLowerCase() === 'content-type'
  );
  if (header?.value) {
    return String(header.value).split(';')[0].trim();
  }
  switch (bodyType) {
    case 'json':
      return 'application/json';
    case 'xml':
      return 'application/xml';
    case 'text':
      return 'text/plain';
    default:
      return 'application/json';
  }
}

/** A second example for a status already present becomes a named example. */
function mergeResponseExample(response, content, exampleName) {
  if (!content) {
    return;
  }
  const [mediaType, media] = Object.entries(content)[0];
  const existing = response.content?.[mediaType];
  if (!existing) {
    response.content = { ...(response.content ?? {}), [mediaType]: media };
    return;
  }
  existing.examples = existing.examples ?? {
    default: { value: existing.example }
  };
  existing.examples[exampleName || `example-${Object.keys(existing.examples).length}`]
    = { value: media.example };
  delete existing.example;
}

/** Reads the response status: `res.status`, `res.statusCode`, `res.getStatus()`. */
const STATUS_ACCESSOR = /res\s*\.\s*(?:status(?:Code)?\b|getStatus\s*\(\s*\))/g;

/** Equality-shaped assert operators; anything else says nothing about a code. */
const EQUALITY_OPS = new Set(['eq', 'equal', 'equals', 'eql', 'isNumber']);

/**
 * Status codes the request itself checks — the only response evidence most
 * collections carry. Two sources:
 *
 *  - the `assert` block, where the LHS is the expression and the RHS is
 *    `"<op> <value>"` (`res.status` / `eq 200`), or a bare value;
 *  - `tests` / post-response `script`, in any of the spellings Bruno users
 *    write: `res.status === 200`, `expect(res.status).to.eql(201)`,
 *    `expect(res.getStatus()).to.equal(204)`, `.to.be.oneOf([200, 201])`.
 *
 * Rather than one regex per spelling, the scripted pass finds each status
 * accessor and harvests the status codes in the short window that follows it.
 */
function assertedStatuses(item) {
  const found = new Set();

  for (const a of item.http?.assertions ?? item.assertions ?? []) {
    if (a?.enabled === false) {
      continue;
    }
    if (!/res\s*\.\s*status/i.test(String(a.name ?? a.expr ?? ''))) {
      continue;
    }
    const value = String(a.value ?? '').trim();
    const [head, ...rest] = value.split(/\s+/);
    // `eq 200` -> operator + value; a bare `200` -> value only.
    const isOperator = head && !/^\d/.test(head);
    if (isOperator && !EQUALITY_OPS.has(head)) {
      continue;
    }
    const code = (isOperator ? rest.join(' ') : value).match(/\b([1-5]\d{2})\b/);
    if (code) {
      found.add(code[1]);
    }
  }

  const scripted = [
    item.http?.tests,
    item.tests,
    item.http?.script?.res,
    item.script?.res
  ]
    .filter(Boolean)
    .join('\n');

  // Window kept short and stopped at a statement boundary so an unrelated
  // number on a following line is never read as this check's status code.
  const WINDOW = 48;
  for (const match of scripted.matchAll(STATUS_ACCESSOR)) {
    const tail = scripted
      .slice(match.index + match[0].length, match.index + match[0].length + WINDOW)
      .split(/[;\n{}]/)[0];
    for (const code of tail.matchAll(/\b([1-5]\d{2})\b/g)) {
      found.add(code[1]);
    }
  }

  return [...found].sort();
}

function statusLabel(status) {
  const n = Number(status);
  if (n >= 200 && n < 300) {
    return 'success';
  }
  if (n >= 300 && n < 400) {
    return 'redirect';
  }
  if (n >= 400 && n < 500) {
    return 'client error';
  }
  return 'server error';
}

function assertionSummary(item) {
  const asserts = item.http?.assertions ?? item.assertions ?? [];
  return asserts
    .filter((a) => a?.enabled !== false && (a.name || a.expr))
    .map((a) => `${a.name ?? a.expr} ${a.value ?? ''}`.trim());
}

/* -------------------------------- security -------------------------------- */

/**
 * Registers the scheme an operation's auth block implies and returns the
 * operation's `security` requirement.
 *
 * `inherit` returns undefined so the operation falls through to whatever the
 * document declares; `none` returns `[]`, explicitly opting out.
 */
function securityFor(auth, schemes, warnings) {
  const { mode, fields } = normalizeAuth(auth);
  if (!mode || mode === 'inherit') {
    return undefined;
  }
  if (mode === 'none') {
    return [];
  }

  switch (mode) {
    case 'bearer':
      schemes.bearerAuth = { type: 'http', scheme: 'bearer' };
      return [{ bearerAuth: [] }];

    case 'basic':
      schemes.basicAuth = { type: 'http', scheme: 'basic' };
      return [{ basicAuth: [] }];

    case 'digest':
      schemes.digestAuth = { type: 'http', scheme: 'digest' };
      return [{ digestAuth: [] }];

    case 'apikey': {
      // Bruno spells the query placement 'queryparams'; OpenCollection 'query'.
      const placement = String(fields.placement ?? 'header').toLowerCase();
      const location = placement.startsWith('query') ? 'query' : 'header';
      schemes.apiKeyAuth = {
        type: 'apiKey',
        in: location,
        name: fields.key || 'X-API-Key'
      };
      return [{ apiKeyAuth: [] }];
    }

    case 'oauth2': {
      const flows = oauth2Flows(fields);
      if (!flows) {
        warnings.push(`unmapped OAuth2 grant type "${grantLabel(fields)}"`);
        return undefined;
      }
      schemes.oauth2Auth = { type: 'oauth2', flows };
      return [{ oauth2Auth: scopeList(fields.scope) }];
    }

    case 'awsv4':
      // No OpenAPI 3.0 primitive for SigV4; the de-facto convention is an
      // apiKey scheme on Authorization plus the AWS vendor extension.
      schemes.awsSigV4 = {
        'type': 'apiKey',
        'in': 'header',
        'name': 'Authorization',
        'description': 'AWS Signature Version 4',
        'x-amazon-apigateway-authtype': 'awsSigv4'
      };
      return [{ awsSigV4: [] }];

    case 'wsse':
      schemes.wsseAuth = {
        type: 'apiKey',
        in: 'header',
        name: 'X-WSSE',
        description: 'WS-Security UsernameToken'
      };
      return [{ wsseAuth: [] }];

    case 'ntlm':
      schemes.ntlmAuth = {
        type: 'http',
        scheme: 'ntlm',
        description: 'NTLM (not a registered HTTP auth scheme in OpenAPI 3.0)'
      };
      return [{ ntlmAuth: [] }];

    default:
      warnings.push(`unmapped auth mode "${mode}"`);
      return undefined;
  }
}

/**
 * Normalizes the three auth shapes in play:
 *
 *  - `'inherit'`                        mode-only, collapsed to a bare string
 *  - `{ type: 'bearer', token: '...' }` OpenCollection: mode under `type`,
 *                                       fields FLAT alongside it
 *  - `{ mode: 'bearer', bearer: {...} }` the Bruno in-memory model, nested
 */
function normalizeAuth(auth) {
  if (!auth) {
    return { mode: undefined, fields: {} };
  }
  if (typeof auth === 'string') {
    return { mode: auth, fields: {} };
  }
  if (typeof auth.type === 'string') {
    return { mode: auth.type, fields: auth };
  }
  if (typeof auth.mode === 'string') {
    const nested = auth[auth.mode];
    return {
      mode: auth.mode,
      fields: nested && typeof nested === 'object' ? nested : auth
    };
  }
  return { mode: undefined, fields: {} };
}

/**
 * Bruno names the OAuth2 grant `flow` in OpenCollection and `grantType` in its
 * own model, and nests the client id/secret under `credentials`.
 */
function oauth2Flows(fields) {
  const scopes = Object.fromEntries(
    scopeList(fields.scope).map((s) => [s, s])
  );
  const tokenUrl = fields.accessTokenUrl || fields.tokenUrl || '';
  const authorizationUrl = fields.authorizationUrl || '';
  const grant = fields.flow || fields.grantType;

  switch (grant) {
    case 'client_credentials':
      return { clientCredentials: { tokenUrl, scopes } };
    case 'password_credentials':
    case 'password':
      return { password: { tokenUrl, scopes } };
    case 'authorization_code':
    case 'authorization_code_with_pkce':
      return { authorizationCode: { authorizationUrl, tokenUrl, scopes } };
    case 'implicit':
      return { implicit: { authorizationUrl, scopes } };
    default:
      // Grant type unset (common when the token call lives in a sibling
      // request) — client credentials is the safe documented default.
      return tokenUrl || authorizationUrl
        ? { clientCredentials: { tokenUrl, scopes } }
        : undefined;
  }
}

/** Reports an unmapped grant using whichever field name carried it. */
function grantLabel(fields) {
  return fields.flow || fields.grantType || '(unset)';
}

function scopeList(scope) {
  if (!scope) {
    return [];
  }
  return String(scope)
    .split(/[\s,]+/)
    .filter(Boolean);
}

/* ----------------------------- schema inference ---------------------------- */

/** Recursively derives an OpenAPI 3.0 schema from a recorded example value. */
export function inferSchema(value, depth = 0) {
  if (depth > 12) {
    return {};
  }
  if (value === null) {
    return { nullable: true };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length ? mergeSchemas(value.slice(0, 20), depth) : {}
    };
  }
  if (typeof value === 'object') {
    const properties = {};
    for (const [k, v] of Object.entries(value)) {
      properties[k] = inferSchema(v, depth + 1);
    }
    // No `required` list: an example payload shows what a caller *sent*, which
    // is not evidence about what the API demands.
    return { type: 'object', properties };
  }
  return inferScalarSchema(value);
}

/** Unions the schemas of array elements so mixed arrays stay accurate. */
function mergeSchemas(values, depth) {
  const schemas = values.map((v) => inferSchema(v, depth + 1));
  const unique = [];
  for (const schema of schemas) {
    const key = JSON.stringify(schema);
    if (!unique.some((u) => u.key === key)) {
      unique.push({ key, schema });
    }
  }
  if (unique.length === 1) {
    return unique[0].schema;
  }
  // Collapse the common integer/number split rather than emitting a oneOf.
  const types = new Set(unique.map((u) => u.schema.type));
  if (types.size === 1 && types.has('object')) {
    const properties = {};
    for (const { schema } of unique) {
      Object.assign(properties, schema.properties ?? {});
    }
    return { type: 'object', properties };
  }
  if (types.size === 2 && types.has('integer') && types.has('number')) {
    return { type: 'number' };
  }
  return { oneOf: unique.map((u) => u.schema) };
}

const FORMAT_PATTERNS = [
  [/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/, 'date-time'],
  [/^\d{4}-\d{2}-\d{2}$/, 'date'],
  [/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'email'],
  [
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'uuid'
  ],
  [/^https?:\/\/\S+$/, 'uri']
];

/**
 * Builds the `{ schema, example }` pair for a scalar Bruno value.
 *
 * Bruno stores every param and form value as a string, so a value the schema
 * infers as `integer` would otherwise be documented with a *string* example
 * (`example: '1'` under `type: integer`) — a type mismatch tools flag. The
 * example is coerced to whatever the inferred schema says it is.
 */
function typedSchemaAndExample(value) {
  const schema = inferScalarSchema(value);
  if (value === undefined || value === null || value === '') {
    return { schema };
  }
  return { schema, example: coerceToSchema(value, schema) };
}

function coerceToSchema(value, schema) {
  if (typeof value !== 'string') {
    return value;
  }
  switch (schema.type) {
    case 'integer':
      return Number.parseInt(value, 10);
    case 'number':
      return Number.parseFloat(value);
    case 'boolean':
      return value.toLowerCase() === 'true';
    default:
      return value;
  }
}

function inferScalarSchema(value) {
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  if (value === null || value === undefined || value === '') {
    return { type: 'string' };
  }

  const str = String(value);
  // A `{{var}}` placeholder tells us nothing about the type; keep it a string.
  if (/\{\{[^}]+\}\}/.test(str)) {
    return { type: 'string' };
  }
  for (const [pattern, format] of FORMAT_PATTERNS) {
    if (pattern.test(str)) {
      return { type: 'string', format };
    }
  }
  if (/^(true|false)$/i.test(str)) {
    return { type: 'boolean' };
  }
  if (/^-?\d+$/.test(str)) {
    return { type: 'integer' };
  }
  if (/^-?\d*\.\d+$/.test(str)) {
    return { type: 'number' };
  }
  return { type: 'string' };
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Parses a JSON payload that may carry Bruno templating. A bare `{{var}}` in a
 * value position is not valid JSON, so quote those and retry before giving up.
 */
function parseJsonish(data) {
  if (data === undefined || data === null) {
    return { ok: false };
  }
  if (typeof data === 'object') {
    return { ok: true, value: data };
  }
  const text = String(data).trim();
  if (!text) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fall through to the templating-tolerant attempt */
  }
  const quoted = text
    .replace(/([:[,]\s*)(\{\{[^}]+\}\})/g, '$1"$2"')
    .replace(/^\s*(\{\{[^}]+\}\})\s*$/, '"$1"');
  try {
    return { ok: true, value: JSON.parse(quoted) };
  } catch {
    return { ok: false };
  }
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function operationId(op) {
  const parts = [...op.tags, op.name].filter(Boolean).join(' ');
  const slug = parts
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
  return slug || `${op.method.toLowerCase()}Request`;
}

function uniqueId(id, seen) {
  let candidate = id;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${id}${n}`;
    n += 1;
  }
  seen.add(candidate);
  return candidate;
}

function firstLine(text) {
  if (!text) {
    return undefined;
  }
  const line = String(text)
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line || undefined;
}

function infoDescription(prefix, oc) {
  const parts = [];
  if (prefix) {
    parts.push(prefix);
  }
  const docs = oc.info?.description || oc.docs;
  if (docs) {
    parts.push(String(docs).trim());
  }
  return parts.join('\n\n');
}
