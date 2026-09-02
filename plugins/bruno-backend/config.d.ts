export interface Config {
  /**
   * Configuration for the Bruno-for-Backstage backend plugin.
   * @visibility backend
   */
  bruno?: {
    /**
     * Bruno collections to materialize as `kind: Bruno` entities, without a
     * catalog-info.yaml. Ingested through the same path as an authored
     * entity: fetch the folder, require a bruno.json or
     * opencollection.yml/.yaml, then enrich name/version/description.
     * @visibility backend
     */
    collections?: Array<{
      /** The source type. Only `url` is supported. @visibility backend */
      type: 'url';
      /**
       * Git URL of the Bruno collection FOLDER (a tree or blob URL on a host
       * configured under `integrations`).
       * @visibility backend
       */
      url: string;
      /**
       * Entity reference(s) to the API entities this collection is part of.
       * A bare string is accepted and treated as a single-element list.
       * @visibility backend
       */
      partOf?: string | string[];
      /**
       * Entity reference to the owner of the collection. Unprefixed values
       * default to a Group, matching the authored `spec.owner`. Without it a
       * config-created collection has no `ownedBy` relation and reads as
       * unowned in the catalog.
       * @visibility backend
       */
      owner?: string;
      /**
       * Optional entity-name override. The default name is derived from the
       * last path segment of `url`; set this when two configured collections
       * would otherwise collide, or to pin a name against a URL change.
       * NOT part of the PRD's config shape — a documented superset.
       * @visibility backend
       */
      name?: string;
    }>;
    /**
     * Organizations (or user accounts) swept for Bruno collections, so a
     * collection is catalogued by being pushed rather than by being declared.
     *
     * Each `bruno.json` / `opencollection.yml`/`.yaml` found becomes a
     * `kind: Bruno` entity, through the same probe as every other source.
     * GitHub only for now.
     *
     * NOT Backstage's `catalog.providers.github` autodiscovery, and not
     * expressible in terms of it: that provider emits a `kind: Location` of
     * `type: url` pointing at whatever the glob matched, which the catalog then
     * parses as an entity descriptor — a Bruno manifest is not one, so every
     * hit would land as a processing error. See
     * `src/discovery/githubDiscovery.ts`.
     * @visibility backend
     */
    discovery?: Array<{
      /**
       * SCM host to sweep. Must have an `integrations.github` entry unless it
       * is public github.com, which self-defaults one. Default `github.com`.
       * @visibility backend
       */
      host?: string;
      /**
       * GitHub organization to sweep. A USER login is also accepted — the
       * sweep falls back to the user endpoint when the organization endpoint
       * 404s, which is what makes a personal account discoverable.
       *
       * Only repositories the host credential can LIST are swept, so a private
       * repository needs `integrations.github` configured with access to it.
       * @visibility backend
       */
      organization: string;
      /**
       * Anchored regular expression over the repository NAME. `payments`
       * matches the repository `payments` and not `payments-legacy`; use
       * `payments.*` for that. Default: every repository listed.
       * @visibility backend
       */
      repositoryPattern?: string;
      /**
       * Anchored regular expression over a discovered collection's
       * repo-relative path — `''` for one at the repository root. A path that
       * matches is not discovered.
       *
       * A sweep finds every collection in a repository, test fixtures
       * included: `tests/fixtures/bru` in a client library is a real Bruno
       * collection and nothing about it says otherwise.
       * `repositoryPattern` cannot exclude those, because the noise is inside
       * a repository that does belong in the sweep. Example:
       * `(tests|examples|fixtures)/.*`.
       * @visibility backend
       */
      excludePathPattern?: string;
      /**
       * Entity reference stamped as `spec.owner` on every collection found by
       * this entry. Nothing in a repository states who owns a collection, so
       * without this a discovered collection reads as unowned in the catalog.
       * @visibility backend
       */
      owner?: string;
      /**
       * Whether to leave a collection already declared by an authored
       * `catalog-info.yaml` to that descriptor. Default true.
       *
       * A descriptor can carry `spec.partOf`, an owner and a chosen name, none
       * of which a sweep can infer, so publishing both would put two
       * differently-named entities on one collection. The check looks for a
       * `kind: Bruno` document in `catalog-info.yaml`/`.yml` at the
       * collection's own directory and at the repository root — a descriptor
       * somewhere else is not seen, and that collection is then both authored
       * and discovered.
       *
       * The cost of the default is a repository whose descriptor nobody
       * registered with Backstage: its collection is skipped here and never
       * appears. Set this to false to discover it anyway — the skip is logged
       * at info with the descriptor's path.
       * @visibility backend
       */
      deferToCatalogInfo?: boolean;
    }>;
    /**
     * How long a fetched collection stays cached before the probe revalidates
     * it. Revalidation is an ETag check — one metadata API call, not a tree
     * download — so a short value is cheap. This is also the upper bound on
     * how long a Sync (catalog entity refresh) takes to show new content.
     * Default 60.
     * @visibility backend
     */
    cacheTtlSeconds?: number;
    /**
     * Controls the OpenCollection YAML stored on each `kind: Bruno` entity.
     * @visibility backend
     */
    definition?: {
      /**
       * Hard cap on the stored YAML, in bytes. Over the cap the definition is
       * OMITTED (never truncated — a truncated document is invalid YAML) and
       * the entity is annotated `usebruno.com/definition-omitted: size`.
       * Default 1048576.
       * @visibility backend
       */
      maxBytes?: number;
    };
    /**
     * Optional provider refresh schedule.
     * @visibility backend
     */
    schedule?: {
      /**
       * How often the entity provider re-reads sources, in seconds.
       * @visibility backend
       */
      frequencySeconds?: number;
      /**
       * Per-run timeout, in seconds.
       * @visibility backend
       */
      timeoutSeconds?: number;
    };
  };
}
