/**
 * Autodiscovery of Bruno collections in GitHub — the third source of
 * `kind: Bruno` entities, alongside `bruno.collections[]` and the collections
 * added from the Bruno UI.
 *
 * WHY THIS IS NOT BACKSTAGE'S OWN AUTODISCOVERY. `GithubEntityProvider` will
 * happily find any filename, `catalogPath` accepting a glob — but what it emits
 * is a `kind: Location` entity of `type: url` pointing AT the file, and the
 * catalog then reads that file with the entity-descriptor parser. A
 * `bruno.json` has no `apiVersion`/`kind`, so every hit would land as a
 * processing error instead of an entity. The seams that could bend that are
 * both wrong for a plugin: `CatalogProcessor.readLocation` keys on the location
 * TYPE, which that provider hardcodes to `url`, and
 * `catalogModelExtensionPoint.setEntityDataParser` is a single global singleton
 * that would put this plugin in charge of parsing every descriptor in the
 * catalog. Emitting the entities directly costs one sweep and owns nothing else.
 *
 * WHAT A SWEEP COSTS. One repository listing per entry per tick, plus one
 * recursive tree call for each repository whose `pushed_at` moved since the
 * last sweep. That second clause is what makes a 60-second schedule viable: in
 * a steady state an organization of any size costs its listing alone (a few
 * calls of the 5000/hour REST budget), and only a repository somebody actually
 * pushed to is re-read. GitHub's code-search API would replace the per-repo
 * calls with one query, but it is authenticated-only, indexes the default
 * branch late, misses large repositories and allows 30 requests a minute — a
 * discovery source that silently lags behind source control is worse than one
 * that costs a tree call.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations
} from '@backstage/integration';
import { createScmProviderRegistry } from '../scm';
import type { BrunoDiscoveryConfig } from '../types';
import {
  catalogInfoCandidates,
  collectionRootsFromPaths,
  declaresBrunoKind,
  discoveredCollectionName
} from './collectionRoots';
import { createOctokitDiscoveryClient } from './githubClient';
import type {
  CollectionDiscovery,
  DiscoveredCollection,
  DiscoveryRepo,
  GithubDiscoveryClient
} from './types';

/** What a completed repository sweep is remembered by. */
type RepoCacheEntry = {
  /** The repo's `pushed_at` when this was swept. */
  pushedAt: string;
  /** The ref that was swept, so a default-branch rename re-sweeps. */
  ref: string;
  collections: DiscoveredCollection[];
};

