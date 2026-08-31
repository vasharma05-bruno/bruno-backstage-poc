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
       * the entity is annotated `bruno.dev/definition-omitted: size`.
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
