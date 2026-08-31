/**
 * Turns a fetched collection tree into the OpenCollection YAML that gets stored
 * on a `kind: Bruno` entity's `spec.definition`.
 *
 * Its own module so `manifestProbe` stays about caching: parse, serialize, cap
 * and the "degrade, never throw" contract are all here, and nothing here knows
 * about caching, etags or entities. Dependency direction is one-way — it imports
 * the parser and the exporter, and nothing under `provider/` or `processor/`,
 * nor `collectionService` or `manifestProbe`, so there is no cycle.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BrunoSourceConfig } from '../types';
import { countRequests, parseCollection } from './collectionParser';
import {
  toOpenCollectionYaml,
  type RedactionMode
} from './openCollectionExport';

/** The outcome of one generation attempt. Never an exception — see below. */
export interface BuiltDefinition {
  /** The OpenCollection 1.0.0 YAML, or undefined when it could not be
   *  produced or exceeded the cap. */
  definition?: string;
  /** Byte length of what WOULD have been stored. 0 when generation failed. */
  bytes: number;
  /** Set only when `definition` is undefined. */
  omitted?: 'size' | 'error';
  /** Executable requests in the collection. Undefined only when the parse
   *  itself failed — notably it IS reported for an over-cap collection, whose
   *  definition is omitted but whose parse succeeded. */
  requestCount?: number;
  /** Environment names, in parse order. Same availability as `requestCount`. */
  environments?: string[];
}

/** The `bruno.definition` config block, resolved. */
export interface DefinitionOptions {
  maxBytes: number;
  redaction: RedactionMode;
}

/**
 * Generates the definition for one collection tree.
 *
 * NEVER throws and never rejects. It is called from a `CatalogProcessor`, where
 * an escaping error makes the processing run `ok: false`, which skips
 * `updateProcessedEntity` and leaves stitching to abandon the entity — on first
 * ingestion it would never appear in the catalog at all. A collection that
 * cannot be parsed must degrade to an entity without a definition, not to no
 * entity.
 *
 * Over the cap the definition is OMITTED, never truncated: a truncated YAML
 * document is invalid, so a renderer would fail with a parse error instead of
 * showing the caller why the content is missing. The caller stamps the reason
 * on the entity instead, and the `bytes` reported here is what makes that
 * annotation actionable.
 */
export function buildDefinition(input: {
  tree: Map<string, string>;
  /** Normalized collection URL — seeds the parser's fallback name/id. */
  url: string;
  /** Manifest name, when the probe found one. */
  name?: string;
  logger: LoggerService;
  options: DefinitionOptions;
}): BuiltDefinition {
  const { tree, url, name, logger, options } = input;
  try {
    // The parser is written against `bruno.sources` entries; this is the same
    // shape, synthesized. `name` is only a FALLBACK — a manifest inside the tree
    // overrides it, which is why the probe's manifest name can be passed here
    // without risking a mismatch with the parsed collection.
    const source: BrunoSourceConfig = {
      id: url,
      name: name ?? lastPathSegment(url),
      type: 'url',
      target: url
    };
    const normalized = parseCollection(source, { files: tree }, logger);
    const yaml = toOpenCollectionYaml(normalized, {
      // Stable across runs: no per-call timestamp, or the entity is rewritten
      // and re-stitched every 100-150s reprocess cycle (BE-P2 F11).
      exportedAt: null,
      redaction: options.redaction
    });

    // Derived from the same parse, so they cost nothing extra and are pure
    // functions of the content — stamping them cannot churn `resultHash`. They
    // are reported even when the definition is omitted for size, because the
    // dashboard's counts should not go blank just because a collection is large.
    const counts = {
      requestCount: countRequests(normalized.items),
      environments: normalized.environments.map((e) => e.name)
    };

    const bytes = Buffer.byteLength(yaml, 'utf8');
    if (bytes > options.maxBytes) {
      logger.warn(
        `Bruno collection ${url}: generated OpenCollection definition is `
        + `${bytes} bytes, over the ${options.maxBytes}-byte `
        + '`bruno.definition.maxBytes` cap; storing the entity without it.'
      );
      return { bytes, omitted: 'size', ...counts };
    }
    return { definition: yaml, bytes, ...counts };
  } catch (e) {
    logger.warn(
      `Bruno collection ${url}: could not generate the OpenCollection `
      + `definition: ${String((e as Error)?.message ?? e)}`
    );
    return { bytes: 0, omitted: 'error' };
  }
}

/** The URL's last non-empty path segment, the same display-name fallback the
 *  provider derives entity names from. */
function lastPathSegment(url: string): string {
  const segments = url.split('?')[0].split('#')[0].split('/');
  return segments.filter((s) => s !== '').pop() ?? url;
}