export function createGithubCollectionDiscovery(options: {
  config: Config;
  logger: LoggerService;
  entries: BrunoDiscoveryConfig[];
  /** Injectable for tests; defaults to the Octokit-backed client. */
  client?: GithubDiscoveryClient;
}): CollectionDiscovery {
  const { config, logger, entries } = options;

  // Built here rather than injected, mirroring `createManifestProbe`: both take
  // `config` and derive their own registry from it, so neither depends on the
  // module's wiring order.
  const integrations = ScmIntegrations.fromConfig(config);
  const githubCredentials
    = DefaultGithubCredentialsProvider.fromIntegrations(integrations);
  const providers = createScmProviderRegistry({
    integrations,
    githubCredentials
  });
  const client
    = options.client
      ?? createOctokitDiscoveryClient({ integrations, githubCredentials });

  /** `entryKey::owner/repo` -> the last completed sweep of that repository. */
  let repoCache = new Map<string, RepoCacheEntry>();
  /**
   * Entries that have completed at least one sweep in THIS process.
   *
   * The only way to tell a repository that is genuinely new from one whose
   * cache this process never had. Without it, a tree call that fails on a
   * repository with no cache entry is unreadable: it might have published
   * nothing (safe to skip) or everything (skipping deletes it).
   */
  const sweptEntries = new Set<string>();

  /**
   * A repository's collections, from its tree.
   *
   * Throws on a read failure. The caller decides what that means — a
   * transient failure must not shrink the emitted set.
   */
  async function sweepRepo(
    entry: BrunoDiscoveryConfig,
    repo: DiscoveryRepo
  ): Promise<DiscoveredCollection[]> {
    const repoUrl = providers.byUrl(repo.htmlUrl).normalizeUrl(repo.htmlUrl);
    const provider = providers.byUrl(repoUrl);

    const { paths, truncated } = await client.listTree({
      host: entry.host,
      owner: repo.owner,
      repo: repo.name,
      ref: repo.defaultBranch
    });
    if (truncated) {
      // Not recoverable by paging — the recursive tree API offers no cursor —
      // so this is a warning about collections that CANNOT be discovered here,
      // and the fix is a `bruno.collections[]` entry naming them directly.
      logger.warn(
        `Bruno discovery: the file listing for ${repo.fullName} was truncated `
        + `by GitHub, so any collection past the truncation point is not `
        + `discovered. Add it as a bruno.collections[] entry instead.`
      );
    }

    const present = new Set(paths);
    const collections: DiscoveredCollection[] = [];
    const excluded
      = entry.excludePathPattern === undefined
        ? undefined
        : new RegExp(`^(?:${entry.excludePathPattern})$`);

    for (const rootPrefix of collectionRootsFromPaths(paths)) {
      // A sweep finds EVERY collection in a repository, test fixtures
      // included — `tests/fixtures/bru` in a client library is a real Bruno
      // collection and there is no way to tell it from a published one by
      // looking. `repositoryPattern` cannot help, since the noise is inside a
      // repository somebody does want swept.
      if (excluded?.test(rootPrefix)) {
        logger.debug(
          `Bruno discovery: ${repo.fullName}/${rootPrefix} matches `
          + `excludePathPattern; skipping it.`
        );
        continue;
      }
      if (
        entry.deferToCatalogInfo
        && (await declaredByDescriptor(entry, repo, rootPrefix, present))
      ) {
        continue;
      }

      let url: string;
      try {
        url = provider.normalizeUrl(
          provider.composeCollectionUrl(
            repoUrl,
            rootPrefix,
            repo.defaultBranch
          )
        );
      } catch (e) {
        // A DETERMINISTIC failure, not a transient one: the only way compose
        // throws is a ref this URL grammar cannot represent (a default branch
        // with a slash in it). Such a collection could never have been emitted
        // on an earlier tick either, so skipping it deletes nothing.
        logger.error(
          `Bruno discovery: cannot build a collection URL for `
          + `${repo.fullName}${rootPrefix ? `/${rootPrefix}` : ''}: `
          + `${String((e as Error)?.message ?? e)}; skipping it.`
        );
        continue;
      }

      collections.push({
        url,
        name: discoveredCollectionName(repo.name, rootPrefix),
        owner: entry.owner,
        repository: repo.fullName
      });
    }

    return collections;
  }

  /**
   * Whether an authored `catalog-info.yaml` already declares this collection.
   *
   * Discovery YIELDS to a descriptor, because the descriptor is the richer
   * source: it can carry `spec.partOf`, an owner and a chosen name, none of
   * which a sweep can infer. Emitting both would put two entities with
   * different names on one collection — and since a sweep cannot see the
   * catalog, it could not even tell which of the two it had created.
   *
   * The cost of yielding is that a repository whose descriptor nobody
   * registered loses its collection. That is why it is a knob
   * (`deferToCatalogInfo`) and why the skip is logged at info with the
   * descriptor's path.
   */
  async function declaredByDescriptor(
    entry: BrunoDiscoveryConfig,
    repo: DiscoveryRepo,
    rootPrefix: string,
    present: Set<string>
  ): Promise<boolean> {
    for (const path of catalogInfoCandidates(rootPrefix, present)) {
      const descriptor = await client.readTextFile({
        host: entry.host,
        owner: repo.owner,
        repo: repo.name,
        ref: repo.defaultBranch,
        path
      });
      if (descriptor !== undefined && declaresBrunoKind(descriptor)) {
        logger.info(
          `Bruno discovery: ${repo.fullName}${
            rootPrefix ? `/${rootPrefix}` : ''
          } is already declared by ${path}; leaving it to that descriptor. `
          + `Set deferToCatalogInfo: false on the bruno.discovery entry to `
          + `discover it anyway.`
        );
        return true;
      }
    }
    return false;
  }

  return {
    async discover(): Promise<DiscoveredCollection[]> {
      const nextCache = new Map<string, RepoCacheEntry>();
      const discovered: DiscoveredCollection[] = [];

      for (const entry of entries) {
        const key = entryKey(entry);
        // Not guarded: a listing failure means the whole entry is unknown, and
        // `CollectionDiscovery.discover` is specified to throw rather than
        // return a set the provider would apply as deletions.
        const repos = await client.listRepositories({
          host: entry.host,
          organization: entry.organization
        });

        const pattern
          = entry.repositoryPattern === undefined
            ? undefined
            // Anchored, so `payments` matches the repository `payments` and not
            // `payments-legacy`. Compiled already once by `readBrunoDiscovery`,
            // which is what guarantees this cannot throw.
            : new RegExp(`^(?:${entry.repositoryPattern})$`);

        let matched = 0;
        let reused = 0;
        let found = 0;

        for (const repo of repos) {
          if (pattern && !pattern.test(repo.name)) {
            continue;
          }
          if (repo.archived) {
            logger.debug(
              `Bruno discovery: skipping archived repository ${repo.fullName}.`
            );
            continue;
          }
          if (repo.empty) {
            logger.debug(
              `Bruno discovery: skipping empty repository ${repo.fullName}.`
            );
            continue;
          }
          matched += 1;

          const cacheKey = `${key}::${repo.fullName}`;
          const cached = repoCache.get(cacheKey);
          // An empty `pushedAt` is not a change token, so it never counts as a
          // hit — better a redundant tree call than a stale set of roots.
          if (
            cached
            && repo.pushedAt !== ''
            && cached.pushedAt === repo.pushedAt
            && cached.ref === repo.defaultBranch
          ) {
            nextCache.set(cacheKey, cached);
            discovered.push(...cached.collections);
            found += cached.collections.length;
            reused += 1;
            continue;
          }

          let collections: DiscoveredCollection[];
          try {
            collections = await sweepRepo(entry, repo);
          } catch (e) {
            const message = String((e as Error)?.message ?? e);
            if (cached) {
              logger.warn(
                `Bruno discovery: could not re-read ${repo.fullName}: `
                + `${message}; keeping the collections found there last time.`
              );
              nextCache.set(cacheKey, cached);
              discovered.push(...cached.collections);
              found += cached.collections.length;
              continue;
            }
            if (sweptEntries.has(key)) {
              // This entry has been swept before and had nothing cached for
              // this repository, so the repository is new to the sweep and has
              // published nothing. Skipping it deletes nothing.
              logger.warn(
                `Bruno discovery: could not read ${repo.fullName}: ${message}; `
                + `it has never been swept successfully, so it is skipped `
                + `until the next tick.`
              );
              continue;
            }
            // First sweep of this entry in this process: there is no way to
            // know what this repository had published, and guessing "nothing"
            // would delete it. Fail the sweep instead — the provider answers a
            // throw by skipping the tick and changing nothing.
            throw new Error(
              `Bruno discovery: could not read ${repo.fullName} on the first `
              + `sweep of ${entry.organization}, so the collections it `
              + `publishes are unknown: ${message}`
            );
          }

          nextCache.set(cacheKey, {
            pushedAt: repo.pushedAt,
            ref: repo.defaultBranch,
            collections
          });
          discovered.push(...collections);
          found += collections.length;
        }

        sweptEntries.add(key);
        logger.info(
          `Bruno discovery: ${entry.organization} on ${entry.host} — `
          + `${matched} repository(ies) swept (${reused} unchanged since the `
          + `last sweep), ${found} collection(s) found.`
        );
      }

      // Swapped only on a fully successful sweep, which is also what prunes
      // repositories that were renamed, archived, deleted or filtered out.
      repoCache = nextCache;
      return discovered;
    }
  };
}

/**
 * Cache identity for a discovery entry: every field that can change what a
 * repository sweep YIELDS, so an edited `owner:` or `deferToCatalogInfo:` is
 * not served from a cache built under the old value.
 */
function entryKey(entry: BrunoDiscoveryConfig): string {
  return JSON.stringify([
    entry.host,
    entry.organization,
    entry.repositoryPattern ?? null,
    entry.excludePathPattern ?? null,
    entry.owner ?? null,
    entry.deferToCatalogInfo
  ]);
}
