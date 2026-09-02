import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BrunoCollectionConfig, BrunoDiscoveryConfig } from '../types';
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

/** Every discovery entry defaults to public GitHub, the only host with a
 *  self-defaulting integration entry. */
const DEFAULT_DISCOVERY_HOST = 'github.com';

/**
 * Reads the `bruno.discovery` block — the organizations swept for collections.
 * Returns [] if absent.
 *
 * Tolerant per entry, for the same reason `readBrunoCollections` is: this runs
 * inside a scheduled provider task, and one mistyped entry must not stop the
 * others from being swept.
 *
 * The `repositoryPattern` regex is COMPILED HERE rather than at match time, so
 * a bad pattern is reported once, against the entry that owns it, and that
 * entry alone is dropped. Compiling it in the sweep instead would either throw
 * out of a run that had already listed other organizations, or — worse — be
 * caught there and turned into "matches nothing", which in a `full` mutation
 * deletes every entity the entry had published.
 */
export function readBrunoDiscovery(
  config: Config,
  logger?: LoggerService
): BrunoDiscoveryConfig[] {
  const brunoConfig = config.getOptionalConfig('bruno');
  if (!brunoConfig) {
    return [];
  }

  const entries: BrunoDiscoveryConfig[] = [];
  const raw = brunoConfig.getOptionalConfigArray('discovery') ?? [];

  for (const [index, d] of raw.entries()) {
    try {
      const organization = d.getString('organization');
      const repositoryPattern = d.getOptionalString('repositoryPattern');
      const excludePathPattern = d.getOptionalString('excludePathPattern');
      for (const pattern of [repositoryPattern, excludePathPattern]) {
        if (pattern !== undefined) {
          // Anchored the same way `new RegExp` will anchor it in the sweep, so
          // a pattern that only fails when anchored fails here too.
          new RegExp(`^(?:${pattern})$`);
        }
      }
      entries.push({
        host: d.getOptionalString('host') ?? DEFAULT_DISCOVERY_HOST,
        organization,
        repositoryPattern,
        excludePathPattern,
        owner: d.getOptionalString('owner'),
        deferToCatalogInfo: d.getOptionalBoolean('deferToCatalogInfo') ?? true
      });
    } catch (e) {
      logger?.error(
        `bruno.discovery[${index}]: ${String((e as Error)?.message ?? e)}; `
        + 'skipping.'
      );
    }
  }

  return entries;
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
