import type {
  LoggerService,
  SchedulerServiceTaskRunner
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type {
  EntityProvider,
  EntityProviderConnection
} from '@backstage/plugin-catalog-node';
import { BRUNO_API_VERSION } from '../processor/BrunoKindProcessor';
import { readBrunoCollections } from '../service/brunoConfig';
import { sanitizeName } from '../service/collectionService';
import type { CollectionManifest, ManifestProbe } from '../service/manifestProbe';
import type { BrunoEntity } from '../types';

const LOCATION_TYPE = 'bruno-collection';

/**
 * Materializes each `bruno.collections[]` entry as a `kind: Bruno` entity, so a
 * collection can be catalogued without authoring a `catalog-info.yaml`.
 *
 * The entities are written unprocessed and then flow through the same
 * processing loop as authored ones, so `BrunoKindProcessor` enriches and
 * relates both identically. Only *identity* differs: `metadata.name` cannot be
 * supplied by a processor (the catalog freezes the entity ref before any
 * processor runs), so it is derived here from the URL's last path segment.
 *
 * The location annotation is a real `url:` ref rather than a synthetic
 * `bruno-provider:` one. That is what makes the About card's native Refresh
 * button appear, and it is safe because `readLocation` only dereferences
 * `kind: Location` entities — the URL is never fetched as a catalog descriptor.
 * Orphan detection is unaffected: provider entities are anchored by
 * `refresh_state_references` rows keyed off the `locationKey` below.
 */
export class BrunoCollectionEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;

  constructor(
    private readonly options: {
      config: Config;
      logger: LoggerService;
      probe: ManifestProbe;
      taskRunner: SchedulerServiceTaskRunner;
    }
  ) {}

  getProviderName(): string {
    return 'bruno-collection-provider';
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

  /** Re-reads `bruno.collections[]`, probes each manifest, and emits entities. */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('BrunoCollectionEntityProvider is not connected');
    }
    const { config, logger, probe } = this.options;

    const entities: BrunoEntity[] = [];
    /** Emitted entity name -> the URL that claimed it. */
    const claimed = new Map<string, string>();
    let skipped = 0;

    for (const entry of readBrunoCollections(config, logger)) {
      // Inside the loop's guarded region on purpose: `normalize` parses the
      // URL and throws on a scheme-less one, and a throw out here would reject
      // `run()` before `applyMutation`, leaving every other configured
      // collection unpublished on this tick and every tick after it.
      let url: string;
      try {
        url = probe.normalize(entry.url);
      } catch (e) {
        logger.error(
          `Bruno collection "${entry.url}": not a usable URL: ${
            String((e as Error)?.message ?? e)
          }; skipping.`
        );
        skipped += 1;
        continue;
      }

      let manifest: CollectionManifest | undefined;
      let unreadable = false;
      try {
        manifest = await probe.probe(entry.url);
      } catch (e) {
        // Emitted anyway: this is a `full` mutation, so dropping the entity on
        // a transient read failure would delete an already-published entity.
        logger.error(
          `Bruno collection ${url}: could not read it: ${
            String((e as Error)?.message ?? e)
          }; emitting without collection metadata.`
        );
        unreadable = true;
      }

      if (!unreadable && !manifest) {
        // Authoritative: an unreachable URL surfaces as a throw above, so
        // `undefined` really does mean "read fine, no manifest there".
        logger.error(
          `Bruno collection ${url}: no bruno.json or opencollection.yml/.yaml `
          + `found; skipping.`
        );
        skipped += 1;
        continue;
      }

      const name = entry.name ?? sanitizeName(lastPathSegment(url));
      const claimedBy = claimed.get(name);
      if (claimedBy !== undefined) {
        logger.error(
          `Bruno collection ${url}: entity name "${name}" is already used by `
          + `${claimedBy}; skipping. Set \`name:\` on one of the two `
          + `bruno.collections entries to disambiguate.`
        );
        skipped += 1;
        continue;
      }
      claimed.set(name, url);
      entities.push(
        buildEntity({
          name,
          url,
          partOf: entry.partOf,
          owner: entry.owner,
          manifest
        })
      );
    }

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map((entity) => ({
        entity,
        locationKey: `${LOCATION_TYPE}:${this.getProviderName()}`
      }))
    });

    logger.info(
      `BrunoCollectionEntityProvider emitted ${entities.length} Bruno `
      + `entity(ies), skipped ${skipped}.`
    );
  }
}

function buildEntity(input: {
  name: string;
  url: string;
  partOf: string[];
  owner?: string;
  manifest?: CollectionManifest;
}): BrunoEntity {
  const { name, url, partOf, owner, manifest } = input;
  const location = `url:${url}`;

  return {
    apiVersion: BRUNO_API_VERSION,
    kind: 'Bruno',
    metadata: {
      name,
      ...(manifest?.name && { title: manifest.name }),
      ...(manifest?.description && { description: manifest.description }),
      ...(manifest?.version && { version: manifest.version }),
      tags: ['bruno'],
      annotations: {
        'backstage.io/managed-by-location': location,
        'backstage.io/managed-by-origin-location': location,
        'backstage.io/source-location': `${location}/`
      }
    },
    spec: {
      type: 'bruno-collection',
      url,
      ...(owner && { owner }),
      ...(partOf.length > 0 && { partOf })
    }
  };
}

/** The last non-empty path segment of a URL — the collection folder name. */
function lastPathSegment(url: string): string {
  const segments = url
    .split(/[?#]/)[0]
    .split('/')
    .filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
