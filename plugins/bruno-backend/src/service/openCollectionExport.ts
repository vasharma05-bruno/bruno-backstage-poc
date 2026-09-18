/**
 * Adapter + serializer producing an OpenCollection `1.0.0` YAML string from a
 * parsed `NormalizedCollection`.
 *
 * `@usebruno/converters`' `brunoToOpenCollection` consumes Bruno's in-memory
 * `BrunoCollection` (nested auth/body blocks, `'http-request'`/`'graphql-request'`
 * item types), NOT our flat `NormalizedCollection`. This module reshapes the
 * latter into a minimal `BrunoCollectionLike` and hands it to the converter.
 *
 * REDACTION IS THE CONVERTER'S, NOT OURS. This pipeline deliberately mirrors
 * Bruno's own "Generate docs" — the desktop app's
 * `transformCollectionToSaveToExportAsFile` -> `brunoToOpenCollection` ->
 * `js-yaml.dump`, and the CLI's `bruno docs generate` — so that a collection
 * documented from Backstage and the same collection documented from Bruno
 * produce the same document. That pipeline redacts in exactly ONE place:
 * `toOpenCollectionEnvironments` omits the value of an environment variable
 * flagged `secret` and emits `secret: true` instead
 * (bruno-converters `opencollection/environment.ts`).
 *
 * Everything else is exported verbatim, and that is the deliberate, requested
 * behaviour rather than an oversight: auth passwords/tokens/clientSecrets
 * (there is no redaction whatsoever in the converter's auth mapping), header
 * and query/param values, request bodies, scripts and tests. An earlier
 * revision of this file redacted those with a hand-rolled name-matching pass;
 * it was removed because it made Backstage's output silently diverge from
 * Bruno's for the same collection.
 *
 * The consequence, stated plainly: the same YAML is stored on a `kind: Bruno`
 * catalog entity, where the audience is "anything that can read the catalog"
 * and not just one signed-in user entitled to that one collection. A credential
 * hardcoded in a `.bru` file — rather than referenced as `{{var}}` or held in a
 * secret environment variable — reaches the catalog in plaintext. Keeping
 * secrets in secret env vars is what keeps them out of the docs, in Bruno and
 * here alike.
 *
 * Divergences (R-A): the output is faithful-for-docs but NOT byte-identical to
 * Bruno's native exporter — collection/folder request-defaults, settings,
 * examples, tags and full `brunoConfig` are absent from our source model.
 * Assertions are omitted (R-C).
 */
import type {
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

/** Options for {@link toOpenCollectionYaml}. */
export interface OpenCollectionExportOptions {
  /** ISO timestamp for `extensions.bruno.exportedAt`. OMITTED unless a caller
   *  asks for it, which is the safe default rather than the convenient one:
   *  this document is stored on a `kind: Bruno` entity's `spec.definition`, and
   *  the catalog decides whether to write the entity by hashing the processed
   *  result. A stamp that moves on every call makes that hash miss every time,
   *  so every Bruno entity in every adopter's catalog is rewritten and
   *  re-stitched every reprocess cycle, forever and invisibly (R8).
   *
   *  It defaulted ON when a one-off export route passed it deliberately; that
   *  route went with the connection-store backend, leaving a default aimed
   *  squarely at the catalog that a future caller could re-arm by forgetting a
   *  parameter. A caller that genuinely wants to record when an export was
   *  taken now says so. */
  exportedAt?: string;
}

interface BrunoCollectionLike {
  name: string;
  brunoConfig?: { version?: string };
  environments?: unknown[];
  items?: unknown[];
  root?: { docs?: string };
}

/**
 * Passes environment variables through as Bruno's own exporter does: the
 * converter's `toOpenCollectionEnvironments` withholds the value of a variable
 * flagged `secret` and writes `secret: true` in its place, and emits the value
 * for every other variable. That single behaviour IS the redaction contract of
 * Bruno's "Generate docs"; this function must not add to it or the two outputs
 * diverge for the same collection.
 */
function mapEnv(env: Environment): unknown {
  return {
    name: env.name,
    variables: env.variables.map((v) => ({
      name: v.name,
      value: v.value,
      enabled: v.enabled,
      ...(v.secret === true && { secret: true })
    }))
  };
}

function mapBody(body: RequestBody | undefined): unknown {
  if (!body) {
    return { mode: 'none' };
  }
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: body.mode, [body.mode]: body.raw ?? '' };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: { query: body.raw ?? '' }
      };
    case 'formUrlEncoded':
      return {
        mode: 'formUrlEncoded',
        formUrlEncoded: body.form ?? []
      };
    case 'multipartForm':
      return {
        mode: 'multipartForm',
        multipartForm: (body.form ?? []).map((f) => ({ ...f, type: 'text' }))
      };
    default:
      return { mode: 'none' };
  }
}

/**
 * Emits auth blocks exactly as Bruno's exporter does — values included. The
 * converter's auth mapping performs no redaction of its own, so anything
 * stripped here would be a Backstage-only divergence from the document Bruno
 * generates for the same collection.
 */
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
        basic: {
          username: String(auth.username ?? ''),
          password: String(auth.password ?? '')
        }
      };
    case 'bearer':
      return { mode: 'bearer', bearer: { token: String(auth.token ?? '') } };
    case 'digest':
      return {
        mode: 'digest',
        digest: {
          username: String(auth.username ?? ''),
          password: String(auth.password ?? '')
        }
      };
    case 'apikey':
      return {
        mode: 'apikey',
        apikey: {
          key: String(auth.key ?? ''),
          value: String(auth.value ?? ''),
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

/**
 * Serializes a {@link NormalizedCollection} as an OpenCollection `1.0.0` YAML
 * document.
 *
 * A pure function of the collection: the same input yields byte-identical
 * output, on any run and any host. That is a load-bearing property rather than
 * a nicety — the result is stored on a `kind: Bruno` entity, and the catalog
 * skips the write only while the bytes are unchanged. The one thing that could
 * move on its own is {@link OpenCollectionExportOptions.exportedAt}, which is
 * why it is opt-in.
 *
 * @public
 */
export function toOpenCollectionYaml(
  collection: NormalizedCollection,
  options?: OpenCollectionExportOptions
): string {
  const bruno = normalizedToBrunoCollection(collection);
  const oc = brunoToOpenCollection(bruno);
  oc.extensions = {
    ...(oc.extensions ?? {}),
    bruno: {
      ...(oc.extensions?.bruno ?? {}),
      // Spread away entirely rather than written as `undefined`: js-yaml would
      // still emit the key.
      ...(options?.exportedAt !== undefined && {
        exportedAt: options.exportedAt
      }),
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
