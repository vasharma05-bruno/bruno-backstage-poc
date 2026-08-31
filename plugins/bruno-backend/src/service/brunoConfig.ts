import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BrunoCollectionConfig } from '../types';

/**
 * Reads the `bruno.collections` block from Backstage config. Returns [] if
 * absent.
 *
 * Deliberately its own module rather than a second export of
 * `collectionService`: the `kind: Bruno` spine must not acquire a dependency on
 * the annotation-model collection loader, which later phases delete wholesale.
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
