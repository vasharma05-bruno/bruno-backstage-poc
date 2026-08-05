import type { LoggerService, SchedulerServiceTaskRunner } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { ApiEntity, EntityLink } from '@backstage/catalog-model';
import type {
  EntityProvider,
  EntityProviderConnection
} from '@backstage/plugin-catalog-node';
import type {
  CollectionService } from '../service/collectionService';
import {
  readBrunoSources
} from '../service/collectionService';
import type { BrunoSourceConfig } from '../types';

const LOCATION_TYPE = 'bruno-provider';

/**
 * A catalog entity provider that materializes each configured Bruno source as
 * a `kind: API` entity of `spec.type: bruno-collection`. The frontend card and
 * Collection Docs tab attach when `spec.type === 'bruno-collection'`.
 *
 * Entities carry annotations that link back to the collection so the frontend
 * can call `/api/bruno/collections/:id` and `/api/bruno/collections/:id/docs`.
 */
export class BrunoEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;

  constructor(
    private readonly options: {
      config: Config;
      logger: LoggerService;
      collectionService: CollectionService;
      taskRunner: SchedulerServiceTaskRunner;
    }
  ) {}

  getProviderName(): string {
    return 'bruno-entity-provider';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.options.taskRunner.run({
      id: this.getProviderName(),
      fn: async () => {
        await this.run();
      }
    });
  }

  /** Re-reads sources, refreshes the collection cache, and emits entities. */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('BrunoEntityProvider is not connected');
    }
    const { config, logger, collectionService } = this.options;

    // Keep the parsed collections in sync so requestCount / names are fresh.
    await collectionService.refresh();

    const sources = readBrunoSources(config);
    const entities = sources.map((source) =>
      this.buildEntity(source, collectionService)
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map((entity) => ({
        entity,
        locationKey: `${LOCATION_TYPE}:${this.getProviderName()}`
      }))
    });

    logger.info(
      `BrunoEntityProvider emitted ${entities.length} API entity(ies).`
    );
  }

  private buildEntity(
    source: BrunoSourceConfig,
    collectionService: CollectionService
  ): ApiEntity {
    const detail = collectionService.getCollection(source.id);
    const name = sanitizeName(source.id);
    const displayName = detail?.name ?? source.name;
    const requestCount = detail?.requestCount ?? 0;
    const locationRef = `${LOCATION_TYPE}:${this.getProviderName()}`;

    const annotations: Record<string, string> = {
      'backstage.io/managed-by-location': locationRef,
      'backstage.io/managed-by-origin-location': locationRef,
      'bruno.dev/collection-id': source.id,
      'bruno.dev/collection-path': source.target
    };
    const links: EntityLink[] = [];
    if (source.type === 'url') {
      annotations['bruno.dev/source-url'] = source.target;
      links.push({
        url: brunoDeepLink(source.target),
        title: 'Open in Bruno',
        icon: 'code'
      });
      links.push({
        url: source.target,
        title: 'Bruno collection (source)',
        icon: 'github'
      });
    }

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'API',
      metadata: {
        name,
        title: displayName,
        description: `Bruno collection "${displayName}" — ${requestCount} request${
          requestCount === 1 ? '' : 's'
        }.`,
        annotations,
        tags: ['bruno'],
        links
      },
      spec: {
        type: 'bruno-collection',
        lifecycle: 'experimental',
        owner: 'guests',
        // `definition` is required on an ApiEntity; we point at the docs route.
        definition: `See Bruno collection docs at /api/bruno/collections/${source.id}/docs`
      }
    };
  }
}

// Mirrors buildBrunoDeepLink in plugins/bruno/src/lib/brunoLink.ts — keep the
// format (scheme `bruno`, verb `open`, encoded `url` param) in sync.
function brunoDeepLink(sourceUrl: string): string {
  return `bruno://open?url=${encodeURIComponent(sourceUrl)}`;
}

/** Sanitizes a source id into a valid Backstage entity name. */
function sanitizeName(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || 'bruno-collection';
}
