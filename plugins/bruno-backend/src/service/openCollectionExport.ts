/**
 * Adapter + serializer producing an OpenCollection `1.0.0` YAML string from a
 * cached `CollectionDetail`.
 *
 * `@usebruno/converters`' `brunoToOpenCollection` consumes Bruno's in-memory
 * `BrunoCollection` (nested auth/body blocks, `'http-request'`/`'graphql-request'`
 * item types), NOT our flat `NormalizedCollection`. This module reshapes the
 * latter into a minimal `BrunoCollectionLike` and hands it to the converter.
 *
 * Redaction (single choke point, D-D): secrets are dropped WHILE building the
 * BrunoCollectionLike — the cached `detail.collection` is never mutated. Auth
 * secret values (`basic.password`, `bearer.token`, `digest.password`,
 * `apikey.value`) become `REDACTED`; every environment variable value is dropped
 * via `secret: true`. Usernames, apikey key-names, urls, and header/param
 * names+values are preserved.
 *
 * Divergences (R-A): the output is faithful-for-docs but NOT byte-identical to
 * Bruno's native exporter — collection/folder request-defaults, settings,
 * examples, tags and full `brunoConfig` are absent from our source model.
 * Assertions are omitted (R-C).
 *
 * R-D, the "secrets in VALUES are not redacted" gap, is now PARTIALLY closed:
 * header and query/path param values whose NAME looks secret
 * ({@link SECRET_NAME_PATTERN}) are replaced, because the same YAML is now
 * stored on a catalog entity, where the audience is "anything that can read the
 * catalog" rather than one signed-in user entitled to that one collection
 * (BE-P2 §3). A `{{placeholder}}` value is a REFERENCE, not a secret, and passes
 * through — redacting it would destroy the docs for no gain.
 *
 * The residual, stated rather than hidden: under the default `standard` mode
 * request BODIES, `script.req`/`script.res` and `tests` are emitted verbatim,
 * and those are the likeliest places a hardcoded credential hides. They are also
 * what makes the rendered docs worth anything, so the escape hatch is a config
 * knob (`bruno.definition.redaction: 'strict'`) rather than a silent default.
 * See BE-P2 §3 and R8.
 */
import type {
  CollectionDetail,
  Environment,
  FolderItem,
  Item,
  KeyValue,
  NormalizedCollection,
  Param,
  RequestAuth,
  RequestBody,
  RequestItem
} from '../types';
import { brunoToOpenCollection } from '@usebruno/converters';
import yaml from 'js-yaml';

const REDACTED = '<redacted>';

/** How much to strip from the generated YAML. See BE-P2 §3. */
export type RedactionMode = 'standard' | 'strict';

/** Options for {@link toOpenCollectionYaml}. */
export interface OpenCollectionExportOptions {
  /** ISO timestamp for `extensions.bruno.exportedAt`. `null` OMITS the key —
   *  required for the catalog-stored variant: a per-call timestamp changes
   *  `resultHash` every reprocess cycle and rewrites the entity. Default:
   *  `new Date().toISOString()`, preserving today's route behaviour. */
  exportedAt?: string | null;
  /** `'standard'` (default) or `'strict'`. See BE-P2 §3. */
  redaction?: RedactionMode;
}

/**
 * Header / param names whose VALUE is a secret often enough that emitting it is
 * not worth the risk. Two shapes in one pattern: the well-known headers matched
 * whole, and the substrings that mark a name as credential-bearing wherever they
 * appear (`X-Api-Key`, `sessionToken`, `db_password`, …).
 */
const SECRET_NAME_PATTERN
  = /^(authorization|proxy-authorization|cookie|set-cookie)$|api-?key|token|secret|password|passwd|credential|session/i;

/** A `{{var}}` value names a variable rather than carrying its content, so it is
 *  documentation, not exposure. Mirrors the docs-HTML renderer's `maskSecret`. */
function isPlaceholder(value: string): boolean {
  return /^\{\{.*\}\}$/.test(value.trim());
}

