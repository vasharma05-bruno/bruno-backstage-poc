import type {
  LoggerService,
  SchedulerServiceTaskRunner
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type {
  EntityProvider,
  EntityProviderConnection
} from '@backstage/plugin-catalog-node';
import {
  BRUNO_API_VERSION,
  ORIGIN_ANNOTATION
} from '../processor/BrunoKindProcessor';
import type { BrunoOrigin } from '../processor/BrunoKindProcessor';
import { readBrunoCollections } from '../service/brunoConfig';
import { sanitizeName } from '../service/entityName';
import type { CollectionManifest, ManifestProbe } from '../service/manifestProbe';
import type { BrunoEntity } from '../types';
import type {
  StoredCollection,
  StoredCollectionReader
} from './storedCollections';

const LOCATION_TYPE = 'bruno-collection';

/**
 * Materializes every configured and every UI-created collection as a
 * `kind: Bruno` entity, so a collection can be catalogued without authoring a
 * `catalog-info.yaml`.
 *
 * Two mutable sources, one loop. `bruno.collections[]` is the operator's file;
 * the UI-created rows are read service-to-service from
 * `GET /api/bruno/collections`, because the catalog has no write model of its
 * own and this provider is what turns a stored row into an entity. They go
 * through identical guards and identical identity rules, which is what lets a
 * config/UI name collision be caught by machinery that already works.
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

  /**
   * The last stored list this PROCESS fetched successfully. Undefined until the
   * first success — see the skip branch in `run()` for why that matters.
   */
  private lastStored?: StoredCollection[];

  constructor(
    private readonly options: {
      config: Config;
      logger: LoggerService;
      probe: ManifestProbe;
      taskRunner: SchedulerServiceTaskRunner;
      /** Injected rather than constructed here, so this class stays a pure
       *  function of its inputs and the degrade branch in `run()` is reachable
       *  by handing it a reader that throws. */
      storedCollections: StoredCollectionReader;
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

  /**
   * Re-reads both sources, probes each manifest, and emits entities.
   *
   * Emission is a `full` mutation, which the catalog applies by SET DIFFERENCE:
   * anything this provider emitted before and does not emit now is deleted
   * (`DefaultProviderDatabase`'s `toRemove`). Every omission from the emitted
   * set is therefore a deletion, and the two kinds of omission are handled
   * differently on purpose:
   *
   *  - A FAILED READ OF THE STORE never deletes anything. With no successful
   *    read cached in this process, `run()` returns before `applyMutation` and
   *    skips the refresh entirely, because the alternative — emitting the
   *    configured entries alone — would drop every UI-created collection in the
   *    instance.
   *  - A PER-COLLECTION SKIP inside the loop below DOES remove that one
   *    collection's entity, and for a UI-created collection that is destructive
   *    in a way a configured one is not: the entity is the only handle the
   *    dashboard has on the stored row. So the no-manifest skip emits a
   *    metadata-less entity instead when the entry came from the UI, and the
   *    `normalize` skip is unreachable for one. The single case left is a name
   *    a `bruno.collections[]` entry claimed first, which cannot be resolved
   *    here — the operator's file legitimately wins — and surfaces in the
   *    dashboard's pending strip as a stalled row with a Remove control.
   */
  async run(): Promise<void> {
    if (!this.connection) {
      throw new Error('BrunoCollectionEntityProvider is not connected');
    }
    const { config, logger, probe } = this.options;

    let stored: StoredCollection[];
    try {
      stored = await this.options.storedCollections.list();
      this.lastStored = stored;
    } catch (error) {
      if (this.lastStored === undefined) {
        // Structured second argument, never string interpolation: the reader's
        // error can echo the request it made, and interpolating it into the
        // message would put the plugin bearer token in the log.
        logger.warn(
          'BrunoCollectionEntityProvider could not read the UI-created '
          + 'collections and has none cached from an earlier run in this '
          + 'process; SKIPPING this refresh entirely. Emitting now would apply '
          + 'a `full` mutation whose entity set is missing every UI-created '
          + 'collection, and a full mutation deletes by set difference — the '
          + 'catalog would drop them all.',
          error instanceof Error ? error : new Error(String(error))
        );
        // No applyMutation. Nothing is deleted. The cost is that CONFIGURED
        // collections are not refreshed on this tick either — a delay bounded
        // by `bruno.schedule.frequencySeconds`, in a failure case only, versus
        // destroying every collection a user created. This is also the tick
        // where the fetch is most likely to fail: the first one after a
        // restart, when the `bruno` plugin may not have finished initialising,
        // and `refresh_state_references` rows survive restarts.
        return;
      }
      logger.warn(
        'BrunoCollectionEntityProvider could not read the UI-created '
        + 'collections; emitting the last set this process read successfully.',
        error instanceof Error ? error : new Error(String(error))
      );
      stored = this.lastStored;
    }

    const entities: BrunoEntity[] = [];
    /**
     * Emitted entity name -> the URL that claimed it, and from where.
     *
     * KEYED ON THE LOWER-CASED NAME, for the reason spelled out on
     * `UiCollectionStore.getByName`: an entity ref is lower-cased when it is
     * stringified, so `Payments` and `payments` are one entity. Keyed on the raw
     * name this guard misses that collision entirely and both entries go into
     * the same `full` mutation under the same `locationKey` — the catalog then
     * resolves it by keeping whichever arrived first and dropping the other with
     * no message on this side at all. The value keeps the URL as written, and
     * the name as written is what reaches the entity and the log line below.
     */
    const claimed = new Map<string, { url: string; origin: SourceOrigin }>();
    let skipped = 0;
    let fromConfig = 0;
    let fromUi = 0;

    // CONFIG FIRST, deliberately. The `claimed` guard below is first-wins, and
    // the two sources are not equal: `app-config.yaml` is the operator's file
    // and cannot be edited from the UI, whereas a UI-created collection can be
    // renamed by whoever made it. So the UI one is the one that should lose,
    // and `POST /collections` pre-rejects the collision anyway so that it is
    // normally caught at write time with a message instead of here.
    const sources: SourceEntry[] = [
      ...readBrunoCollections(config, logger).map((entry) => ({
        url: entry.url,
        name: entry.name,
        partOf: entry.partOf,
        owner: entry.owner,
        origin: 'config' as const
      })),
      ...stored.map((row) => ({
        url: row.url,
        name: row.name,
        partOf: row.partOf,
        owner: row.owner,
        origin: 'ui' as const
      }))
    ];

    for (const entry of sources) {
      // Inside the loop's guarded region on purpose: `normalize` parses the
      // URL and throws on a scheme-less one, and a throw out here would reject
      // `run()` before `applyMutation`, leaving every other configured
      // collection unpublished on this tick and every tick after it.
      //
      // This skip is NOT a way to orphan a UI-created row, which is why it does
      // not branch on origin the way the no-manifest one below does: a stored
      // row's URL was put through this same `normalize` by `POST /collections`
      // before it was written, and `normalize` is idempotent, so a URL that
      // normalized once cannot throw here. Only a hand-edited
      // `app-config.yaml` reaches this branch.
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
        //
        // AND SKIPPING IT IS ONLY SAFE FOR A CONFIGURED ENTRY. A skip drops the
        // collection from a `full` mutation, which deletes its entity — and for
        // a UI-created collection the entity is the ONLY handle on the row that
        // produced it. The dashboard's Remove control is gated on the ENTITY's
        // `usebruno.com/origin: ui`, so deleting the entity is exactly what
        // makes its `bruno_ui_collections` row permanent: nothing in the
        // product can reach it afterwards, and the user is left with a
        // collection they can neither see nor remove. A configured entry has no
        // such problem — it is removed by editing `app-config.yaml`, so pruning
        // its entity strands nothing, and the skip is the right signal that the
        // operator's file points at a folder with no collection in it.
        if (entry.origin === 'config') {
          logger.error(
            `Bruno collection ${url}: no bruno.json or opencollection.yml/.yaml `
            + `found; skipping.`
          );
          skipped += 1;
          continue;
        }
        // Emitted anyway, without collection metadata, exactly as the
        // unreadable case above does and for a stronger version of the same
        // reason: a metadata-less entity is strictly better than a row nobody
        // can delete. The manifest was there when `POST /collections` validated
        // it, so this means it has since been moved or deleted in source
        // control, and removing the collection is the only sensible response —
        // which requires the entity to still exist.
        logger.error(
          `Bruno collection ${url}: no bruno.json or opencollection.yml/.yaml `
          + `found any more; emitting without collection metadata so it stays `
          + `removable from the Bruno dashboard.`
        );
      }

      const name = entry.name ?? collectionNameFromUrl(url);
      const claimKey = name.toLocaleLowerCase('en-US');
      const claimedBy = claimed.get(claimKey);
      if (claimedBy !== undefined) {
        // Which side is which matters to the advice: "set `name:` on one of the
        // two bruno.collections entries" is wrong when one of the two came from
        // the UI and there is no config entry to edit.
        logger.error(
          `Bruno collection ${url} (${describeOrigin(entry.origin)}): entity `
          + `name "${name}" is already used by ${claimedBy.url} `
          + `(${describeOrigin(claimedBy.origin)}); skipping. `
          + `${disambiguationAdvice(entry.origin, claimedBy.origin)}`
        );
        skipped += 1;
        continue;
      }
      claimed.set(claimKey, { url, origin: entry.origin });
      if (entry.origin === 'config') {
        fromConfig += 1;
      } else {
        fromUi += 1;
      }
      entities.push(
        buildEntity({
          name,
          url,
          partOf: entry.partOf,
          owner: entry.owner,
          manifest,
          origin: entry.origin
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
      + `entity(ies) (${fromConfig} from config, ${fromUi} from the UI), `
      + `skipped ${skipped}.`
    );
  }
}

/** Which mutable source an entry came from. A subset of `BrunoOrigin`: this
 *  provider is the only writer of the other two values. */
type SourceOrigin = 'config' | 'ui';

/** One collection to emit, from either source, before any guard has run. */
type SourceEntry = {
  url: string;
  name?: string;
  partOf: string[];
  owner?: string;
  origin: SourceOrigin;
};

function describeOrigin(origin: SourceOrigin): string {
  return origin === 'config' ? 'app-config.yaml' : 'added from the Bruno UI';
}

/** What the operator actually has to change to break a name collision. */
function disambiguationAdvice(
  losing: SourceOrigin,
  winning: SourceOrigin
): string {
  if (losing === 'ui' && winning === 'config') {
    return (
      'Remove the collection from the Bruno dashboard and add it again under a '
      + 'different name, or set `name:` on the bruno.collections entry.'
    );
  }
  if (losing === 'config' && winning === 'ui') {
    return 'Set `name:` on the bruno.collections entry to disambiguate.';
  }
  if (losing === 'ui') {
    return 'Remove one of the two collections from the Bruno dashboard.';
  }
  return (
    'Set `name:` on one of the two bruno.collections entries to disambiguate.'
  );
}

function buildEntity(input: {
  name: string;
  url: string;
  partOf: string[];
  owner?: string;
  manifest?: CollectionManifest;
  origin: BrunoOrigin;
}): BrunoEntity {
  const { name, url, partOf, owner, manifest, origin } = input;
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
        'backstage.io/source-location': `${location}/`,
        // The one fact only this provider knows, and now it carries two.
        // `managed-by-location` is the collection FOLDER here, not a
        // descriptor, and nothing downstream can tell that apart from a
        // descriptor URL without guessing at the file extension — so the
        // annotation says so. It also says WHICH of the two mutable sources the
        // entity came from, which nothing downstream can recover at all: a
        // configured collection and a UI-created one produce byte-identical
        // entities otherwise, and the UI has to know the difference to decide
        // whether it may offer to delete one.
        //
        // Stamped on the unprocessed entity, and `BrunoKindProcessor`'s
        // `deriveOrigin` returns a declared origin unchanged, which is what
        // makes `ui` survive every reprocess cycle rather than being rewritten
        // to `descriptor` a cycle after it appears.
        [ORIGIN_ANNOTATION]: origin
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

/**
 * The entity name a collection URL yields when no explicit name is set.
 *
 * Exported so `POST /collections` rejects a config collision with a clear
 * message instead of leaving the `claimed` guard above to skip it silently. A
 * create that stores a row and then never produces an entity is the worst
 * outcome available, and the only way to rule it out at write time is for the
 * route to derive the name by the same rule this provider will.
 */
export function collectionNameFromUrl(normalizedUrl: string): string {
  return sanitizeName(lastPathSegment(normalizedUrl));
}

/** The last non-empty path segment of a URL — the collection folder name. */
function lastPathSegment(url: string): string {
  const segments = url
    .split(/[?#]/)[0]
    .split('/')
    .filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
