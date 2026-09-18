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
import type {
  CollectionDiscovery,
  DiscoveredCollection,
  SweepReport
} from '../discovery';
import type { SweepReportPublisher } from './sweepReportPublisher';
import { readBrunoCollections } from '../service/brunoConfig';
import { sanitizeName } from '../service/entityName';
import type { ManifestProbe } from '../service/manifestProbe';
import type { BrunoEntity } from '../types';
import type {
  StoredCollection,
  StoredCollectionReader
} from './storedCollections';

const LOCATION_TYPE = 'bruno-collection';

/**
 * Materializes every configured, every UI-created and every DISCOVERED
 * collection as a `kind: Bruno` entity, so a collection can be catalogued
 * without authoring a `catalog-info.yaml`.
 *
 * Three mutable sources, one loop. `bruno.collections[]` is the operator's
 * file; the UI-created rows are read service-to-service from
 * `GET /api/bruno/collections`, because the catalog has no write model of its
 * own and this provider is what turns a stored row into an entity; the
 * discovered ones are swept out of the organizations named by
 * `bruno.discovery[]` (see `discovery/githubDiscovery.ts`, which also explains
 * why Backstage's own catalog-info autodiscovery cannot carry them). All three
 * go through identical guards and identical identity rules, which is what lets
 * a cross-source name collision be caught by machinery that already works.
 *
 * The entities are written unprocessed and then flow through the same
 * processing loop as authored ones, so `BrunoKindProcessor` enriches and
 * relates both identically. Only *identity* differs: `metadata.name` cannot be
 * supplied by a processor (the catalog freezes the entity ref before any
 * processor runs), so it is derived here from the URL's last path segment.
 *
 * THE EMISSION LOOP READS NOTHING. The only SCM traffic this provider causes is
 * the discovery sweep above it, which is a repository listing per configured
 * organization rather than a read per collection.
 *
 * The loop used to probe every collection on every tick to stamp
 * `title`/`description`/`version` on the unprocessed entity — pure duplication:
 * the processor re-derives those same three fields from the same probe a moment
 * later, and its `keep(authored) ?? fetched` precedence means the value it lands
 * is identical either way. With a 60s tick against a 60s cache TTL every tick
 * was a guaranteed cache miss, so the loop alone accounted for roughly two
 * thirds of the plugin's steady-state Git traffic, spent to compute values that
 * were already being computed. What that removed was the FETCHED title: the
 * AUTHORED one a UI-created row now carries is stamped here, reads nothing, and
 * is the `keep(authored)` side of the same precedence rule. `probe` survives here for `normalize`, which is
 * pure URL parsing and touches no network. What the removal gave up is spelled
 * out on `run()`.
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

  /** The last successful sweep in THIS process, for the same reason — a failed
   *  sweep must not be mistaken for "these collections are gone". */
  private lastDiscovered?: DiscoveredCollection[];

  constructor(
    private readonly options: {
      config: Config;
      logger: LoggerService;
      /** Narrowed to `normalize` on purpose: this provider derives entity
       *  identity from a URL and must not read the SCM host to do it. Widening
       *  this back to the full `ManifestProbe` is how the duplicated per-tick
       *  tree read would come back. */
      probe: Pick<ManifestProbe, 'normalize'>;
      taskRunner: SchedulerServiceTaskRunner;
      /** Injected rather than constructed here, so this class stays a pure
       *  function of its inputs and the degrade branch in `run()` is reachable
       *  by handing it a reader that throws. */
      storedCollections: StoredCollectionReader;
      /** Absent when `bruno.discovery[]` is empty, which is the only way to
       *  turn discovery off — an always-present sweep with no entries would
       *  still cost a listing per tick. */
      discovery?: CollectionDiscovery;
      /**
       * Where the sweep report goes so a browser can read it. Absent exactly
       * when `discovery` is — with no sweep there is nothing to publish, and an
       * empty report published anyway would tell the dashboard that discovery
       * ran and found nothing wrong.
       */
      sweepReports?: SweepReportPublisher;
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
   * Re-reads all three sources and emits one entity per collection. Only the
   * sweep touches the SCM host; the loop itself reads nothing.
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
   *  - A FAILED SWEEP behaves identically, and for the same reason: emitting
   *    the other two sources alone would delete every discovered entity in the
   *    instance.
   *  - A PER-COLLECTION SKIP inside the loop below DOES remove that one
   *    collection's entity, and for a UI-created collection that is destructive
   *    in a way a configured one is not: the entity is the only handle the
   *    dashboard has on the stored row. Only two skips remain, and neither can
   *    strand one: `normalize` is unreachable for a stored row (its URL went
   *    through the same idempotent `normalize` at `POST /collections`), and a
   *    name collision surfaces in the dashboard's pending strip as a stalled row
   *    with a Remove control. The URL dedupe is a third omission but drops only
   *    DISCOVERED entries, which strand nothing — the next sweep re-derives them.
   *
   * WHAT THE PROBE REMOVAL GAVE UP, stated plainly because it is a real change.
   * The loop used to prune an entry whose folder held NO
   * bruno.json/opencollection manifest; both remaining cases now land as a
   * degraded entity instead:
   *
   *  - A `bruno.collections[]` entry pointing at the wrong folder.
   *    `BrunoKindProcessor` logs the same diagnostic on its own probe, so the
   *    operator is still told, and they additionally get a visible entity —
   *    a louder signal than an absence, and exactly what an authored
   *    `catalog-info.yaml` with the same mistake has always produced.
   *  - A DISCOVERED collection whose manifest moved between the sweep and the
   *    emit. Self-healing and needs no prune: the sweep only ever proposes a
   *    root it found a manifest in, so the next tick stops proposing it and the
   *    `full` mutation drops the entity by set difference.
   *
   * Restoring the prune means restoring a tree read per collection per tick —
   * not worth it for a config typo or a one-tick race.
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

    // Same contract, same failure handling. `discover()` is specified to throw
    // rather than return a short list, so this catch is the only place that
    // decides what an unknown sweep means — and it never means "delete".
    let discovered: DiscoveredCollection[] = [];
    /** The report of the sweep that just ran, absent when it did not run or
     *  threw — which is what keeps a failed sweep from overwriting the last
     *  report with one that says nothing is wrong. */
    let sweep: SweepReport | undefined;
    if (this.options.discovery) {
      try {
        sweep = await this.options.discovery.discover();
        discovered = sweep.collections;
        this.lastDiscovered = discovered;
      } catch (error) {
        if (this.lastDiscovered === undefined) {
          logger.warn(
            'BrunoCollectionEntityProvider could not sweep the bruno.discovery '
            + 'organizations and has no successful sweep cached from an earlier '
            + 'run in this process; SKIPPING this refresh entirely, for the '
            + 'same reason as a failed store read: a full mutation deletes by '
            + 'set difference, so emitting now would drop every discovered '
            + 'collection.',
            error instanceof Error ? error : new Error(String(error))
          );
          return;
        }
        logger.warn(
          'BrunoCollectionEntityProvider could not sweep the bruno.discovery '
          + 'organizations; emitting the last set this process swept '
          + 'successfully.',
          error instanceof Error ? error : new Error(String(error))
        );
        discovered = this.lastDiscovered;
      }
    }

    // OUTSIDE the try above, deliberately. A publish failure is not a sweep
    // failure, and catching it there would fall back to the last known
    // collections — or skip the whole tick — over a diagnostic that nothing in
    // the catalog depends on.
    if (sweep) {
      await this.publishSweep(sweep);
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
    /**
     * Normalized URL -> the entity name that claimed it.
     *
     * Only DISCOVERED entries are dropped on a hit here. A sweep cannot see the
     * other two sources, so the same collection being configured (or added from
     * the UI) and also discovered is the normal case, not a conflict: without
     * this it would land twice, under two names, and the operator's chosen name
     * would be shadowed by a repo-derived one. Two `bruno.collections[]` entries
     * pointing at one URL under different names stay legal — that is somebody
     * deliberately cataloguing a collection twice.
     */
    const claimedUrls = new Map<string, string>();
    let skipped = 0;
    let deduped = 0;
    let fromConfig = 0;
    let fromUi = 0;
    let fromDiscovery = 0;

    // CONFIG FIRST, deliberately. The `claimed` guard below is first-wins, and
    // the sources are not equal: `app-config.yaml` is the operator's file
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
        // The ONLY source that carries one. A configured entry has no `title:`
        // key and a sweep has nothing to read one from, so for those two the
        // manifest is the only answer and the processor is the only thing that
        // can supply it.
        title: row.title,
        partOf: row.partOf,
        owner: row.owner,
        origin: 'ui' as const
      })),
      // LAST, deliberately. The `claimed` and `claimedUrls` guards below are
      // both first-wins, and a discovered entry is the one that should lose
      // every contest: it is re-derived from source control on every tick, so
      // dropping it strands nothing and it reappears by itself once whatever
      // shadowed it is gone. A UI-created row cannot say that — its entity is
      // the only handle the dashboard has on it.
      ...discovered.map((collection) => ({
        url: collection.url,
        name: collection.name,
        partOf: [] as string[],
        owner: collection.owner,
        origin: 'discovery' as const
      }))
    ];

    for (const entry of sources) {
      // Inside the loop's guarded region on purpose: `normalize` parses the
      // URL and throws on a scheme-less one, and a throw out here would reject
      // `run()` before `applyMutation`, leaving every other configured
      // collection unpublished on this tick and every tick after it.
      //
      // This skip is NOT a way to orphan a UI-created row, which is why it
      // needs no branch on origin: a stored row's URL was put through this same
      // `normalize` by `POST /collections` before it was written, and
      // `normalize` is idempotent, so a URL that normalized once cannot throw
      // here. Only a hand-edited `app-config.yaml` reaches this branch.
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

      // Not about the probe any more, and worth restating since it used to be:
      // this guard predates the probe's removal, where its job was to keep a
      // collection that is both configured and discovered from costing two tree
      // reads. The provider reads nothing now, so what it prevents is the
      // EMISSION of a second entity for one URL under a repo-derived name that
      // would shadow the operator's chosen one.
      const claimedUrlBy = claimedUrls.get(url);
      if (entry.origin === 'discovery' && claimedUrlBy !== undefined) {
        logger.debug(
          `Bruno collection ${url}: discovered, but already catalogued as `
          + `"${claimedUrlBy}"; not emitting it a second time.`
        );
        deduped += 1;
        continue;
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
      claimedUrls.set(url, name);
      if (entry.origin === 'config') {
        fromConfig += 1;
      } else if (entry.origin === 'ui') {
        fromUi += 1;
      } else {
        fromDiscovery += 1;
      }
      entities.push(
        buildEntity({
          name,
          title: entry.title,
          url,
          partOf: entry.partOf,
          owner: entry.owner,
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
      + `entity(ies) (${fromConfig} from config, ${fromUi} from the UI, `
      + `${fromDiscovery} discovered), skipped ${skipped}.`
      // Only when it happened: with discovery off it is always zero, and a
      // line that runs every tick has to stay readable.
      + (deduped > 0
        ? ` Dropped ${deduped} discovered duplicate(s) of a collection that is `
        + `already catalogued from another source.`
        : '')
    );
  }

  /**
   * Hands the completed sweep to the `bruno` plugin, where a browser can read
   * it back.
   *
   * WHY THIS IS NOT AN ANNOTATION, since the catalog is right there. Two
   * reasons, and the second is the decisive one. Catalog processing stamps
   * annotations a cycle late, which this repository has a standing rule against
   * relying on — but more than that, an incomplete listing is a property of a
   * REPOSITORY, and the collections it cost do not exist as entities. There is
   * nothing to annotate. Annotating the ones that WERE found would mark exactly
   * the wrong thing.
   *
   * EVERY TICK, not only when the report changes. A truncated repository stays
   * truncated for weeks, so almost every publish rewrites the same row — and
   * that is the point: the row's `sweptAt` is what separates "swept a moment
   * ago, nothing is wrong" from "no sweep has ever been recorded", and a
   * publish that skipped the unchanged case would let the first decay into
   * looking like the second. One small write per
   * `bruno.schedule.frequencySeconds` is nothing beside the full catalog
   * mutation this same tick applies.
   *
   * Never throws. The report is a diagnostic about the entities, not the
   * entities, so a plugin that is still starting up or briefly unreachable
   * costs one stale report and nothing else.
   */
  private async publishSweep(report: SweepReport): Promise<void> {
    if (!this.options.sweepReports) {
      return;
    }
    try {
      await this.options.sweepReports.publish(report);
    } catch (error) {
      // Structured second argument, never interpolation: the publisher's error
      // can echo the request it made, and that request carries a plugin token.
      this.options.logger.warn(
        'BrunoCollectionEntityProvider swept the bruno.discovery organizations '
        + 'but could not record the report; the Bruno dashboard will show the '
        + 'previous one, or none, until a later tick succeeds. The sweep itself '
        + 'is unaffected and its collections have been emitted.',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

/** Which mutable source an entry came from. A subset of `BrunoOrigin`: this
 *  provider is the only writer of these three, and neither of the other two. */
type SourceOrigin = 'config' | 'ui' | 'discovery';

/** One collection to emit, from any of the sources, before any guard has run. */
type SourceEntry = {
  url: string;
  name?: string;
  /** An authored `metadata.title`. Only a UI-created row has one. */
  title?: string;
  partOf: string[];
  owner?: string;
  origin: SourceOrigin;
};

function describeOrigin(origin: SourceOrigin): string {
  if (origin === 'config') {
    return 'app-config.yaml';
  }
  return origin === 'ui'
    ? 'added from the Bruno UI'
    : 'discovered by bruno.discovery';
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
  // Discovery is swept LAST, so it always loses; there is no `winning ===
  // 'discovery'` case to advise on.
  if (losing === 'discovery' && winning === 'discovery') {
    return (
      'Both names were derived from `<repo>[-<path>]`, so they collided after '
      + 'the 63-character clamp: rename one of the collection folders, or '
      + 'exclude one of them with `repositoryPattern`/`excludePathPattern`.'
    );
  }
  if (losing === 'discovery') {
    // A discovered name cannot be overridden, so the only levers are the
    // losing side's pattern and the winning side's name.
    return (
      'A discovered collection has no name override: exclude it with '
      + '`repositoryPattern`/`excludePathPattern` on the bruno.discovery '
      + 'entry, or rename the collection that claimed the name first.'
    );
  }
  if (losing === 'ui') {
    return 'Remove one of the two collections from the Bruno dashboard.';
  }
  return (
    'Set `name:` on one of the two bruno.collections entries to disambiguate.'
  );
}

/**
 * The unprocessed entity for one collection — identity, provenance and the
 * operator's own fields, and nothing that would require reading the SCM host.
 *
 * `description` and `version` are deliberately ABSENT: they come from the
 * collection manifest, and `BrunoKindProcessor` fills both in from its own
 * probe on the first processing run. Stamping them here as well meant a
 * duplicate tree read per collection per tick for a value the processor was
 * computing regardless. The visible cost is that a newly emitted collection
 * shows its `metadata.name` until that first run, which follows emission within
 * seconds.
 *
 * `title` is the exception, and costs NO read: it is not fetched but AUTHORED,
 * carried on the stored row by whoever added the collection from the dashboard,
 * so it is the operator's own field in exactly the way `owner` and `partOf`
 * are. The probe removal that took `description` and `version` out of here does
 * not apply to it. When the row has none the key is omitted, which leaves the
 * processor's `keep(authored) ?? manifest.name` to derive it — the same
 * arrangement an authored `catalog-info.yaml` with no `title:` gets.
 */
function buildEntity(input: {
  name: string;
  title?: string;
  url: string;
  partOf: string[];
  owner?: string;
  origin: BrunoOrigin;
}): BrunoEntity {
  const { name, title, url, partOf, owner, origin } = input;
  const location = `url:${url}`;

  return {
    apiVersion: BRUNO_API_VERSION,
    kind: 'Bruno',
    metadata: {
      name,
      // Emitted BEFORE the tags and annotations, and present or absent rather
      // than present-and-empty, so that a row with no title produces an entity
      // byte-identical to the one it produced before this column existed —
      // which is what keeps `resultHash` stable across the upgrade instead of
      // rewriting every UI-created entity once.
      ...(title && { title }),
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