/**
 * Replaces the values of secret-looking NAMES in a header / param list, leaving
 * the list itself — names, order, enabled flags — intact so the docs still show
 * what a request sends.
 */
function redactNamedValues<T extends KeyValue | Param>(pairs: T[]): T[] {
  return pairs.map((pair) =>
    pair.value && SECRET_NAME_PATTERN.test(pair.name) && !isPlaceholder(pair.value)
      ? { ...pair, value: REDACTED }
      : pair
  );
}

/**
 * Auth-block field names whose values are secrets across the supported modes
 * (`basic.password`, `bearer.token`, `digest.password`, `apikey.value`, plus
 * common OAuth fields). Mirrors the per-mode redaction {@link mapAuth} applies
 * to the YAML export.
 */
const AUTH_SECRET_KEYS = new Set([
  'password',
  'token',
  'secret',
  'value',
  'passphrase',
  'privateKey',
  'clientSecret',
  'accessToken',
  'refreshToken'
]);

function redactAuthInPlace(auth: RequestAuth | undefined): void {
  if (!auth) {
    return;
  }
  for (const key of Object.keys(auth)) {
    if (
      key !== 'mode'
      && AUTH_SECRET_KEYS.has(key)
      && typeof auth[key] === 'string'
      && auth[key] !== ''
    ) {
      auth[key] = REDACTED;
    }
  }
}

function redactItemsInPlace(items: Item[]): void {
  for (const item of items) {
    if (item.type === 'folder') {
      redactItemsInPlace(item.items);
    } else {
      redactAuthInPlace(item.auth);
    }
  }
}

/**
 * Returns a deep copy of a {@link CollectionDetail} with secrets stripped, for
 * the JSON detail endpoint. Applies the SAME redaction stance as the YAML
 * export ({@link toOpenCollectionYaml}) through this single choke point: every
 * environment-variable value is dropped (env vars routinely hold tokens/keys
 * and can't be told apart from non-secrets), and auth-block secret fields
 * become `<redacted>`. The cached `detail` is never mutated (structuredClone).
 *
 * As with the export (R-D), secrets hardcoded into header/param/body *values*
 * are NOT redacted here — that stays documented and is tracked as a hardening
 * item.
 *
 * @public
 */
export function redactCollectionDetail(
  detail: CollectionDetail
): CollectionDetail {
  const clone = structuredClone(detail);
  for (const env of clone.collection.environments) {
    for (const v of env.variables) {
      if (v.value) {
        v.value = REDACTED;
      }
    }
  }
  redactItemsInPlace(clone.collection.items);
  return clone;
}

interface BrunoCollectionLike {
  name: string;
  brunoConfig?: { version?: string };
  environments?: unknown[];
  items?: unknown[];
  root?: { docs?: string };
}

function mapEnv(env: Environment): unknown {
  return {
    name: env.name,
    variables: env.variables.map((v) => ({
      name: v.name,
      secret: true,
      enabled: v.enabled
    }))
  };
}

function mapBody(body: RequestBody | undefined, redaction: RedactionMode): unknown {
  if (!body) {
    return { mode: 'none' };
  }
  // `strict` keeps the SHAPE — the mode, and the key the converter reads for it
  // — and drops only the content, so the docs still say "this request posts
  // JSON" without saying what is in it.
  const strict = redaction === 'strict';
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: body.mode, [body.mode]: strict ? REDACTED : body.raw ?? '' };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: { query: strict ? REDACTED : body.raw ?? '' }
      };
    case 'formUrlEncoded':
      return {
        mode: 'formUrlEncoded',
        formUrlEncoded: strict ? [] : body.form ?? []
      };
    case 'multipartForm':
      return {
        mode: 'multipartForm',
        multipartForm: strict
          ? []
          : (body.form ?? []).map((f) => ({ ...f, type: 'text' }))
      };
    default:
      return { mode: 'none' };
  }
}

