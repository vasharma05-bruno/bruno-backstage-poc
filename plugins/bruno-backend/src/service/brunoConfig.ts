import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BrunoCollectionConfig } from '../types';
import type { DefinitionOptions } from './definitionBuilder';

/** 1 MiB. Admits every realistic collection — the largest real-world reference
 *  measured was ~600 KB — while bounding both the pathological case and the
 *  probe cache's memory. */
const DEFAULT_MAX_BYTES = 1048576;

/**
 * Reads the `bruno.collections` block from Backstage config. Returns [] if
 * absent.
 *
 * Its own module so the `kind: Bruno` spine depends on config reading alone.
 * It was split off the annotation-model collection loader — since deleted — to
 * keep the spine off a module that was already slated to go.
 *
 * Reading is tolerant per entry. A malformed entry is skipped and logged, never
 * thrown: this runs inside a scheduled provider task, and letting one bad entry
 * reject the read would leave every OTHER configured collection unpublished on
 * that tick and every tick after it.
 */
export function readBrunoCollections(
  config: Config,
  logger?: LoggerService
): BrunoCollectionConfig[] {
  const brunoConfig = config.getOptionalConfig('bruno');
  if (!brunoConfig) {
    return [];
  }

  const collections: BrunoCollectionConfig[] = [];
  const entries = brunoConfig.getOptionalConfigArray('collections') ?? [];

  for (const [index, c] of entries.entries()) {
    try {
      const type = c.getString('type');
      if (type !== 'url') {
        logger?.error(
          `bruno.collections[${index}]: unsupported type "${type}" `
          + '(only "url" is supported); skipping.'
        );
        continue;
      }
      collections.push({
        type: 'url',
        url: c.getString('url'),
        partOf: readPartOf(c.getOptional('partOf')),
        owner: c.getOptionalString('owner'),
        name: c.getOptionalString('name')
      });
    } catch (e) {
      logger?.error(
        `bruno.collections[${index}]: ${String((e as Error)?.message ?? e)}; `
        + 'skipping.'
      );
    }
  }

  return collections;
}

/**
 * Reads `bruno.definition`. Tolerant for the same reason the collections reader
 * is: this runs during module init, and a mistyped knob must degrade to the
 * defaults rather than take the whole backend down at boot.
 * `getOptionalNumber` throws on a value of the wrong TYPE, which is why the
 * read is guarded too.
 *
 * There is deliberately no redaction knob. The generated YAML mirrors Bruno's
 * own "Generate docs" output, whose only redaction is the converter withholding
 * secret environment-variable values — adding a Backstage-only mode would make
 * the two diverge for the same collection.
 */
export function readDefinitionOptions(
  config: Config,
  logger?: LoggerService
): DefinitionOptions {
  try {
    const definition = config
      .getOptionalConfig('bruno')
      ?.getOptionalConfig('definition');

    return {
      maxBytes: definition?.getOptionalNumber('maxBytes') ?? DEFAULT_MAX_BYTES
    };
  } catch (e) {
    logger?.error(
      `bruno.definition: ${String((e as Error)?.message ?? e)}; `
      + 'falling back to the defaults.'
    );
    return { maxBytes: DEFAULT_MAX_BYTES };
  }
}

/**
 * Reads `bruno.cacheTtlSeconds` as milliseconds. Undefined when unset, so the
 * probe keeps its own default rather than having one duplicated here.
 */
export function readCacheTtlMs(config: Config): number | undefined {
  try {
    const seconds = config
      .getOptionalConfig('bruno')
      ?.getOptionalNumber('cacheTtlSeconds');
    return seconds === undefined ? undefined : seconds * 1000;
  } catch {
    // Same reasoning as above: an unreadable value means "unset", which leaves
    // the probe on its own default rather than failing the backend's boot.
    return undefined;
  }
}

/**
 * The PRD writes `partOf` as a single reference; the entity contract is plural.
 * Both spellings are accepted, and `getOptionalStringArray` cannot do the job
 * alone because it throws on a bare string.
 */
function readPartOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value;
  }
  return [];
}
