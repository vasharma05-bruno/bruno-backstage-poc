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
 * Assertions are omitted (R-C). Secrets embedded in header/param/body VALUES are
 * NOT redacted (R-D) — matches the existing native-viewer/docs-HTML exposure.
 */
import type {
  CollectionDetail,
  Environment,
  FolderItem,
  Item,
  NormalizedCollection,
  RequestAuth,
  RequestBody,
  RequestItem
} from '../types';
import { brunoToOpenCollection } from '@usebruno/converters';
import yaml from 'js-yaml';

const REDACTED = '<redacted>';

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

function mapBody(body?: RequestBody): unknown {
  if (!body) {
    return { mode: 'none' };
  }
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: body.mode, [body.mode]: body.raw ?? '' };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: body.raw ?? '' } };
    case 'formUrlEncoded':
      return { mode: 'formUrlEncoded', formUrlEncoded: body.form ?? [] };
    case 'multipartForm':
      return {
        mode: 'multipartForm',
        multipartForm: (body.form ?? []).map((f) => ({ ...f, type: 'text' }))
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

function mapRequest(item: RequestItem): unknown {
  return {
    type: item.type === 'graphql' ? 'graphql-request' : 'http-request',
    name: item.name,
    seq: item.seq,
    request: {
      method: item.method,
      url: item.url,
      headers: item.headers,
      params: item.params,
      body: mapBody(item.body),
      auth: mapAuth(item.auth),
      script: { req: item.script?.req ?? null, res: item.script?.res ?? null },
      tests: item.tests ?? null,
      docs: item.docs ?? null
    }
  };
}

function mapFolder(item: FolderItem): unknown {
  return {
    type: 'folder',
    name: item.name,
    items: mapItems(item.items),
    ...(item.docs ? { root: { docs: item.docs } } : {})
  };
}

function mapItems(items: Item[]): unknown[] {
  return items.map((item) =>
    item.type === 'folder' ? mapFolder(item) : mapRequest(item)
  );
}

function normalizedToBrunoCollection(
  collection: NormalizedCollection
): BrunoCollectionLike {
  return {
    name: collection.name,
    ...(collection.version ? { brunoConfig: { version: collection.version } } : {}),
    environments: collection.environments.map(mapEnv),
    items: mapItems(collection.items),
    ...(collection.readme ? { root: { docs: collection.readme } } : {})
  };
}

export function toOpenCollectionYaml(detail: CollectionDetail): string {
  const bruno = normalizedToBrunoCollection(detail.collection);
  const oc = brunoToOpenCollection(bruno);
  oc.extensions = {
    ...(oc.extensions ?? {}),
    bruno: {
      ...(oc.extensions?.bruno ?? {}),
      exportedAt: new Date().toISOString(),
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