function mapAuth(auth?: RequestAuth): unknown {
  if (!auth || auth.mode === 'none') {
    return undefined;
  }
  switch (auth.mode) {
    case 'inherit':
      return { mode: 'inherit' };
    case 'basic':
      return {
        mode: 'basic',
        basic: { username: String(auth.username ?? ''), password: REDACTED }
      };
    case 'bearer':
      return { mode: 'bearer', bearer: { token: REDACTED } };
    case 'digest':
      return {
        mode: 'digest',
        digest: { username: String(auth.username ?? ''), password: REDACTED }
      };
    case 'apikey':
      return {
        mode: 'apikey',
        apikey: {
          key: String(auth.key ?? ''),
          value: REDACTED,
          placement: auth.placement ?? null
        }
      };
    default:
      return undefined;
  }
}

function mapRequest(item: RequestItem, redaction: RedactionMode): unknown {
  const strict = redaction === 'strict';
  return {
    type: item.type === 'graphql' ? 'graphql-request' : 'http-request',
    name: item.name,
    seq: item.seq,
    request: {
      method: item.method,
      url: item.url,
      // The single choke point for header/param value redaction: everything
      // reaching the YAML for a request passes through here.
      headers: redactNamedValues(item.headers),
      params: redactNamedValues(item.params),
      body: mapBody(item.body, redaction),
      auth: mapAuth(item.auth),
      // Scripts are the single most common hiding place for a hardcoded
      // credential, and nothing about their name reveals it, so `strict` drops
      // them wholesale rather than trying to be clever.
      script: strict
        ? { req: null, res: null }
        : { req: item.script?.req ?? null, res: item.script?.res ?? null },
      tests: strict ? null : item.tests ?? null,
      docs: item.docs ?? null
    }
  };
}

function mapFolder(item: FolderItem, redaction: RedactionMode): unknown {
  return {
    type: 'folder',
    name: item.name,
    items: mapItems(item.items, redaction),
    ...(item.docs ? { root: { docs: item.docs } } : {})
  };
}

function mapItems(items: Item[], redaction: RedactionMode): unknown[] {
  return items.map((item) =>
    item.type === 'folder'
      ? mapFolder(item, redaction)
      : mapRequest(item, redaction)
  );
}

function normalizedToBrunoCollection(
  collection: NormalizedCollection,
  redaction: RedactionMode
): BrunoCollectionLike {
  return {
    name: collection.name,
    ...(collection.version ? { brunoConfig: { version: collection.version } } : {}),
    environments: collection.environments.map(mapEnv),
    items: mapItems(collection.items, redaction),
    ...(collection.readme ? { root: { docs: collection.readme } } : {})
  };
}

/**
 * Serializes a {@link NormalizedCollection} as an OpenCollection `1.0.0` YAML
 * document.
 *
 * Takes the collection rather than the enclosing `CollectionDetail` because the
 * only field it ever read was `detail.collection`, and the catalog-entity caller
 * has a collection but no detail to wrap it in.
 *
 * With no options the output is byte-identical to what the `/api/bruno/*` routes
 * have always produced. `exportedAt: null` makes it byte-STABLE instead, which
 * is what the entity path needs: per BE-P2 F11 the catalog hashes the processed
 * entity, so a per-call timestamp would rewrite and re-stitch every Bruno entity
 * on every reprocess cycle.
 *
 * @public
 */
export function toOpenCollectionYaml(
  collection: NormalizedCollection,
  options?: OpenCollectionExportOptions
): string {
  const bruno = normalizedToBrunoCollection(
    collection,
    options?.redaction ?? 'standard'
  );
  const oc = brunoToOpenCollection(bruno);
  const exportedAt
    = options?.exportedAt === undefined
      ? new Date().toISOString()
      : options.exportedAt;
  oc.extensions = {
    ...(oc.extensions ?? {}),
    bruno: {
      ...(oc.extensions?.bruno ?? {}),
      // Omitted entirely — not written as null — when the caller asked for a
      // stable document; a `null` key would still be a key in the YAML.
      ...(typeof exportedAt === 'string' && { exportedAt }),
      exportedUsing: 'bruno-for-backstage'
    }
  };
  return yaml.dump(oc, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });
}
