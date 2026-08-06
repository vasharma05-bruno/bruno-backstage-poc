import type {
  AuthService,
  DiscoveryService,
  LoggerService
} from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type {
  CatalogProcessor,
  CatalogProcessorCache,
  CatalogProcessorEmit,
  LocationSpec
} from '@backstage/plugin-catalog-node';

const DEFAULT_CACHE_TTL_MS = 30_000;

interface BrunoLink {
  entityRef: string;
  collectionId: string;
  githubUrl: string;
}

/**
 * A catalog processor that injects Bruno annotations onto externally-owned
 * `kind: API` entities. It reads the connection links from the Bruno backend
 * over service-to-service HTTP (`GET /connections`) and, for entities not
 * already carrying a `bruno.dev/collection-path`, spread-merges the collection
 * annotations so the frontend card and stock Links card attach.
 *
 * Links are cached whole-list with a short TTL; fetch failures are logged and
 * never surface out of {@link preProcessEntity}.
 */
export class BrunoLinkProcessor implements CatalogProcessor {
  private cache?: { map: Map<string, BrunoLink>; expiresAt: number };

  constructor(
    private readonly options: {
      discovery: DiscoveryService;
      auth: AuthService;
      logger: LoggerService;
      cacheTtlMs?: number;
    }
  ) {}

  getProcessorName(): string {
    return 'BrunoLinkProcessor';
  }

  async preProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
    _originLocation: LocationSpec,
    _cache: CatalogProcessorCache
  ): Promise<Entity> {
    if (entity.kind.toLowerCase() !== 'api') {
      return entity;
    }
    // Skip provider-materialized entities and any prior injection.
    if (entity.metadata.annotations?.['bruno.dev/collection-path']) {
      return entity;
    }

    const ref = stringifyEntityRef(entity);
    const map = await this.getLinks();
    const link = map.get(ref);
    if (!link) {
      return entity;
    }

    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: {
          ...entity.metadata.annotations,
          'bruno.dev/collection-path': link.githubUrl,
          'bruno.dev/source-url': link.githubUrl,
          'bruno.dev/collection-id': link.collectionId
        }
      }
    };
  }

  /** Returns the whole-list link map, refreshing it when the TTL has lapsed. */
  private async getLinks(): Promise<Map<string, BrunoLink>> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.map;
    }

    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    try {
      const rows = await this.fetchAllLinks();
      const map = new Map<string, BrunoLink>();
      for (const row of rows) {
        map.set(row.entityRef, row);
      }
      this.cache = { map, expiresAt: now + ttl };
      return map;
    } catch (error) {
      // Structured error arg (never string-interpolate) so a caught auth/fetch
      // error can't smuggle the bearer token into the logs.
      this.options.logger.warn(
        'BrunoLinkProcessor failed to fetch links',
        error instanceof Error ? error : new Error(String(error))
      );
      // Serve the last-known map (stale) or an empty one; never throw.
      return this.cache?.map ?? new Map<string, BrunoLink>();
    }
  }

  /** Reads all connection links from the Bruno backend (service-to-service). */
  private async fetchAllLinks(): Promise<BrunoLink[]> {
    const baseUrl = await this.options.discovery.getBaseUrl('bruno');
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: 'bruno'
    });
    const res = await fetch(`${baseUrl}/connections`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(
        `GET /connections failed with ${res.status} ${res.statusText}`
      );
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error('GET /connections returned a non-array body');
    }
    return body as BrunoLink[];
  }
}
